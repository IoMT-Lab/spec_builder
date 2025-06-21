const express = require('express');
const fetchModule = require('node-fetch');
const fetch = fetchModule.default || fetchModule;
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const runLLMScript = require('./runLLMScript');
const { PRD_SECTIONS, QUESTION_TEMPLATES } = require('./prdConfig');
const { createSession, getSession, updateSession } = require('./prdSessionStore');
const cors = require("cors");

const openaiApiKey = process.env.OPENAI_API_KEY;
const geminiApiKey = process.env.GEMINI_API_KEY;

const app = express();
app.use(express.json());
app.use(cors());

// Log server start
console.log('Backend server starting...');

// --- DEBUG: Print absolute path and CWD at startup ---
console.log('STARTUP DEBUG: Running file:', __filename);
console.log('STARTUP DEBUG: Current working directory:', process.cwd());
console.log('STARTUP DEBUG: Date/time:', new Date().toISOString());

// Ensure Documents/PRD_draft.md exists at server startup
const docsDir = path.join(__dirname, '..', 'Documents');
const prdPath = path.join(docsDir, 'PRD_draft.md');
if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });
if (!fs.existsSync(prdPath)) {
  fs.writeFileSync(prdPath, '# Product Requirements Document\n\nStart writing your PRD here.');
}

console.log('Backend __dirname:', __dirname);
console.log('Resolved docsDir:', docsDir);
console.log('Resolved prdPath:', prdPath);

// Sessions directory
const sessionsDir = path.join(__dirname, '..', 'sessions');
if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });

// Utility to load all sessions
function listSessions() {
  return fs.readdirSync(sessionsDir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const data = fs.readFileSync(path.join(sessionsDir, f), 'utf-8');
      return JSON.parse(data);
    });
}

// LLM API endpoint (stateful, session-based)
app.post('/api/llm', async (req, res) => {
  console.log('POST /api/llm called with body:', req.body);
  const sessionId = req.body.sessionId;
  let llm = req.body.llm;
  if (llm === 'openai') llm = 'gpt-3.5-turbo';
  if (llm === 'gemini') llm = 'gemini-pro';
  const userInput = req.body.input || '';
  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });
  let session = getSession(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  session.conversation = session.conversation || [];

  // Always push user input to conversation
  if (userInput && userInput.trim()) {
    session.conversation.push({ role: 'user', content: userInput });
  }

  // Always call the LLM script, regardless of state
  try {
    const scriptPath = path.join(__dirname, '..', 'llm', 'conversation_flow.py');
    const scriptResult = await runLLMScript(scriptPath, {
      prompt: userInput,
      conversation: session.conversation,
      llm,
      prdDraft: session.prdDraft || ''
    });
    // Print whether scriptResult.prdDraft is truthy or not
    console.log('scriptResult.prdDraft is', scriptResult.prdDraft ? 'truthy' : 'falsy', '| Value:', scriptResult.prdDraft);
    // Save LLM reply and PRD draft
    session.conversation.push({ role: 'assistant', content: scriptResult.reply });
    // Always write the LLM's PRD draft (or session.prdDraft) to PRD_<sessionId>_temp.md for diffing
    const tempPrdPath = path.join(__dirname, '..', 'Documents', `PRD_${sessionId}_temp.md`);
    const prdDraftToWrite = typeof scriptResult.prdDraft === 'string' ? scriptResult.prdDraft : (session.prdDraft || '');
    fs.writeFileSync(tempPrdPath, prdDraftToWrite, 'utf-8');
    // Optionally update session.prdDraft in memory (but do NOT write to main PRD file here)
    if (
      typeof scriptResult.prdDraft === 'string' &&
      scriptResult.prdDraft.trim() !== '' &&
      scriptResult.prdDraft !== session.prdDraft
    ) {
      session.prdDraft = scriptResult.prdDraft;
    }
    updateSession(sessionId, session);
    return res.json({ reply: scriptResult.reply, prdDraft: scriptResult.prdDraft, session });
  } catch (error) {
    return res.status(500).json({ error: 'LLM script error', details: error });
  }
});

