# LLM Conversation Script Example
# This script receives JSON input via stdin and outputs JSON to stdout.
# It can be used to preprocess user input, postprocess LLM output, or control conversation flow.

import sys
import json
import os
import traceback

try:
    sys.path.append(os.path.join(os.path.dirname(__file__), 'prior scripts'))
    from llm_interface import get_llm_response_from_context
except Exception as import_err:
    print(json.dumps({'error': f'Import error: {import_err}', 'traceback': traceback.format_exc()}))
    sys.exit(1)

# Use the shared fact extractor so tests exercise the real code path
try:
    from fact_extractor import extract_facts  # type: ignore
except Exception:
    extract_facts = None  # type: ignore

def main():
    try:
        data = json.loads(sys.stdin.read())
        prompt = data.get('prompt', '')
        conversation = data.get('conversation', [])
        llm = data.get('llm', 'gpt-3.5-turbo')
        prev_prd_draft = data.get('prdDraft', '')
        structure = data.get('structure', {})
        # Default to False for safety: only draft when the server explicitly asks
        should_draft = bool(data.get('shouldDraft', False))
        temps = data.get('temps', {})
        reply_temp = float(temps.get('reply', 0.7))
        draft_temp = float(temps.get('draft', 0.2))
        # Compose messages for LLM: use provided conversation as-is
        # (Node already appended the user's latest message and prepended a system prompt.)
        messages = conversation

        # --- Add error checks for debugging ---
        if not prev_prd_draft:
            print('[ERROR] prev_prd_draft is empty!', file=sys.stderr)
        if not messages:
            print('[ERROR] messages (conversation history) is empty!', file=sys.stderr)
        # Optionally, print the actual values for further debugging
        # print('prev_prd_draft:', prev_prd_draft, file=sys.stderr)
        # print('messages:', json.dumps(messages, ensure_ascii=False), file=sys.stderr)

        reply = get_llm_response_from_context(messages, llm, temperature=reply_temp)

        # --- Fact extraction step (strict JSON) ---
        # Use shared extractor (mirrors production prompt/repair) for a single source of truth
        facts_json = {"facts": []}
        try:
            if extract_facts is not None:
                # Allow a dedicated model for extraction only
                facts_model = os.getenv("OPENAI_FACTS_MODEL") or os.getenv("FACTS_MODEL") or llm
                # Use low temperature and a slightly larger token budget to avoid truncation
                facts = extract_facts(prompt=prompt, structure=structure, llm=facts_model, temperature=0.0, max_tokens=800)
                if isinstance(facts, list):
                    facts_json = {"facts": facts}
            else:
                facts_json = {"facts": []}
        except Exception:
            facts_json = {"facts": []}
        # Optional debug: print facts count without contaminating stdout JSON
        try:
            if os.getenv("FACTS_DEBUG") or os.getenv("LLM_DEBUG"):
                count = len(facts_json.get('facts', [])) if isinstance(facts_json.get('facts'), list) else 0
                facts_model = os.getenv("OPENAI_FACTS_MODEL") or os.getenv("FACTS_MODEL") or llm
                print(f"[FACTS_DEBUG] facts_model: {facts_model}", file=sys.stderr)
                print(f"[FACTS_DEBUG] facts_count: {count}", file=sys.stderr)
        except Exception:
            pass

        # --- Planner step (decide action + extract facts + optional summary) ---
        plan_system = {
            "role": "system",
            "content": (
                "You are a planning assistant that decides whether a user turn should update a PRD. "
                "Output STRICT JSON with keys: action (update_prd|gather|summarize|confirm_gate|examples|standards|none), "
                "confidence (0..1), targets (array of {sectionIndex, fieldIndex}), facts (array of short strings), summary (string; optional). "
                "Do not include any commentary outside JSON."
            )
        }
        nf = structure.get('nextFocus', {}) or {}
        plan_user = {
            "role": "user",
            "content": (
                f"Latest user input: {prompt}\n" +
                f"Agenda: {json.dumps(structure.get('agenda', []), ensure_ascii=False)}\n" +
                f"Cursor: {json.dumps(structure.get('cursor', {}), ensure_ascii=False)} NextFocus: {json.dumps(nf, ensure_ascii=False)}\n" +
                "Decide minimal action; extract concrete facts relevant to the next focus; include a concise summary if action is summarize or confirm_gate."
            )
        }
        planner_raw = get_llm_response_from_context(
            [plan_system, plan_user],
            llm,
            temperature=0.1,
            response_format={"type": "json_object"},
            max_tokens=300,
        )
        planner = {}
        try:
            planner = json.loads(planner_raw)
        except Exception:
            planner = {"action": "gather", "confidence": 0.5, "targets": [ {"sectionIndex": nf.get('sectionIndex', 0), "fieldIndex": nf.get('fieldIndex', 0)} ], "facts": []}

        # Ask LLM to update the PRD draft (only if should_draft)
        # Integrate structure guidance (agenda, next focus, focus stack) into PRD drafting
        agenda = structure.get('agenda', [])
        nextFocus = structure.get('nextFocus', {})
        cursor = structure.get('cursor', {})
        focusStack = structure.get('focusStack', [])
        structure_lines = []
        if agenda:
            agenda_str = " | ".join([f"{s.get('name','')} [{', '.join(s.get('fields', []))}]" for s in agenda])
            structure_lines.append(f"Agenda: {agenda_str}")
        if nextFocus:
            nf_sec = nextFocus.get('sectionIndex', 0)
            nf_field = nextFocus.get('fieldIndex', 0)
            structure_lines.append(f"Next focus index: section={nf_sec}, field={nf_field}. Prioritize missing/weak fields.")
        if focusStack:
            top = focusStack[-1]
            structure_lines.append(f"Active focus: {top.get('type')} on {top.get('topic')} (turnsLeft={top.get('turnsLeft')}). After focus, return to agenda.")

        prd_prompt = (
            "Given the following conversation and the latest user input, generate an updated Product Requirements Document (PRD) draft in markdown format. "
            "Use the agenda to maintain stable section headings and fill missing/weak fields first (especially the next focus). "
            "If no changes are needed, return the previous PRD draft as-is.\n\n"
            + ("\n".join(structure_lines) + "\n\n" if structure_lines else "") +
            f"Previous PRD draft (markdown):\n{prev_prd_draft}\n\n"
            f"Conversation history (for context):\n{json.dumps(messages, ensure_ascii=False)}\n\n"
            "Respond ONLY with the full markdown PRD draft."
        )
        prd_draft = None
        if should_draft:
            prd_draft = get_llm_response_from_context([
                {"role": "system", "content": "You are an expert product manager and technical writer."},
                {"role": "user", "content": prd_prompt}
            ], llm, temperature=draft_temp)

        print(json.dumps({"reply": reply, "prdDraft": prd_draft, "planner": planner, "facts": facts_json.get('facts', [])}))
    except Exception as e:
        print(json.dumps({"error": str(e), "traceback": traceback.format_exc()}))

if __name__ == '__main__':
    main()
