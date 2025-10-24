#!/usr/bin/env python3
"""
Quick harness to exercise a combined reply+planner+facts prompt offline.

Usage:
    python llm/experiments/test_combined_prompt.py               # run all fixtures
    python llm/experiments/test_combined_prompt.py --file fixtures/photo_detector_turn.json
    python llm/experiments/test_combined_prompt.py --max-tokens 1500
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Iterable, Optional

HERE = Path(__file__).resolve().parent
FIXTURES_DIR = HERE / "fixtures"

sys.path.append(str(HERE.parent / "prior scripts"))
from llm_interface import get_llm_response_from_context  # type: ignore


JSON_INSTRUCTION = (
    "Respond with STRICT JSON containing keys: "
    "\"reply\" (string, 2-5 sentence assistant answer), "
    "\"planner\" (object with keys action (update_prd|gather|summarize|confirm_gate|examples|standards|none), "
    "confidence (0..1), targets (array of {sectionIndex:int, fieldIndex:int}), facts (array of short strings), summary (string optional)), "
    "\"facts\" (array of fact objects; each fact needs text<=140 chars and exact_span fields; include sectionHint/fieldHint if known). "
    "No additional keys, no markdown, no code fences. If you cannot supply data for planner.targets, use the supplied nextFocus indices."
)


def load_fixtures(paths: Iterable[Path]) -> Iterable[Path]:
    for path in paths:
        if path.is_file() and path.suffix == ".json":
            yield path
        elif path.is_dir():
            yield from sorted(p for p in path.rglob("*.json"))


def run_fixture(path: Path, *, model: Optional[str], max_tokens: Optional[int], temperature: Optional[float]) -> None:
    data = json.loads(path.read_text())
    llm = model or data.get("llm") or os.getenv("OPENAI_MODEL") or "gpt-4o"
    max_tok = max_tokens or int(data.get("max_tokens", 900))
    reply_temp = float(temperature if temperature is not None else data.get("reply_temperature", 0.6))

    conversation = data.get("conversation") or []
    if conversation:
        messages = list(conversation[:-1]) + [
            {"role": "system", "content": JSON_INSTRUCTION},
            conversation[-1],
        ]
    else:
        messages = [{"role": "system", "content": JSON_INSTRUCTION}]

    print(f"\n=== Fixture: {path.name} ===")
    print(f"Model: {llm} | max_tokens: {max_tok} | reply_temp: {reply_temp}")
    start = time.time()
    try:
        raw = get_llm_response_from_context(
            messages,
            llm,
            temperature=reply_temp,
            response_format={"type": "json_object"},
            max_tokens=max_tok,
        )
    except Exception as exc:  # pragma: no cover - diagnostic mode
        elapsed = time.time() - start
        print(f"LLM call failed after {elapsed:.2f}s: {exc}")
        return
    elapsed = time.time() - start
    print(f"Call duration: {elapsed:.2f}s")

    try:
        parsed = json.loads(raw)
    except Exception as exc:
        print(f"[PARSE ERROR] {exc}")
        print(f"Raw output snippet:\n{str(raw)[:800]}")
        return

    reply = str(parsed.get("reply", "") or "")
    planner = parsed.get("planner", {})
    facts = parsed.get("facts", [])
    print(f"Reply preview: {reply[:200].strip()}{'…' if len(reply) > 200 else ''}")
    print("Planner:", json.dumps(planner, ensure_ascii=False, indent=2))
    print(f"Facts count: {len(facts)}")


def main() -> None:
    ap = argparse.ArgumentParser(description="Test combined reply+planner+facts prompt against recorded fixtures.")
    ap.add_argument("--file", action="append", type=Path, help="Fixture file to run (can be repeated).")
    ap.add_argument("--max-tokens", type=int, help="Override max_tokens for the call.")
    ap.add_argument("--model", type=str, help="Override model id.")
    ap.add_argument("--temperature", type=float, help="Override reply temperature.")
    args = ap.parse_args()

    if args.file:
        fixture_paths = [path if path.is_absolute() else (FIXTURES_DIR / path) for path in args.file]
    else:
        fixture_paths = [FIXTURES_DIR]

    any_run = False
    for fixture in load_fixtures(fixture_paths):
        any_run = True
        run_fixture(
            fixture,
            model=args.model,
            max_tokens=args.max_tokens,
            temperature=args.temperature,
        )

    if not any_run:
        print("No fixtures found.", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
