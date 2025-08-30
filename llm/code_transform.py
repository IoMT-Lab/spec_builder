"""
LLM code transform script.

Input on stdin (JSON):
{
  "prd": "...markdown...",
  "extraPrompt": "...",
  "files": [{"path":"src/a.js","content":"..."}, ...],
  "llm": "gpt-4o",
  "limits": {"maxChanges": 50}
}

Output on stdout (STRICT JSON):
{
  "changes": [
    {"path":"src/a.js","action":"modify","new_content":"..."},
    {"path":"src/new.ts","action":"add","new_content":"..."},
    {"path":"obsolete.txt","action":"delete"}
  ],
  "notes": "one-line summary"
}
"""

import json
import os
import sys
import traceback
import re

try:
    sys.path.append(os.path.join(os.path.dirname(__file__), 'prior scripts'))
    from llm_interface import get_llm_response_from_context
except Exception as import_err:
    print(json.dumps({'error': f'Import error: {import_err}', 'traceback': traceback.format_exc()}))
    sys.exit(1)

_FENCE_RE = re.compile(r"```(?:json)?\s*([\s\S]*?)```", re.IGNORECASE)

def _strip_fences(s: str) -> str:
    if not isinstance(s, str):
        return s
    m = _FENCE_RE.search(s)
    return m.group(1).strip() if m else s

def _extract_json_payload(s: str) -> str:
    s2 = _strip_fences(s)
    try:
        start = s2.index('{')
        end = s2.rindex('}') + 1
        return s2[start:end]
    except ValueError:
        return s2

def main():
    try:
        data = json.loads(sys.stdin.read())
        prd = data.get('prd', '')
        extra = data.get('extraPrompt', '')
        files = data.get('files', []) or []
        llm = data.get('llm', 'gpt-4o')
        limits = data.get('limits', {}) or {}
        max_changes = int(limits.get('maxChanges', 50))
        max_tokens = int(limits.get('maxTokens', 4000))
        lang_hint = (data.get('langHint') or '').strip()
        DEBUG = bool(os.getenv('CODE_DEBUG'))

        # Compose a compact context pack to keep tokens reasonable
        manifest_lines = []
        file_blobs = []
        for f in files:
            p = str(f.get('path',''))
            c = f.get('content','')
            if not p:
                continue
            manifest_lines.append(p)
            # Keep each file section bounded
            if isinstance(c, str):
                file_blobs.append(f"\n=== {p} ===\n" + c)

        system = {
            'role': 'system',
            'content': (
                "You modify codebases based on a PRD and an instruction. "
                "Propose exact file changes and output STRICT JSON only: {changes:[{path,action, new_content?}], notes}. "
                "Allowed actions: add|modify|delete. For add/modify include FULL new_content. "
                f"Return no more than {max_changes} changes. Do not include commentary or code fences. "
                + (f"Primary language/framework hint: {lang_hint}. " if lang_hint else "")
                + "If the request is about tests and no tests exist, propose adding tests under a conventional directory (e.g., tests/, __tests__/ for JS, pytest for Python, JUnit for Java)."
            )
        }
        user = {
            'role': 'user',
            'content': (
                "PRD (markdown):\n" + prd + "\n\n" +
                ("Instruction:\n" + extra + "\n\n" if extra else "") +
                "Manifest (relative paths):\n" + "\n".join(manifest_lines[:1000]) + "\n\n" +
                "Files:\n" + "\n".join(file_blobs[:200])
            )
        }

        # First attempt with strict JSON; on parameter validation errors, fall back without response_format
        raw = None
        try:
            raw = get_llm_response_from_context([system, user], llm, temperature=0.1, response_format={'type':'json_object'}, max_tokens=max_tokens)
        except Exception:
            raw = None
        # If the helper returned a diagnostic string about an API error, fall back without response_format
        if raw is None or (isinstance(raw, str) and ('unexpected keyword argument' in raw.lower() or 'an error occurred while calling the openai api' in raw.lower())):
            # Fallback: some client versions reject response_format; retry without it
            raw = get_llm_response_from_context([system, user], llm, temperature=0.1, max_tokens=max_tokens)
        if DEBUG:
            try:
                sys.stderr.write(f"[CODE_DEBUG] files={len(files)} prdChars={len(prd)} extraChars={len(extra)}\n")
                sys.stderr.write(f"[CODE_DEBUG] raw_head={str(raw)[:4000]}\n")
            except Exception:
                pass
        try:
            parsed = json.loads(_extract_json_payload(raw))
        except Exception:
            # Repair
            repair_sys = {'role':'system','content':'Return ONLY valid JSON for the previous request. No commentary.'}
            repaired = get_llm_response_from_context([repair_sys, {'role':'user','content':raw}], llm, temperature=0.0, max_tokens=max_tokens)
            if DEBUG:
                try:
                    sys.stderr.write(f"[CODE_DEBUG] repaired_head={str(repaired)[:4000]}\n")
                except Exception:
                    pass
            parsed = json.loads(_extract_json_payload(repaired))

        # Normalize result structure
        changes = []
        for ch in (parsed.get('changes') or []):
            pathv = str(ch.get('path','')).strip()
            action = str(ch.get('action','')).strip().lower()
            if not pathv or action not in ('add','modify','delete'):
                continue
            obj = {'path': pathv, 'action': action}
            if action in ('add','modify'):
                obj['new_content'] = ch.get('new_content','')
            changes.append(obj)
            if len(changes) >= max_changes:
                break
        # If model returned no changes, nudge once to ensure at least a test plan file is proposed
        if not changes:
            nudgesys = {'role':'system','content':'Output STRICT JSON only. Add at least one file if none were proposed.'}
            nudger = {'role':'user','content':'If no code edits were proposed, add a file tests/TEST_PLAN.md with a bullet list of test cases derived from the PRD.'}
            try:
                nraw = get_llm_response_from_context([nudgesys, nudger], llm, temperature=0.1, response_format={'type':'json_object'}, max_tokens=1200)
            except Exception:
                nraw = get_llm_response_from_context([nudgesys, nudger], llm, temperature=0.1, max_tokens=1200)
            try:
                nparsed = json.loads(_extract_json_payload(nraw))
                for ch in (nparsed.get('changes') or []):
                    pathv = str(ch.get('path','')).strip()
                    action = str(ch.get('action','')).strip().lower()
                    if not pathv or action not in ('add','modify','delete'):
                        continue
                    obj = {'path': pathv, 'action': action}
                    if action in ('add','modify'):
                        obj['new_content'] = ch.get('new_content','')
                    changes.append(obj)
            except Exception:
                pass

        out = {'changes': changes, 'notes': str(parsed.get('notes',''))[:500]}
        print(json.dumps(out))
    except Exception as e:
        print(json.dumps({'error': str(e), 'traceback': traceback.format_exc()}))

if __name__ == '__main__':
    main()