// Endpoint to check API key and model access
app.post('/api/llm/check', async (req, res) => {
  const llm = req.body.llm;
  try {
    if (llm === 'openai') {
      if (!openaiApiKey) return res.json({ ok: false, error: 'No OpenAI API key set' });
      // Check model list
      const response = await fetch('https://api.openai.com/v1/models', {
        headers: { 'Authorization': `Bearer ${openaiApiKey}` },
      });
      const data = await response.json();
      if (!response.ok) {
        return res.json({ ok: false, error: data.error?.message || 'OpenAI API error' });
      }
      const hasModel = data.data && data.data.some(m => m.id === 'gpt-3.5-turbo');
      if (!hasModel) return res.json({ ok: false, error: 'gpt-3.5-turbo model not available' });
      return res.json({ ok: true });
    } else if (llm === 'gemini') {
      if (!geminiApiKey) return res.json({ ok: false, error: 'No Gemini API key set' });
      // Check model access (Gemini API does not have a model list endpoint, so do a dry run)
      const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=' + geminiApiKey, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: 'ping' }] }] }),
      });
      const data = await response.json();
      if (!response.ok) {
        return res.json({ ok: false, error: data.error?.message || 'Gemini API error' });
      }
      return res.json({ ok: true });
    } else {
      return res.json({ ok: false, error: 'Unsupported LLM provider' });
    }
  } catch (err) {
    console.error('API key/model check failed:', err.stack || err);
    return res.json({ ok: false, error: err.message });
  }
});

// Serve PRD_draft.md
app.get('/api/markdown/prd', (req, res) => {
  console.log('Endpoint hit: /api/markdown/prd');
  console.log('Serving PRD markdown from:', prdPath);
  console.log('File exists:', fs.existsSync(prdPath));
  res.type('text/markdown');
  res.sendFile(prdPath, err => {
    if (err) {
      console.error('Error sending PRD markdown:', err);
      console.error('Attempted path:', prdPath);
      res.status(500).send('Could not load markdown.');
    }
  });
});

// List all sessions
app.get('/api/sessions', (req, res) => {
  try {
    const sessions = listSessions();
    res.json(sessions);
  } catch (err) {
    res.status(500).json({ error: 'Failed to list sessions', details: err.message });
  }
});

// Create a new session
app.post('/api/sessions', (req, res) => {
  console.log('POST /api/sessions called with body:', req.body);
  const { title } = req.body;
  const id = Date.now().toString();
  const prdPath = path.join('Documents', `PRD_${id}.md`);
  const conversationPath = path.join('Documents', `CONVO_${id}.md`);
  const initialAssistantMsg = {
    role: 'assistant',
    content: 'Welcome! Please provide a brief description of your project.'
  };
  const session = {
    id,
    title: title || `Session ${id}`,
    conversation: [initialAssistantMsg],
    prdDraft: '',
    prdPath,
    conversationPath,
    state: 'awaiting_project_description' // Ensure state is set for new sessions
  };
  // Write session file and fsync to ensure it is flushed to disk
  const sessionFilePath = path.join(sessionsDir, `${id}.json`);
  const fd = fs.openSync(sessionFilePath, 'w');
  fs.writeSync(fd, JSON.stringify(session, null, 2));
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.writeFileSync(path.join(__dirname, '..', prdPath), `# PRD for ${session.title}\n`);
  fs.writeFileSync(path.join(__dirname, '..', conversationPath), `# Conversation History for ${session.title}\n`);
  console.log('Session created with id:', session.id);
  res.status(201).json(session);
});

// Get a session by ID
app.get('/api/sessions/:id', (req, res) => {
  console.log('GET /api/sessions/' + req.params.id + ' called');
  const sessionFile = path.join(sessionsDir, `${req.params.id}.json`);
  if (!fs.existsSync(sessionFile)) return res.status(404).json({ error: 'Session not found' });
  const session = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
  // After fetching session:
  if (session) {
    console.log('Session found:', req.params.id);
  } else {
    console.error('Session NOT found:', req.params.id);
  }
  res.json(session);
});

