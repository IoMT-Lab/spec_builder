"""
LLM helper that proposes an instruction prompt for test generation given a PRD
and repository manifest. Accepts JSON on stdin:
{
  "prd": "...markdown...",
  "files": [{"path": "src/foo.c", "size": 1234}, ...],
  "llm": "gpt-4o"
}
Outputs STRICT JSON:
{ "prompt": "..." }
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


def extract_json(text: str) -> str:
    if not isinstance(text, str):
        return "{}"
    fence = re.search(r"```(?:json)?\s*([\s\S]+?)```", text, re.IGNORECASE)
    if fence:
        return fence.group(1).strip()
    return text.strip()


def main():
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        prd = payload.get('prd', '')
        files = payload.get('files', []) or []
        llm = payload.get('llm') or os.getenv('OPENAI_MODEL') or 'gpt-4o'
        vector_store_id = payload.get('vectorStoreId')

        manifest_lines = []
        for f in files:
            path = str(f.get('path', '')).strip()
            if not path:
                continue
            size = f.get('size')
            if isinstance(size, int) and size >= 0:
                manifest_lines.append(f"{path} ({size} bytes)")
            else:
                manifest_lines.append(path)

        system_msg = {
            'role': 'system',
            'content': (
                'You are an expert test engineer crafting prompts for code generation models. '
                'Given a PRD and repository manifest, produce a concise instruction prompt that will drive the model to generate '
                'comprehensive, high-quality tests covering the specified behaviors, edge cases, and assurance requirements. '
                'Summarize key expectations, interfaces, and negative scenarios explicitly. '
                'Respond in STRICT JSON: {"prompt": "..."}. '
                'Keep the prompt under 600 characters, but include all critical guidance.'
            )
        }
        user_msg = {
            'role': 'user',
            'content': (
                'Product Requirements (markdown):\n'
                f'{prd}\n\n'
                'Repository manifest:\n'
                + '\n'.join(manifest_lines)
            )
        }

        tools = None
        tool_resources = None
        if vector_store_id:
            tools = [{'type': 'file_search'}]
            tool_resources = {'file_search': {'vector_store_ids': [vector_store_id]}}

        raw = get_llm_response_from_context(
            [system_msg, user_msg],
            llm,
            temperature=0,
            tool_resources=tool_resources,
            tools=tools
        )
        if os.getenv('SELECT_PROMPT_DEBUG'):
            print(json.dumps({'raw': raw}), file=sys.stderr)
        json_payload = extract_json(raw)
        try:
            result = json.loads(json_payload)
        except Exception:
            result = {"prompt": ""}
        prompt = result.get('prompt')
        if not isinstance(prompt, str):
            prompt = ''
        prompt = prompt.strip()
        print(json.dumps({'prompt': prompt}))
    except Exception as err:
        print(json.dumps({'error': str(err), 'traceback': traceback.format_exc()}))


if __name__ == '__main__':
    main()
