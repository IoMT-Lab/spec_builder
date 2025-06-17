// PRD structure and question templates for the advanced PRD flow

const PRD_SECTIONS = [
  { name: "Executive Summary", fields: ["Project Overview", "Objectives"] },
  { name: "Product Overview", fields: ["Features", "User Personas"] },
  { name: "Requirements", fields: ["Requirement", "Acceptance Criteria", "Test Conditions"] },
  { name: "User Experience", fields: ["User Interface Design", "User Flows", "Accessibility Requirements"] },
  { name: "Implementation", fields: ["Development Phases", "Dependencies", "Timeline & Milestones", "Success Metrics"] },
  { name: "Risk Assessment", fields: ["Technical Risks", "Market Risks", "Mitigation Strategies"] },
];

const QUESTION_TEMPLATES = {
  "Project Overview": {
    prompt: "Describe the overall goal and context of the project.",
    followup: "Can you clarify the main business or user problem this project solves?",
    examples: { software: "A SaaS platform for remote team collaboration.", hardware: "A wearable device for health monitoring." }
  },
  "Objectives": {
    prompt: "List the key objectives for this project.",
    followup: "Can you specify measurable targets for each objective?",
    examples: { software: "Reduce onboarding time by 30%.", hardware: "Battery life of at least 48 hours." }
  },
  "Features": {
    prompt: "Describe the main features of the product.",
    followup: "Which feature is most critical for launch?",
    examples: { software: "Real-time chat, file sharing.", hardware: "Touchscreen, Bluetooth connectivity." }
  },
  "User Personas": {
    prompt: "Who are the primary users?",
    followup: "Can you provide a detailed persona (role, needs, pain points)?",
    examples: { software: "Remote project managers.", hardware: "Fitness enthusiasts aged 25-40." }
  },
  "Requirement": {
    prompt: "Describe a key requirement for your product.",
    followup: "How will you verify this requirement is met? Please specify measurable criteria.",
    examples: { software: "User authentication via OAuth.", hardware: "Device must be waterproof to 1m." }
  },
  "Acceptance Criteria": {
    prompt: "What are the acceptance criteria for this requirement?",
    followup: "Can you make these criteria more specific and testable?",
    examples: { software: "User can log in with Google account.", hardware: "Device passes IP67 test." }
  },
  "Test Conditions": {
    prompt: "How will you test this requirement?",
    followup: "Can you describe a concrete test scenario?",
    examples: { software: "Simulate login with invalid credentials.", hardware: "Submerge device for 30 minutes." }
  },
  // ...add more as needed...
};

module.exports = { PRD_SECTIONS, QUESTION_TEMPLATES };
