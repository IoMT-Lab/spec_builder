"""
LLM helper that selects which repository files should be fed into the code-generation
prompt. Accepts JSON on stdin:
{
  "prd": "...",
  "files": [{"path": "src/foo.c", "size": 1234}, ...],
  "limit": 12
}

Outputs STRICT JSON:
{ "files": ["src/foo.c", "tests/foo_test.c", ...] }
"""

import json
import os
import re
import sys
import traceback

try:
    sys.path.append(os.path.join(os.path.dirname(__file__), 'prior scripts'))
    from llm_interface import get_llm_response_from_context
except Exception as import_err:
    print(json.dumps({'error': f'Import error: {import_err}', 'traceback': traceback.format_exc()}))
    sys.exit(1)


def main():
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        prd = payload.get("prd", "")
        files = payload.get("files", []) or []
        limit = int(payload.get("limit", 10) or 10)
        limit = max(1, min(limit, 20))

        manifest_lines = []
        for f in files:
            path = str(f.get("path", "")).strip()
            if not path:
                continue
            size = f.get("size")
            if isinstance(size, int) and size >= 0:
                manifest_lines.append(f"{path} ({size} bytes)")
            else:
                manifest_lines.append(path)

        system_msg = {
            "role": "system",
            "content": (
                "You are a senior test engineer preparing automated tests. "
                "Given a PRD and a repository manifest, you must select the files the LLM should read "
                "in order to generate the tests and assurances described. "
                "Return STRICT JSON with one key: files, mapping to an array of file paths sorted from highest priority to lowest priority. "
                "Prioritize existing test directories, unit-test harnesses, driver code, and any supporting headers. "
                "If a new test file must be created, include the suggested path (e.g. tests/generated_tests.c). "
                f"Return no more than {limit} paths."
            )
        }
        user_msg = {
            "role": "user",
            "content": (
                "Product Requirements:\n"
                f"{prd}\n\n"
                "Repository manifest (path and optional size):\n"
                + "\n".join(manifest_lines)
            )
        }

        model = payload.get("llm") or os.getenv("OPENAI_MODEL") or "gpt-4o"
        raw = get_llm_response_from_context([system_msg, user_msg], model, temperature=0)
        def extract_json(text: str) -> str:
            if not isinstance(text, str):
                return "{}"
            fence = re.search(r"```(?:json)?\s*([\s\S]+?)```", text, re.IGNORECASE)
            if fence:
                return fence.group(1).strip()
            return text.strip()

        json_payload = extract_json(raw)
        try:
            result = json.loads(json_payload)
        except Exception:
            result = {"files": []}

        files_out = result.get("files")
        if not isinstance(files_out, list):
            files_out = []
        cleaned = []
        for item in files_out:
            if not isinstance(item, str):
                continue
            path = item.strip()
            if path:
                cleaned.append(path)
        if len(cleaned) > limit:
            cleaned = cleaned[:limit]
        print(json.dumps({"files": cleaned}))
    except Exception as err:
        print(json.dumps({"error": str(err), "traceback": traceback.format_exc()}))


if __name__ == "__main__":
    main()
