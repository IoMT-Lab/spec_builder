import os
from openai import OpenAI
from ui_utils import INFO_COLOR, LOADING_COLOR, RESET_COLOR

if not os.getenv("OPENAI_API_KEY"):
    raise ValueError("OPENAI_API_KEY environment variable is not set")

client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

def get_llm_response_from_context(messages: list, model_name: str, temperature: float = 0.7) -> str:
    try:
        response = client.chat.completions.create(
            model=model_name,
            messages=messages,
            temperature=temperature
        )
        output = response.choices[0].message.content
    except Exception as e:
        output = f"An error occurred while calling the OpenAI API:\n{str(e)}"
    return output

def classify_query_complexity(user_idea: str) -> str:
    word_count = len(user_idea.split())
    return "gpt-3.5-turbo" if word_count < 20 else "gpt-4"

def classify_evaluation_complexity() -> str:
    return "gpt-4"
