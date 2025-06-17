# Color constants for terminal output
INFO_COLOR = "\033[94m"       # Blue for instructions and info
ASSISTANT_COLOR = "\033[92m"  # Green for assistant messages
LOADING_COLOR = "\033[93m"    # Yellow for loading messages
RESET_COLOR = "\033[0m"

def write_self_critique(text: str):
    with open("self-critiques.txt", "a", encoding="utf-8") as f:
        f.write(text + "\n")

def record_qa_pair(question: str, explanation: str, answer: str):
    with open("user_responses.txt", "a", encoding="utf-8") as f:
        f.write(f"Question: {question}\n")
        if explanation:
            f.write(f"Explanation: {explanation}\n")
        f.write(f"Answer: {answer}\n")
        f.write("-" * 40 + "\n")

def record_input(prompt: str, question: str, explanation: str = "") -> str:
    response = input(prompt)
    record_qa_pair(question, explanation, response)
    return response

def is_uncertain_answer(answer: str) -> bool:
    uncertain_keywords = [
        "i don't know", "unsure", "not sure", "confused",
        "no idea", "unclear", "doubt", "hesitant",
        "don't understand", "uncertain", "not certain",
        "ambivalent", "i have no clue", "lack clarity",
        "unspecified", "uncertainty"
    ]
    return any(keyword in answer.lower() for keyword in uncertain_keywords)
