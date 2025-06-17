from prd_structure import PRDStructure, PRDSection
from llm_interface import get_llm_response_from_context
from ui_utils import record_input, is_uncertain_answer, INFO_COLOR, ASSISTANT_COLOR, RESET_COLOR, write_self_critique
from question_templates import QUESTION_TEMPLATES

# Step 1: Define a fixed PRD structure (sections and required fields)
PRD_SECTIONS = [
    {"name": "Executive Summary", "fields": ["Project Overview", "Objectives"]},
    {"name": "Product Overview", "fields": ["Features", "User Personas"]},
    {"name": "Requirements", "fields": ["Requirement", "Acceptance Criteria", "Test Conditions"]},
    {"name": "User Experience", "fields": ["User Interface Design", "User Flows", "Accessibility Requirements"]},
    {"name": "Implementation", "fields": ["Development Phases", "Dependencies", "Timeline & Milestones", "Success Metrics"]},
    {"name": "Risk Assessment", "fields": ["Technical Risks", "Market Risks", "Mitigation Strategies"]},
]

def get_prd_topics(project_type: str, project_summary: str) -> PRDStructure:
    topics_prompt = f"""Based on this {project_type} project summary: '{project_summary}'
    Generate a comprehensive PRD outline with hierarchical sections. Include:

    1. Executive Summary
       - Project Overview
       - Target Market
       - Key Objectives

    2. Product Overview
       - Value Proposition
       - Key Features
       - User Personas

    3. Requirements
       - Functional Requirements
       - Technical Specifications
       - Performance Requirements
       - Security Requirements
       - Compliance Requirements

    4. User Experience
       - User Interface Design
       - User Flows
       - Accessibility Requirements

    5. Implementation
       - Development Phases
       - Dependencies
       - Timeline & Milestones
       - Success Metrics

    6. Risk Assessment
       - Technical Risks
       - Market Risks
       - Mitigation Strategies

    Format each section as:
    Section: [Title]
    Description: [2-3 sentences about this section]
    Subtopics:
    - [Subtopic]: [Brief description]

    Customize based on this being a {project_type} project while maintaining PRD best practices."""

    messages = [
        {"role": "system", "content": "You are a PRD expert who creates comprehensive document outlines."},
        {"role": "user", "content": topics_prompt}
    ]
    
    response = get_llm_response_from_context(messages, "gpt-4")
    return parse_prd_structure(response)

def process_section(section: PRDSection, project_type: str, chosen_model: str) -> None:
    indent = "  " * section.depth
    print(f"\n{ASSISTANT_COLOR}{indent}--- Section: {section.title} ---{RESET_COLOR}")
    print(f"{ASSISTANT_COLOR}{indent}Description: {section.description}{RESET_COLOR}")
    
    # Get initial content
    section.content = record_input(
        f"{INFO_COLOR}{indent}Please provide details for {section.title}: {RESET_COLOR}",
        f"Section: {section.title}",
        section.description
    ).strip()

    # Get section-specific questions based on section type
    section_prompt = f"""Based on this being a {project_type} project, generate specific questions for the '{section.title}' section.
    Consider:
    - Industry standards and best practices
    - Required metrics and measurements
    - Acceptance criteria
    - Dependencies and constraints
    - Risks and mitigations
    
    Format each question as:
    - Question? (Explanation of why this detail matters)"""
    
    messages = [
        {"role": "system", "content": "You are a PRD expert focusing on thorough, measurable requirements."},
        {"role": "user", "content": section_prompt}
    ]
    
    section_questions = get_llm_response_from_context(messages, chosen_model)
    
    # Process section-specific questions
    for line in section_questions.splitlines():
        if line.startswith("-"):
            question = line.replace("-", "").strip()
            if "(" in question and ")" in question:
                q_text, explanation = question.rsplit("(", 1)
                explanation = explanation.rstrip(")").strip()
                answer = record_input(
                    f"{INFO_COLOR}{indent}  {q_text.strip()} {RESET_COLOR}",
                    f"{section.title} - {q_text.strip()}",
                    explanation
                ).strip()
                if answer.lower() != "skip":
                    section.content += f"\n\n{q_text.strip()}: {answer}"

    # For requirements sections, get specific acceptance criteria
    if "requirement" in section.title.lower():
        criteria_prompt = f"""Based on the provided content for {section.title}:
        Generate specific, measurable acceptance criteria.
        For each requirement mentioned, provide:
        - Success criteria
        - Test conditions
        - Expected outcomes
        
        Format as:
        Requirement: [requirement]
        Acceptance Criteria:
        - [specific, measurable criterion]"""
        
        messages = [
            {"role": "system", "content": "You are a requirements specialist focused on measurable outcomes."},
            {"role": "user", "content": f"Content:\n{section.content}\n\n{criteria_prompt}"}
        ]
        
        criteria = get_llm_response_from_context(messages, chosen_model)
        if criteria.strip():
            section.content += f"\n\nAcceptance Criteria:\n{criteria}"

    # Process subtopics
    if section.subtopics:
        print(f"\n{INFO_COLOR}{indent}Let's cover the subtopics for {section.title}:{RESET_COLOR}")
        for subtopic in section.subtopics:
            process_section(subtopic, project_type, chosen_model)

