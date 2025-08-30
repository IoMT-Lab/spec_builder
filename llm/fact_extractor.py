"""
Standalone fact extraction helper used by the app's Python LLM layer.

It mirrors the extraction logic in llm/conversation_flow.py so you can:
- import extract_facts(...) in other code/tests, or
- run the companion CLI (test_fact_extractor.py) to exercise extraction.
"""

import json
import os
import sys
from typing import Any, Dict, List, Optional
import re

# Make the "prior scripts" helpers importable. For unit tests (offline), we allow
# this import to fail and expect tests to monkeypatch get_llm_response_from_context.
sys.path.append(os.path.join(os.path.dirname(__file__), 'prior scripts'))
try:  # pragma: no cover - exercised by integration runs
    from llm_interface import get_llm_response_from_context  # type: ignore
except Exception:  # No OPENAI_API_KEY or package missing
    def get_llm_response_from_context(*args, **kwargs):  # type: ignore
        raise RuntimeError(
            "llm_interface unavailable. In unit tests, monkeypatch "
            "fact_extractor.get_llm_response_from_context."
        )


def _build_extractor_messages(prompt: str, structure: Optional[Dict[str, Any]] = None) -> List[Dict[str, str]]:
    structure = structure or {}
    cursor = structure.get('cursor', {})
    next_focus = structure.get('nextFocus', {})
    extract_system = {
        "role": "system",
        "content": (
            "You extract atomic, verifiable facts from the user's latest input relevant to a PRD. "
            "Return STRICT JSON with a single key 'facts' whose value is an array (max 12 items) of objects with keys: "
            "text (<=140 chars), exact_span, sectionHint, fieldHint, attributes (only if needed: {type,value,unit,comparator}), confidence (0..1). "
            "Respond with a SINGLE JSON object only — no prose, no code fences, no comments."
        ),
    }
    extract_user = {
        "role": "user",
        "content": (
            f"Latest user input: {prompt}\n"
            f"Cursor: {json.dumps(cursor, ensure_ascii=False)} "
            f"NextFocus: {json.dumps(next_focus, ensure_ascii=False)}"
        ),
    }
    return [extract_system, extract_user]


_FENCE_RE = re.compile(r"```(?:json)?\s*([\s\S]*?)```", re.IGNORECASE)

def _strip_fences(s: str) -> str:
    """Remove ```json ... ``` fences if present; otherwise return original string."""
    if not isinstance(s, str):
        return s
    m = _FENCE_RE.search(s)
    return m.group(1).strip() if m else s

def _extract_json_payload(s: str) -> str:
    """Best-effort: strip fences, then slice from first '{' to last '}' if present."""
    s2 = _strip_fences(s)
    try:
        start = s2.index('{')
        end = s2.rindex('}') + 1
        return s2[start:end]
    except ValueError:
        return s2


def extract_facts(
    *,
    prompt: str,
    structure: Optional[Dict[str, Any]] = None,
    llm: str = "gpt-4o",
    temperature: float = 0.1,
    max_tokens: int = 400,
) -> List[Dict[str, Any]]:
    """Extract structured facts from a user input string.

    Returns a list of dicts with keys (at minimum): text, exact_span, sectionHint, fieldHint, attributes, confidence.

    This calls the OpenAI Responses API via llm_interface. For offline tests, monkeypatch
    fact_extractor.get_llm_response_from_context to return a JSON string.
    """
    messages = _build_extractor_messages(prompt, structure)
    DEBUG = bool(os.getenv("FACTS_DEBUG") or os.getenv("LLM_DEBUG"))
    def _dbg(tag: str, payload: str) -> None:
        if DEBUG:
            try:
                # Write to stderr so we don't contaminate JSON stdout in other scripts
                print(f"[FACTS_DEBUG] {tag}: {payload}", file=sys.stderr)
            except Exception:
                pass
    # First pass: request strict JSON
    raw = get_llm_response_from_context(
        messages,
        llm,
        temperature=temperature,
        response_format={"type": "json_object"},
        max_tokens=max_tokens,
    )
    _dbg("facts_raw", (raw if isinstance(raw, str) else str(raw))[:4000])
    facts: List[Dict[str, Any]] = []
    try:
        parsed = json.loads(_extract_json_payload(raw))
        if isinstance(parsed, dict) and isinstance(parsed.get("facts", []), list):
            facts = parsed["facts"]
            _dbg("facts_parsed_count", str(len(facts)))
            return facts
    except Exception:
        pass

    # Repair attempt: ask the model to return valid JSON only
    repair_system = {"role": "system", "content": (
        "Return ONLY valid JSON for the extraction request as {\"facts\":[...]}. "
        "No commentary, no code fences."
    )}
    repaired = get_llm_response_from_context(
        messages + [repair_system],
        llm,
        temperature=0.0,
        response_format={"type": "json_object"},
        max_tokens=max_tokens,
    )
    _dbg("facts_repaired_raw", (repaired if isinstance(repaired, str) else str(repaired))[:4000])
    try:
        parsed2 = json.loads(_extract_json_payload(repaired))
        if isinstance(parsed2, dict) and isinstance(parsed2.get("facts", []), list):
            facts = parsed2["facts"]
            _dbg("facts_repaired_count", str(len(facts)))
    except Exception:
        facts = []
    if DEBUG:
        _dbg("facts_final_count", str(len(facts)))
    return facts


def _demo():
    import argparse

    ap = argparse.ArgumentParser(description="Extract PRD facts from a user input string.")
    ap.add_argument("--input", required=False, default="Users can sign in with Google; first response under 200ms.", help="User input text")
    ap.add_argument("--model", required=False, default=os.getenv("OPENAI_MODEL", "gpt-4o-mini"), help="Model ID")
    ap.add_argument("--sectionIndex", type=int, default=0)
    ap.add_argument("--fieldIndex", type=int, default=0)
    args = ap.parse_args()

    structure = {
        "cursor": {"sectionIndex": args.sectionIndex, "fieldIndex": args.fieldIndex},
        "nextFocus": {"sectionIndex": args.sectionIndex, "fieldIndex": args.fieldIndex},
    }
    facts = extract_facts(prompt=args.input, structure=structure, llm=args.model)
    print(json.dumps({"facts": facts}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    _demo()
