# Requirements Builder (local developer README)

This repository is an early-stage, local-first web application that helps a user iteratively build Product Requirements Documents (PRDs) with the help of a Large Language Model (LLM). It also derives assurance cases from the PRD and provides tools to analyze a codebase for adherence to the derived requirements and assurance cases.

Audience: technical readers who understand code and basic web architectures but may be unfamiliar with this specific app. The instructions assume you will run the system locally for development and experimentation.

Summary — what the app does
- A user converses with an LLM via the frontend UI to author and refine a PRD.
- The backend coordinates conversation state, invokes LLM scripts, and stores session artifacts.
- From a PRD, the system derives Assurance Cases (structured arguments that claim a system meets certain safety/assurance properties).
- The app can scan a local code directory, send code + PRD/assurance artifacts to the LLM to propose changes or identify mismatches, and present diffs/proposals to the user for review.

High-level architecture

- Frontend (`frontend/`)
	- React-based UI where the user creates sessions, chats with the LLM, edits the PRD, views readiness/coverage, and opens the Code Preview panel to scan/propose code changes.
	- Important UI components: `App.jsx` (main app), `CodePreview.jsx` (scan/propose/apply workflow), `PrdDiffPanel.jsx` (diff and accept/reject PRD changes).

- Backend (`backend/`)
	- Node.js + Express server that exposes REST endpoints the frontend calls. It manages sessions, persists PRD drafts and metadata in `sessions/` and `Documents/`, and orchestrates calls to the LLM code in `llm/`.
	- Key API endpoints (examples):
		- `/api/health` — health check and environment diagnostics.
		- `/api/code/prepare` — scan a folder and build a job manifest (file list, sizes, ignored files).
		- `/api/code/propose` — ask the LLM (or LLM script) to propose changes based on PRD + code + extra prompt.
		- `/api/code/diff/:jobId` — get the generated diffs for a proposal.
		- `/api/code/accept/:jobId` and `/api/code/reject/:jobId` — apply or discard a proposal.

- LLM scripts (`llm/`)
	- Python scripts and helper modules invoked by the backend to prepare prompts, call LLMs (OpenAI/Gemini/other adapters), and post-process outputs. These scripts are where the PRD → Assurance Case extraction and code-analysis prompts live.

Intended user flow (step-by-step)

<img width="1512" height="945" alt="Screenshot 2025-08-30 at 13 51 56" src="https://github.com/user-attachments/assets/3d14b8b8-ac83-4bfe-90da-32c9b50b4f77" />

1. Start local servers (backend, then frontend).
2. In the UI, create or select a session and start a conversation with the LLM. The LLM is guided by a system prompt and supporting structure messages so it helps the user produce a focused PRD.
3. The user iteratively converses: the LLM asks clarifying questions, the user answers, and the PRD gets updated. The frontend persists drafts and shows coverage/weakness indicators for PRD sections.
4. Once the PRD is mature enough, the system derives Assurance Cases from the PRD (structured claims, evidence, and argument fragments). These are stored alongside the PRD drafts and exposed in the UI.
5. The user opens the Code Preview panel and picks a local code directory to scan. The frontend sends the directory path and optional extra prompt to the backend.
6. The backend scans the codebase, prepares a payload including PRD text and Assurance Case artifacts, and invokes LLM scripts to analyze the code for adherence to requirements or to propose code changes that would better satisfy assurance claims.
7. The LLM returns proposed changes or flagged mismatches. The frontend displays unified diffs and per-file proposals in the Code Preview UI.
8. The user reviews proposals and can Accept All, Reject All, or (future work) accept per-file/line changes. Accepted proposals are applied (currently via backend file edits); rejected proposals are discarded.

Work-in-progress and local-run notes

- This project is a work in progress. It is intended to be run locally for experimentation and development.
- Assurance Case generation and code analysis are still very much in development. 
- The backend may call local Python scripts and (on macOS) may use small native helpers for convenience (for example, an optional file-browse helper). Those helpers may require local permission to run.
- There are no production-grade security controls by default. Do not run this on a public server without adding proper authentication, path sanitization, and other hardening.

Getting started (quick local developer steps)

1. Clone the repo and open a terminal in the repository root.
2. Install dependencies. There are separate front-end and back-end areas; follow the respective package files.

	 - Backend (Node):

		 ```bash
		 cd backend
		 npm install
		 # start backend server (default port 4000)
		 node index.js
		 ```

	 - Frontend (React):

		 ```bash
		 cd frontend
		 npm install
		 npm start
		 ```

