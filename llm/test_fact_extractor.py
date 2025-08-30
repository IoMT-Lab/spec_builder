"""
CLI harness to test fact extraction in isolation.

Usage examples:
  python3 llm/test_fact_extractor.py --input "Login must support Google and SSO" --model gpt-4o-mini
  OPENAI_API_KEY=... python3 llm/test_fact_extractor.py

Note: This script calls the OpenAI Responses API via llm_interface. For offline/unit tests,
use the unittest in llm/tests which mocks the network call.
"""

import json
import os
import sys
import argparse

# Allow local imports when invoked from repo root
CUR_DIR = os.path.dirname(__file__)
if CUR_DIR not in sys.path:
    sys.path.append(CUR_DIR)

from fact_extractor import extract_facts  # type: ignore


def main():
    ap = argparse.ArgumentParser(description="Test PRD fact extraction via OpenAI")
    ap.add_argument("--input", default="Users can sign in with Google; first response under 200ms.")
    ap.add_argument("--model", default=os.getenv("OPENAI_MODEL", "gpt-4o-mini"))
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
    main()

