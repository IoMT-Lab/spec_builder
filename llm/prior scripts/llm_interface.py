import os
from typing import Optional
from openai import OpenAI
from ui_utils import INFO_COLOR, LOADING_COLOR, RESET_COLOR

if not os.getenv("OPENAI_API_KEY"):
    raise ValueError("OPENAI_API_KEY environment variable is not set")

client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

def _to_responses_input(messages: list) -> list:
    """Convert Chat-style messages to Responses API input format."""
    out = []
    for m in messages or []:
        role = m.get("role", "user")
        content = m.get("content", "")
        if isinstance(content, list):
            # Flatten to text
            text = "\n".join(str(x) for x in content)
        else:
            text = str(content)
        content_type = "output_text" if role == "assistant" else "input_text"
        out.append({
            "role": role,
            "content": [
                {"type": content_type, "text": text}
            ]
        })
    return out


def get_llm_response_from_context(messages: list, model_name: str, temperature: float = 0.7, response_format: Optional[dict] = None, max_tokens: Optional[int] = None) -> str:
    """Call the OpenAI Responses API and return the output text.

    Falls back to safe combinations when the model rejects certain params.
    """
    inp = _to_responses_input(messages)

    def _call(kwargs: dict) -> str:
        resp = client.responses.create(**kwargs)
        return getattr(resp, "output_text", None) or str(resp)

    base = {
        "model": model_name,
        "input": inp,
    }
    if max_tokens is not None:
        base["max_output_tokens"] = max_tokens

    # Try, in order:
    # 1) base + response_format (no temperature)
    try:
        first = dict(base)
        if response_format is not None:
            first["response_format"] = response_format
        return _call(first)
    except Exception:
        # 2) base only (no temperature, no response_format)
        try:
            return _call(dict(base))
        except Exception:
            # 3) base + temperature (+ response_format if provided)
            try:
                final = dict(base)
                final["temperature"] = temperature
                if response_format is not None:
                    final["response_format"] = response_format
                return _call(final)
            except Exception as e3:
                return f"An error occurred while calling the OpenAI API\n{str(e3)}"


def classify_query_complexity(user_idea: str) -> str:
    word_count = len(user_idea.split())
    return "gpt-3.5-turbo" if word_count < 20 else "gpt-4"

def classify_evaluation_complexity() -> str:
    return "gpt-4"
