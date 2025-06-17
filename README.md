# LLM Web App

This repository is a modular web application designed to facilitate the creation, editing, and management of Product Requirements Documents (PRDs) using Large Language Models (LLMs). The project is organized for clear separation between frontend, backend, LLM scripts, and shared code.

## Repository Structure

- **frontend/**: Contains the React-based user interface. Users interact with the app here to create, edit, and review PRDs. The frontend communicates with the backend via HTTP APIs.
- **backend/**: Node.js/Express server that acts as the bridge between the frontend and the LLM scripts. It handles API requests from the frontend, manages sessions, and invokes LLM scripts as needed.
- **llm/**: Python scripts and modules that implement the core LLM-powered logic, such as generating, editing, or analyzing PRDs. The backend calls these scripts, passing user input and returning results to the frontend.
- **shared/**: Contains code or resources that are used by multiple parts of the application.
- **Documents/** and **sessions/**: Store generated PRDs, conversation logs, and session data.

## How Components Interact

1. **Frontend**: The user interacts with the web UI to input requirements or review documents.
2. **Backend**: Receives requests from the frontend, manages user sessions, and coordinates the workflow.
3. **LLM Scripts**: The backend invokes Python scripts in the `llm/` directory to process user input, generate or edit PRDs, and return results.
4. **Data Storage**: Generated documents and session data are saved in the `Documents/` and `sessions/` directories for persistence and later retrieval.

## Getting Started

1. Install dependencies in both `frontend/` and `backend/` directories.
2. Start the backend server.
3. Start the frontend development server.
4. Use the web interface to interact with the app.

---

For more details, see the README files in each subdirectory.
