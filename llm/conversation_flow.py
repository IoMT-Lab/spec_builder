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

def main():
    try:
        data = json.loads(sys.stdin.read())
        prompt = data.get('prompt', '')
        conversation = data.get('conversation', [])
        llm = data.get('llm', 'gpt-3.5-turbo')
        prev_prd_draft = data.get('prdDraft', '')
        # Compose messages for LLM: conversation history + new prompt
        messages = conversation + ([{"role": "user", "content": prompt}] if prompt else [])

        # --- Add error checks for debugging ---
        if not prev_prd_draft:
            print('[ERROR] prev_prd_draft is empty!', file=sys.stderr)
        if not messages:
            print('[ERROR] messages (conversation history) is empty!', file=sys.stderr)
        # Optionally, print the actual values for further debugging
        # print('prev_prd_draft:', prev_prd_draft, file=sys.stderr)
        # print('messages:', json.dumps(messages, ensure_ascii=False), file=sys.stderr)

        reply = get_llm_response_from_context(messages, llm)

        # Ask LLM to update the PRD draft
        prd_prompt = (
            "Given the following conversation and the latest user input, generate an updated Product Requirements Document (PRD) draft in markdown format. "
            "If no changes are needed, return the previous PRD draft as-is.\n\n"
            f"Previous PRD draft (markdown):\n{prev_prd_draft}\n\n"
            f"Conversation history (for context):\n{json.dumps(messages, ensure_ascii=False)}\n\n"
            "Respond ONLY with the full markdown PRD draft."
        )
        prd_draft = get_llm_response_from_context([
            {"role": "system", "content": "You are an expert product manager and technical writer."},
            {"role": "user", "content": prd_prompt}
        ], llm)

        print(json.dumps({"reply": reply, "prdDraft": prd_draft}))
    except Exception as e:
        print(json.dumps({"error": str(e), "traceback": traceback.format_exc()}))

if __name__ == '__main__':
    main()