def generate_final_prd(prd_structure: PRDStructure, project_type: str) -> str:
    with open("user_responses.txt", "r", encoding="utf-8") as f:
        user_responses_text = f.read()
    with open("self-critiques.txt", "r", encoding="utf-8") as f:
        self_critiques_text = f.read()

    # Build structured content from sections
    sections_content = []
    for section in prd_structure.get_all_sections():
        content = {
            "title": section.title,
            "description": section.description,
            "content": section.content,
            "depth": section.depth,
            "has_requirements": "requirement" in section.title.lower()
        }
        sections_content.append(content)

    prompt = f"""Generate a comprehensive PRD using the following content and guidelines:

1. Structure:
   - Each main section should be clearly numbered
   - Include detailed subsections with proper hierarchy
   - Requirements must include acceptance criteria
   - Include cross-references between related sections

2. Content Requirements:
   - Executive Summary: At least 2 paragraphs
   - Requirements sections: Minimum 5 specific, measurable requirements
   - Technical sections: Include specific metrics and standards
   - User-facing features: Include user acceptance criteria
   
3. Special Considerations for {project_type} Projects:
   - Include relevant industry standards
   - Specify all measurable outcomes
   - Detail testing requirements
   - Include performance metrics

4. Format:
   - Use clear, concise language
   - Include tables for specifications
   - Use numbered lists for requirements
   - Include acceptance criteria in testable format

Section Content:
"""

    # Add each section's content to the prompt
    for section in sections_content:
        prompt += f"\n{'  ' * section['depth']}[{section['title']}]\n"
        prompt += f"{'  ' * section['depth']}{section['content']}\n"

    prompt += "\nUser Responses:\n" + user_responses_text
    prompt += "\n\nSelf-Critiques (for reference):\n" + self_critiques_text

    messages = [
        {"role": "system", "content": "You are an expert in creating comprehensive PRDs with detailed, measurable requirements."},
        {"role": "user", "content": prompt}
    ]
    
    return get_llm_response_from_context(messages, "gpt-4")

def parse_prd_structure(response: str) -> PRDStructure:
    prd = PRDStructure()
    current_section = None
    current_title = None
    current_description = None
    current_subtopics = []
    
    lines = response.strip().split('\n')
    for line in lines:
        line = line.strip()
        if not line:
            continue
            
        if line.startswith('Section:'):
            # Save previous section if exists
            if current_title:
                section = PRDSection(
                    title=current_title,
                    description=current_description or "",
                    subtopics=[],
                    content=""
                )
                prd.add_section(section)
                current_section = section
            
            current_title = line.replace('Section:', '').strip()
            current_description = None
            current_subtopics = []
            
        elif line.startswith('Description:'):
            current_description = line.replace('Description:', '').strip()
            
        elif line.startswith('-') and current_section:
            subtopic = line.replace('-', '').strip()
            if ':' in subtopic:
                title, desc = subtopic.split(':', 1)
                subsection = PRDSection(
                    title=title.strip(),
                    description=desc.strip(),
                    subtopics=[],
                    content=""
                )
                current_section.subtopics.append(subsection)
    
    # Add final section
    if current_title:
        section = PRDSection(
            title=current_title,
            description=current_description or "",
            subtopics=[],
            content=""
        )
        prd.add_section(section)
    
    return prd