3. Open the frontend app in your browser (usually http://localhost:3000 or as printed by the dev server). Create a session and start chatting with the LLM.

Key file locations and what they do

- `frontend/` — React app, UI components, CSS.
- `backend/index.js` — Express server, routes, session persistence, and orchestration logic.
- `llm/` — Python scripts that build prompts and call LLMs; contains transformation/analysis logic.
- `Documents/` — PRD drafts and exported documents.
- `sessions/` — session state, conversation history, and metadata.
- `scripts/` — helper scripts and automation utilities.

Automated scenario testing (`/scripts` + `/scenarios`)
-----------------------------------------------

This project includes a small scenario runner intended for automated/ repeatable testing of the LLM conversation and PRD generation flow. The runner pairs a plain-text scenario (in `scenarios/`) with a driver script (`scripts/autodrive.mjs`) that simulates a human interacting with the app.

How it works (high level)
- Scenario files: each file under `scenarios/` is a plain text file where each non-empty line is treated as a single user input (a message that would be typed into the chat UI). Example: `scenarios/photo_detector_tests.txt` contains multiple lines describing test requirements that the LLM should use to build a PRD.
- Driver script (`scripts/autodrive.mjs`): this Node script reads a scenario file, creates a new session via the backend, then sequentially POSTs each line to the backend LLM endpoint. After each LLM reply it:
	- logs the LLM reply for traceability,
	- auto-confirms any server-generated summaries when the server indicates it's awaiting confirmation (it will send an `ACCEPT_PHRASE` to continue drafting),
	- checks the PRD diff for a temporary draft (via `/api/sessions/:id/prd/diff`), and if a temp PRD exists it accepts or merges the proposed PRD change (calls `/api/sessions/:id/prd/accept` or `/api/sessions/:id/prd/merge`).

API endpoints used by the script
- `POST /api/sessions` — create a new session (driver uses this to start a fresh run).
- `POST /api/llm` — send an input to the LLM on behalf of a session; the backend returns the assistant reply and updated session state.
- `GET /api/sessions/:id/prd/diff` — check for proposed PRD drafts/diffs; used to detect if the LLM produced a temp PRD.
- `POST /api/sessions/:id/prd/accept` — accept a temp PRD draft.
- `POST /api/sessions/:id/prd/merge` — fallback merge endpoint used if accept fails.

Environment variables & requirements
- `BASE_URL` — base URL for the backend (default: `http://localhost:4000`).
- `LLM` — which LLM identifier the driver instructs the backend to use (example: `gpt5`).
- `ACCEPT_PHRASE` — phrase the driver will send to auto-confirm summaries and allow PRD drafting to proceed (default: `Looks right, please apply this to the PRD.`).
- Node 18+ (the script uses the global `fetch` API).

Usage example

```bash
# basic run
node scripts/autodrive.mjs scenarios/photo_detector_tests.txt

# specify backend and LLM
BASE_URL=http://localhost:4000 LLM=gpt5 node scripts/autodrive.mjs scenarios/photo_detector_tests.txt
```

Notes, safety, and how to extend
- The driver will auto-accept PRD changes when it sees a temp PRD; this makes it useful for regression testing but potentially dangerous if used on production data—be careful when running against real repositories or important drafts.
- Add new scenario files under `scenarios/` to exercise other flows. Keep each user utterance on its own line; the script strips blank lines.
- The driver is intentionally simple; it is a good starting point for adding more test assertions, timeouts, or scripted checks (for example, validate that the final PRD contains expected headings or that an assurance case contains a named claim).


Design and implementation notes (important details)

- Conversation: the backend keeps a session object per PRD session that tracks cursor/focus for PRD sections. The LLM is given structured system messages so it maintains a consistent approach to eliciting and validating PRD content.
- PRD → Assurance Case: the LLM scripts include logic to derive structured assurance claims and minimal evidence pointers from the PRD text—these are used to guide code analysis prompts.
- Code analysis: the backend scans a user-specified code directory and includes file contents in a payload sent to the LLM for lightweight analysis or patch proposals. Large repositories should be scanned with filters; the backend has heuristics to ignore binary files and large artifacts.

<img width="1512" height="945" alt="Screenshot 2025-08-30 at 13 52 47" src="https://github.com/user-attachments/assets/06445b6a-7e98-4308-a125-8df80ebb922b" />

Security & safety notes

- This project runs arbitrary local code when you accept an LLM proposal that applies file edits. Only run it on code you trust and on machines you control.
- Sanitize and validate any `codeRoot` or file paths that reach the backend. Consider restricting to allowed root directories to avoid accidental or malicious access to sensitive files.
- Be cautious with secrets. Do not store API keys or secrets in the repo; use environment variables for LLM keys.

Troubleshooting

- If the frontend reports backend unreachable: make sure the backend is running on the expected port and you are hitting the right origin (CORS/config). Check `backend` logs for errors.
- If LLM calls fail: verify environment variables (OPENAI_API_KEY, GEMINI_API_KEY) and that any Python dependencies used by `llm/` scripts are installed.
- If code scanning is slow or times out: narrow the `codeRoot` to a smaller subfolder and ensure the backend has filesystem access.

How to help / contribute

- The project is evolving. If you want to contribute: open issues for bugs or feature requests, create focused pull requests, and add small, testable changes.
- Helpful additions: per-file accept/reject UX, robust authentication, cross-platform native helpers, unit tests for backend orchestration, and improved prompt templates for assurance extraction.

Contact / license

See repository metadata for licensing and contact info. For local experimentation, you are free to adapt and extend the code for research or prototyping.