// Add a message to a session
// Add logging to /api/sessions/:id/message endpoint
app.post('/api/sessions/:id/message', async (req, res) => {
  console.log('POST /api/sessions/' + req.params.id + '/message called with body:', req.body);
  const sessionFile = path.join(sessionsDir, `${req.params.id}.json`);
  if (!fs.existsSync(sessionFile)) return res.status(404).json({ error: 'Session not found' });
  const { role, content } = req.body;
  if (!role || !content) return res.status(400).json({ error: 'Missing role or content' });
  const session = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
  session.conversation = session.conversation || [];
  session.conversation.push({ role, content });
  fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));
  // --- Update conversation markdown file ---
  if (session.conversationPath) {
    const conversationAbsPath = path.join(__dirname, '..', session.conversationPath);
    const conversationMarkdown = generateConversationMarkdown(session);
    fs.writeFileSync(conversationAbsPath, conversationMarkdown);
  }
  // After processing, before sending response:
  let result;
  try {
    // Your message storing logic here, e.g.:
    // result = await storeMessage(req.params.id, req.body);
    // For now, just simulate success:
    result = { ok: true };
  } catch (err) {
    result = { error: err.message };
  }
  if (result && result.error) {
    console.error('Message error for session', req.params.id, ':', result.error);
  } else {
    console.log('Message stored for session', req.params.id);
  }
  res.json(result);
});

// Update PRD for a session
app.put('/api/sessions/:id/prd', (req, res) => {
  const sessionFile = path.join(sessionsDir, `${req.params.id}.json`);
  if (!fs.existsSync(sessionFile)) return res.status(404).json({ error: 'Session not found' });
  const { prdContent } = req.body;
  if (typeof prdContent !== 'string') return res.status(400).json({ error: 'Missing prdContent' });
  const session = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
  const prdAbsPath = path.join(__dirname, '..', session.prdPath);
  fs.writeFileSync(prdAbsPath, prdContent);
  session.prdDraft = prdContent;
  fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));
  res.json({ ok: true });
});

// Get PRD for a session (returns markdown)
app.get('/api/sessions/:id/prd', (req, res) => {
  const sessionFile = path.join(sessionsDir, `${req.params.id}.json`);
  if (!fs.existsSync(sessionFile)) return res.status(404).send('Session not found');
  const session = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
  const prdAbsPath = path.join(__dirname, '..', session.prdPath);
  if (!fs.existsSync(prdAbsPath)) return res.status(404).send('PRD not found');
  res.type('text/markdown');
  res.sendFile(prdAbsPath, err => {
    if (err) {
      res.status(500).send('Could not load PRD markdown.');
    }
  });
});

// Rename a session (update title)
app.put('/api/sessions/:id', (req, res) => {
  const sessionFile = path.join(sessionsDir, `${req.params.id}.json`);
  if (!fs.existsSync(sessionFile)) return res.status(404).json({ error: 'Session not found' });
  const { title } = req.body;
  if (!title) return res.status(400).json({ error: 'Missing title' });
  const session = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
  session.title = title;
  fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));
  res.json(session);
});

// Delete a session (and its PRD file)
app.delete('/api/sessions/:id', (req, res) => {
  const sessionFile = path.join(sessionsDir, `${req.params.id}.json`);
  if (!fs.existsSync(sessionFile)) return res.status(404).json({ error: 'Session not found' });
  const session = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
  // Delete PRD file if it exists
  const prdAbsPath = path.join(__dirname, '..', session.prdPath);
  if (fs.existsSync(prdAbsPath)) fs.unlinkSync(prdAbsPath);
  // Delete session file
  fs.unlinkSync(sessionFile);
  res.json({ ok: true });
});

// --- PRD API Endpoints ---

// Start PRD session
app.post('/api/prd/start', (req, res) => {
  const { projectDescription } = req.body;
  if (!projectDescription) {
    return res.status(400).json({ error: 'Missing project description.' });
  }
  const sessionId = createSession({ projectDescription });
  // Compose initial LLM prompt
  const prompt = `Let's begin your Product Requirements Document (PRD). Please provide any additional context or ask your first question.`;
  res.json({ sessionId, prompt });
});

