from ui_utils import INFO_COLOR, ASSISTANT_COLOR, RESET_COLOR, record_input, write_self_critique
from llm_interface import get_llm_response_from_context, classify_query_complexity, classify_evaluation_complexity
from prd_generator import PRD_SECTIONS, process_prd_sections
from question_templates import QUESTION_TEMPLATES
from fpdf import FPDF

def generate_pdf(content: str, output_file: str):
    class PDF(FPDF):
        def header(self):
            self.set_font("Arial", "B", 12)
            self.cell(0, 10, "Product Requirements Document", 0, 1, "C")
            self.ln(10)

        def footer(self):
            self.set_y(-15)
            self.set_font("Arial", "I", 8)
            self.cell(0, 10, f"Page {self.page_no()}", 0, 0, "C")

    pdf = PDF()
    pdf.add_page()
    pdf.set_auto_page_break(auto=True, margin=15)
    pdf.set_font("Arial", size=12)

    for line in content.splitlines():
        if not line.strip():
            pdf.ln(5)
        else:
            pdf.multi_cell(0, 10, line)
            pdf.ln(1)

    pdf.output(output_file)

def main():
    # Initialize files
    for file in ["self-critiques.txt", "user_responses.txt"]:
        with open(file, "w", encoding="utf-8") as f:
            f.write(f"{file.replace('.txt', '').title()} for this run:\n\n")
    
    # Welcome and project description
    print(f"{INFO_COLOR}Hello! I am here to assist you with creating a Product Requirements Document (PRD) for your project.{RESET_COLOR}")
    ready = record_input(f"{INFO_COLOR}Would you like to get started? (yes/no) > {RESET_COLOR}", 
                        "Would you like to get started?", "").strip().lower()
    if not ready.startswith("y"):
        print(f"{INFO_COLOR}No problem. Have a great day!{RESET_COLOR}")
        return

    # Get project description and summary
    print(f"\n{INFO_COLOR}Great! Please provide a brief description of your project:{RESET_COLOR}")
    project_desc = record_input(f"{INFO_COLOR}> {RESET_COLOR}", "Project Description", "").strip()

    # Step 3: Prompt for industry/domain
    print(f"\n{INFO_COLOR}What is the primary industry or domain for this product? (e.g., healthcare, fintech, education, IoT, etc.){RESET_COLOR}")
    industry_domain = record_input(f"{INFO_COLOR}> {RESET_COLOR}", "Industry/Domain", "").strip()

    chosen_model = classify_query_complexity(project_desc)
    summary_prompt = (
        "Please summarize the following project description in one concise paragraph, avoiding bullet points:\n\n" + project_desc
    )
    summary_messages = [
        {"role": "system", "content": "You are a helpful assistant skilled at summarizing project descriptions."},
        {"role": "user", "content": summary_prompt}
    ]
    project_summary = get_llm_response_from_context(summary_messages, chosen_model)

    # Validate summary with user
    while True:
        print(f"\n{ASSISTANT_COLOR}Assistant's summary of your project:{RESET_COLOR}")
        print(f"{ASSISTANT_COLOR}{project_summary}{RESET_COLOR}")
        confirm = record_input(f"{INFO_COLOR}Does this summary accurately reflect your project? (yes/no) > {RESET_COLOR}", 
                             "Summary Confirmation", "").strip().lower()
        if confirm.startswith("y"):
            break
        print(f"{INFO_COLOR}Let's try again. Please re-enter your project description for clarification:{RESET_COLOR}")
        project_desc = record_input(f"{INFO_COLOR}> {RESET_COLOR}", "Project Description Re-entry", "").strip()
        summary_messages[1]["content"] = "Please summarize the following project description in one concise paragraph, avoiding bullet points:\n\n" + project_desc
        project_summary = get_llm_response_from_context(summary_messages, chosen_model)

    # Classify project type
    classification_prompt = (
        "Based on the following project summary, determine whether this is primarily a 'hardware' or 'software' project. "
        "Provide your answer as either 'hardware' or 'software' along with a brief explanation.\n\n" + project_summary
    )
    classification_messages = [
        {"role": "system", "content": "You are a helpful assistant specialized in creating product requirements documents."},
        {"role": "user", "content": classification_prompt}
    ]
    classification_response = get_llm_response_from_context(classification_messages, chosen_model)
    print(f"\n{ASSISTANT_COLOR}Project Classification:{RESET_COLOR}")
    print(f"{ASSISTANT_COLOR}{classification_response}{RESET_COLOR}")

    # Validate classification
    evaluation_model = classify_evaluation_complexity()
    evaluation_prompt = (
        "Please review the following project summary and the assistant's classification. "
        "Does the classification accurately capture the user's intent? Explain your reasoning and note any discrepancies.\n\n"
        f"Project Summary: {project_summary}\nAssistant's Classification: {classification_response}"
    )
    evaluation_messages = [
        {"role": "system", "content": "You are a reasoning assistant skilled at analyzing project descriptions and ensuring that interpretations match user intent."},
        {"role": "user", "content": evaluation_prompt}
    ]
    evaluation_response = get_llm_response_from_context(evaluation_messages, evaluation_model)
    print(f"\n{ASSISTANT_COLOR}Evaluation of Classification:{RESET_COLOR}")
    print(f"{ASSISTANT_COLOR}{evaluation_response}{RESET_COLOR}")

    if "hardware" in classification_response.lower():
        project_type = "hardware"
    elif "software" in classification_response.lower():
        project_type = "software"
    else:
        project_type = "unspecified"

    # Remove old PRD structure generation and processing
    # prd_structure = get_prd_topics(project_type, project_summary)
    # print(f"\n{ASSISTANT_COLOR}Generated PRD structure with {len(prd_structure.sections)} main sections.{RESET_COLOR}")
    # print(f"\n{INFO_COLOR}Let's work through each section to gather more details interactively.{RESET_COLOR}")
    # for section in prd_structure.get_all_sections():
    #     process_section(section, project_type, chosen_model)

    # Step 4: Use new section-bounded PRD flow
    user_inputs = process_prd_sections(PRD_SECTIONS, industry_domain, project_type)

    # Step 5: Save user_inputs as draft PRD (simple text for now)
    prd_text = ""
    for section, fields in user_inputs.items():
        prd_text += f"\n## {section}\n"
        for field, value in fields.items():
            prd_text += f"- **{field}:** {value if value else '[MISSING]'}\n"
    with open("final_prd.txt", "w", encoding="utf-8") as f:
        f.write(prd_text)
    generate_pdf(prd_text, "final_prd.pdf")
    print(f"\n{ASSISTANT_COLOR}Final document saved as 'final_prd.txt' and 'final_prd.pdf'.{RESET_COLOR}")

if __name__ == "__main__":
    main()