# Step 4: Section-bounded, context-aware questioning using PRD_SECTIONS and QUESTION_TEMPLATES

def process_prd_sections(prd_sections, industry_domain, project_type):
    user_inputs = {section['name']: {field: None for field in section['fields']} for section in prd_sections}
    completed_sections = set()
    section_order = [section['name'] for section in prd_sections]
    section_lookup = {section['name']: section for section in prd_sections}
    idx = 0
    while idx < len(section_order):
        section_name = section_order[idx]
        section = section_lookup[section_name]
        print(f"\n{ASSISTANT_COLOR}--- Section: {section_name} ---{RESET_COLOR}")
        for field in section['fields']:
            if user_inputs[section_name][field]:
                continue  # Already answered
            template = QUESTION_TEMPLATES.get(field, {})
            prompt = template.get('prompt', f"Please provide details for {field}.")
            followup = template.get('followup', None)
            examples = template.get('examples', {})
            example = examples.get(project_type, "")
            if example and industry_domain:
                prompt += f"\nExample for {industry_domain} {project_type}: {example}"
            answer = record_input(f"{INFO_COLOR}{prompt}{RESET_COLOR}", f"{section_name} - {field}", "").strip()
            if not answer or is_uncertain_answer(answer):
                if followup:
                    answer2 = record_input(f"{INFO_COLOR}{followup}{RESET_COLOR}", f"{section_name} - {field} (followup)", "").strip()
                    if answer2:
                        answer = answer2
            user_inputs[section_name][field] = answer
        # Summarize and validate section
        print(f"\n{ASSISTANT_COLOR}Summary for {section_name}:{RESET_COLOR}")
        for field, value in user_inputs[section_name].items():
            print(f"{field}: {value if value else '[MISSING]'}")
        confirm = record_input(f"{INFO_COLOR}Is this section complete and accurate? (yes/no/skip){RESET_COLOR}", f"{section_name} confirmation", "").strip().lower()
        if confirm.startswith('y'):
            completed_sections.add(section_name)
            idx += 1
        elif confirm.startswith('s'):
            idx += 1  # Allow skip
        else:
            print(f"{INFO_COLOR}Let's revisit this section now.{RESET_COLOR}")
    # After all, offer to revisit incomplete sections
    incomplete = [s for s in section_order if s not in completed_sections]
    while incomplete:
        print(f"\n{INFO_COLOR}You have incomplete sections: {', '.join(incomplete)}{RESET_COLOR}")
        revisit = record_input(f"Which section would you like to revisit? (or 'done' to finish) > ", "Revisit Section", "").strip()
        if revisit.lower() == 'done':
            break
        if revisit in incomplete:
            idx = section_order.index(revisit)
            section_name = section_order[idx]
            section = section_lookup[section_name]
            for field in section['fields']:
                if user_inputs[section_name][field]:
                    continue
                template = QUESTION_TEMPLATES.get(field, {})
                prompt = template.get('prompt', f"Please provide details for {field}.")
                followup = template.get('followup', None)
                examples = template.get('examples', {})
                example = examples.get(project_type, "")
                if example and industry_domain:
                    prompt += f"\nExample for {industry_domain} {project_type}: {example}"
                answer = record_input(f"{INFO_COLOR}{prompt}{RESET_COLOR}", f"{section_name} - {field}", "").strip()
                if not answer or is_uncertain_answer(answer):
                    if followup:
                        answer2 = record_input(f"{INFO_COLOR}{followup}{RESET_COLOR}", f"{section_name} - {field} (followup)", "").strip()
                        if answer2:
                            answer = answer2
                user_inputs[section_name][field] = answer
            print(f"\n{ASSISTANT_COLOR}Summary for {section_name}:{RESET_COLOR}")
            for field, value in user_inputs[section_name].items():
                print(f"{field}: {value if value else '[MISSING]'}")
            confirm = record_input(f"{INFO_COLOR}Is this section complete and accurate? (yes/no/skip){RESET_COLOR}", f"{section_name} confirmation", "").strip().lower()
            if confirm.startswith('y') or confirm.startswith('s'):
                completed_sections.add(section_name)
        incomplete = [s for s in section_order if s not in completed_sections]
    return user_inputs