// Helper: Generate markdown from conversation
function generateConversationMarkdown(session) {
  let md = `# Conversation History\n\n`;
  if (session.projectDescription) {
    md += `**Project Description:** ${session.projectDescription}\n\n`;
  }
  const messages = session.conversation || [];
  for (const msg of messages) {
    if (msg.role === 'user') {
      md += `**User:** ${msg.content}\n\n`;
    } else if (msg.role === 'assistant') {
      md += `**Assistant:** ${msg.content}\n\n`;
    }
  }
  return md;
}

// Helper: Generate PRD draft markdown (simple version)
function generatePrdDraftMarkdown(session) {
  let md = `# Product Requirements Document\n\n`;
  if (session.projectDescription) {
    md += `**Project Description:** ${session.projectDescription}\n\n`;
  }
  if (session.prdDraft) {
    md += session.prdDraft + '\n';
  }
  // Optionally, add more structure here
  return md;
}

// Answer PRD field and get next prompt/section
app.post('/api/prd/answer', async (req, res) => {
  const { sessionId, answer } = req.body;
  const session = getSession(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found.' });
  if (!Array.isArray(session.conversation)) session.conversation = [];
  session.conversation.push({ role: 'user', content: answer });

  // Read current PRD draft text
  const prdAbsPath = path.join(__dirname, '..', session.prdPath);
  let prdText = '';
  try {
    prdText = fs.readFileSync(prdAbsPath, 'utf-8');
  } catch (e) {
    prdText = '';
  }

  // Compose LLM input
  const systemPrompt = {
    role: 'system',
    content: 'You are an expert product manager helping a user fill out a Product Requirements Document (PRD). Respond conversationally, and if the user asks a question, answer it. If more PRD information is needed, ask the next most important question. If you are given a PRD draft, you may revise it as needed.'
  };
  const conversation = [systemPrompt, ...session.conversation];

  // Add PRD draft as context
  const llmInput = {
    conversation,
    prdDraft: prdText,
    latestUserInput: answer,
    llm: 'gpt-3.5-turbo',
  };

  try {
    const scriptPath = path.join(__dirname, '..', 'llm', 'conversation_flow.py');
    const scriptResult = await runLLMScript(scriptPath, llmInput);
    console.log('LLM scriptResult:', scriptResult); // DEBUG: log full LLM result
    const llmReply = scriptResult.reply || '';
    // Optionally, look for a new PRD draft in the LLM response
    const newPrdDraft = scriptResult.prdDraft || null;
    session.conversation.push({ role: 'assistant', content: llmReply });
    updateSession(sessionId, session);

    // Save proposed PRD draft to a temp file for user review
    if (newPrdDraft) {
      const tempPrdPath = path.join(__dirname, '..', 'Documents', `PRD_${sessionId}_temp.md`);
      fs.writeFileSync(tempPrdPath, newPrdDraft);
    }

    // Update conversation markdown file as before
    const conversationAbsPath = path.join(__dirname, '..', session.conversationPath);
    const conversationMarkdown = generateConversationMarkdown(session);
    fs.writeFileSync(conversationAbsPath, conversationMarkdown);

    if (llmReply.trim().toLowerCase().includes('prd complete')) {
      return res.json({ done: true, message: 'PRD complete!', conversation: session.conversation });
    }
    res.json({ prompt: llmReply, prdDraft: newPrdDraft || null });
  } catch (err) {
    // Extra logging for debugging
    console.error('Error in /api/prd/answer:', err);
    if (err && err.stdout) console.error('Python stdout:', err.stdout);
    if (err && err.stderr) console.error('Python stderr:', err.stderr);
    return res.status(500).json({ error: 'LLM error', details: err });
  }
});

// Get current PRD draft for a session
app.get('/api/prd/draft', (req, res) => {
  const { sessionId } = req.query;
  const session = getSession(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found.' });
  // Build simple Markdown draft
  let md = `# Product Requirements Document\n\n`;
  for (const section of PRD_SECTIONS) {
    md += `## ${section.name}\n`;
    for (const field of section.fields) {
      const val = session.answers[section.name]?.[field] || '[MISSING]';
      md += `- **${field}:** ${val}\n`;
    }
    md += '\n';
  }
  res.type('text/markdown').send(md);
});

// Get both main and temp PRD drafts for diff view
app.get('/api/sessions/:id/prd/compare', (req, res) => {
  const sessionFile = path.join(sessionsDir, `${req.params.id}.json`);
  if (!fs.existsSync(sessionFile)) return res.status(404).json({ error: 'Session not found' });
  const session = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
  const prdAbsPath = path.join(__dirname, '..', session.prdPath);
  let main = '';
  let temp = '';
  try {
    main = fs.readFileSync(prdAbsPath, 'utf-8');
  } catch {}
  const tempPath = path.join(__dirname, '..', 'Documents', `PRD_${req.params.id}_temp.md`);
  if (fs.existsSync(tempPath)) {
    try {
      temp = fs.readFileSync(tempPath, 'utf-8');
    } catch {}
  }
  res.json({ main, temp });
});

// Accept the temp PRD draft: overwrite main PRD and delete temp
app.post('/api/sessions/:id/prd/accept', (req, res) => {
  const sessionFile = path.join(sessionsDir, `${req.params.id}.json`);
  if (!fs.existsSync(sessionFile)) return res.status(404).json({ error: 'Session not found' });
  const session = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
  const prdAbsPath = path.join(__dirname, '..', session.prdPath);
  const tempPath = path.join(__dirname, '..', 'Documents', `PRD_${req.params.id}_temp.md`);
  if (!fs.existsSync(tempPath)) return res.status(400).json({ error: 'No temp PRD draft to accept' });
  const tempContent = fs.readFileSync(tempPath, 'utf-8');
  fs.writeFileSync(prdAbsPath, tempContent); // Overwrite main PRD
  session.prdDraft = tempContent;
  fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));
  fs.unlinkSync(tempPath); // Delete temp file
  res.json({ ok: true });
});

// Reject the temp PRD draft: just delete temp
app.post('/api/sessions/:id/prd/reject', (req, res) => {
  const tempPath = path.join(__dirname, '..', 'Documents', `PRD_${req.params.id}_temp.md`);
  if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  res.json({ ok: true });
});

// PRD diff endpoint (unified diff for session-specific PRD and temp draft)
app.get('/api/sessions/:id/prd/diff', (req, res) => {
  console.log(`[PRD DIFF] GET /api/sessions/${req.params.id}/prd/diff called at`, new Date().toISOString());
  const sessionId = req.params.id;
  const prdPath = path.join(__dirname, '..', 'Documents', `PRD_${sessionId}.md`);
  const tempPath = path.join(__dirname, '..', 'Documents', `PRD_${sessionId}_temp.md`);
  let oldText = '', newText = '';
  if (fs.existsSync(prdPath)) {
    oldText = fs.readFileSync(prdPath, 'utf-8');
  }
  if (fs.existsSync(tempPath)) {
    newText = fs.readFileSync(tempPath, 'utf-8');
  } else {
    // If no temp, show main PRD as both old and new (or new as blank for initial diff)
    newText = oldText; // or set to '' for blank diff
  }
  res.json({ oldText, newText });
});

// PRD merge endpoint (save mergedText as session PRD and remove temp draft)
app.post('/api/sessions/:id/prd/merge', (req, res) => {
  const sessionId = req.params.id;
  const { mergedText } = req.body;
  if (typeof mergedText !== 'string') {
    return res.status(400).json({ error: 'Missing mergedText' });
  }
  const prdPath = path.join(__dirname, '..', 'Documents', `PRD_${sessionId}.md`);
  const tempPath = path.join(__dirname, '..', 'Documents', `PRD_${sessionId}_temp.md`);
  fs.writeFileSync(prdPath, mergedText, 'utf-8');
  if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  // Also update session.prdDraft if session exists
  const sessionFile = path.join(sessionsDir, `${sessionId}.json`);
  if (fs.existsSync(sessionFile)) {
    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
    session.prdDraft = mergedText;
    fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));
  }
  res.json({ ok: true });
});

// Add global error and process event handlers for debugging
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
});
process.on('exit', (code) => {
  console.log('Process exit event with code:', code);
});
process.on('SIGTERM', () => {
  console.log('Received SIGTERM');
  process.exit(0);
});
process.on('SIGINT', () => {
  console.log('Received SIGINT');
  process.exit(0);
});

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
