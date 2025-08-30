const express = require('express');
const fetchModule = require('node-fetch');
const fetch = fetchModule.default || fetchModule;
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const runLLMScript = require('./runLLMScript');
const { PRD_SECTIONS, QUESTION_TEMPLATES } = require('./prdConfig');
const { createSession, getSession, updateSession } = require('./prdSessionStore');

const openaiApiKey = process.env.OPENAI_API_KEY;
const geminiApiKey = process.env.GEMINI_API_KEY;

const app = express();
app.use(express.json());

// Log server start
console.log('Backend server starting...');

// Consistent system prompt for chat replies (keeps assistant on-brief)
const REPLY_SYSTEM_PROMPT = (
  'You are an expert product manager and technical writer helping a user shape a PRD via conversation. ' +
  'Keep replies brief and actionable (2–5 sentences). Ask one focused question when key information is missing. ' +
  'Do not invent facts. Do not paste the entire PRD in chat replies; propose changes concisely and rely on the PRD draft process. '
);

// --- Conversation structure controls ---
const MAX_DEEP_DIVE_DEPTH = 2;
const MAX_TURNS_PER_FOCUS = 2;
const MAX_CONSECUTIVE_DIGRESSIONS = 2;
const MIN_CONTENT_LENGTH = 40; // characters threshold between weak and covered
const FACTS_THRESHOLD = 2; // number of facts before we summarize/confirm

// Parse PRD markdown into coverage map using PRD_SECTIONS
function parsePrdCoverage(prdMarkdown) {
  const lines = String(prdMarkdown || '').split(/\r?\n/);
  const sections = PRD_SECTIONS.map(s => ({ name: s.name, fields: { } }));
  // Build index of section headers
  const secIndex = new Map(PRD_SECTIONS.map((s, i) => [s.name, i]));
  let currentSectionIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const lh = lines[i].trim();
    // Match headings: ## Section Name
    const mHead = /^##\s+(.+?)\s*$/.exec(lh);
    if (mHead) {
      const idx = secIndex.has(mHead[1]) ? secIndex.get(mHead[1]) : -1;
      if (idx !== -1) currentSectionIdx = idx;
      continue;
    }
    // Match field bullets: - **Field:** value
    if (currentSectionIdx >= 0) {
      const mField = /^[-*]\s+\*\*(.+?)\s*:\*\*\s*(.*)$/.exec(lh);
      if (mField) {
        const fieldName = mField[1].trim();
        const value = (mField[2] || '').trim();
        sections[currentSectionIdx].fields[fieldName] = value;
      }
    }
  }
  // Compute status per configured field
  const coverage = sections.map((s, idx) => {
    const cfgFields = PRD_SECTIONS[idx].fields;
    const fields = {};
    cfgFields.forEach(f => {
      const val = s.fields[f];
      let status = 'missing';
      if (typeof val === 'string' && val.length > 0 && val !== '[MISSING]') {
        status = val.replace(/\*\*/g, '').trim().length >= MIN_CONTENT_LENGTH ? 'covered' : 'weak';
      }
      fields[f] = { status, value: val || '' };
    });
    return { name: s.name, fields };
  });
  return coverage;
}

function getNextFocus(coverage, cursor) {
  const totalSections = PRD_SECTIONS.length;
  let i = cursor?.sectionIndex || 0;
  let j = cursor?.fieldIndex || 0;
  // First pass: from cursor onwards
  for (let si = i; si < totalSections; si++) {
    const fields = PRD_SECTIONS[si].fields;
    for (let fj = si === i ? j : 0; fj < fields.length; fj++) {
      const f = fields[fj];
      const st = coverage[si]?.fields?.[f]?.status || 'missing';
      if (st === 'missing') return { sectionIndex: si, fieldIndex: fj, status: st };
    }
  }
  // Second pass: any weak
  for (let si = 0; si < totalSections; si++) {
    const fields = PRD_SECTIONS[si].fields;
    for (let fj = 0; fj < fields.length; fj++) {
      const f = fields[fj];
      const st = coverage[si]?.fields?.[f]?.status || 'missing';
      if (st === 'weak') return { sectionIndex: si, fieldIndex: fj, status: st };
    }
  }
  // Otherwise, stick with cursor (likely done)
  return { sectionIndex: cursor?.sectionIndex || 0, fieldIndex: cursor?.fieldIndex || 0, status: 'covered' };
}

function advanceCursor(cursor, coverage) {
  const next = getNextFocus(coverage, cursor);
  return { sectionIndex: next.sectionIndex, fieldIndex: next.fieldIndex };
}

function idxToNames(sectionIndex, fieldIndex) {
  const section = PRD_SECTIONS[sectionIndex] || PRD_SECTIONS[0];
  const sectionName = section?.name || '';
  const fieldName = (section?.fields || [])[fieldIndex] || '';
  return { sectionName, fieldName };
}

function detectIntent(text = '') {
  const t = String(text).toLowerCase();
  if (/(move on|next section|advance|skip)/.test(t)) return { type: 'advance' };
  if (/(iso|astm|iec|standard|standards)/.test(t)) return { type: 'standards' };
  if (/(example|examples|sample)/.test(t)) return { type: 'examples' };
  if (/(why|how|detail|deeper|explain|more)/.test(t)) return { type: 'deep_dive' };
  return { type: 'on_topic' };
}

function detectConfirmation(text = '') {
  const t = String(text).toLowerCase();
  return /(yes|looks good|sounds good|agree|approved|go ahead|apply|write it up|update the prd|confirm|that's correct|thats correct|correct|proceed)/.test(t);
}

function detectDisagree(text = '') {
  const t = String(text).toLowerCase();
  return /(no|not quite|disagree|change|adjust|revise|that's wrong|thats wrong|needs changes|edit|modify)/.test(t);
}

function notesKey(si, fi) { return `${si}:${fi}`; }

function addFactsToNotes(session, si, fi, facts = []) {
  if (!session) return;
  session.notes = session.notes || {};
  const key = notesKey(si, fi);
  const arr = Array.isArray(session.notes[key]) ? session.notes[key] : [];
  const set = new Set(arr);
  for (const f of facts) {
    const s = String(f || '').trim();
    if (s) set.add(s);
  }
  session.notes[key] = Array.from(set).slice(-20);
}

function getNotes(session, si, fi) {
  return (session && session.notes && session.notes[notesKey(si, fi)]) || [];
}

function pushFocus(session, type, topic) {
  session.cursor = session.cursor || { sectionIndex: 0, fieldIndex: 0 };
  session.focusStack = Array.isArray(session.focusStack) ? session.focusStack : [];
  const depth = session.focusStack.length;
  if (depth >= MAX_DEEP_DIVE_DEPTH || session.consecutiveDigressions >= MAX_CONSECUTIVE_DIGRESSIONS) return false;
  session.focusStack.push({ type, topic, turnsLeft: MAX_TURNS_PER_FOCUS, depth });
  session.consecutiveDigressions = (session.consecutiveDigressions || 0) + 1;
  return true;
}

function tickFocus(session) {
  if (!session.focusStack || session.focusStack.length === 0) {
    session.consecutiveDigressions = 0;
    return;
  }
  const top = session.focusStack[session.focusStack.length - 1];
  top.turnsLeft -= 1;
  if (top.turnsLeft <= 0) {
    session.focusStack.pop();
    if (session.focusStack.length === 0) session.consecutiveDigressions = 0;
  }
}

function buildStructureSystemMessage({ agenda, nextFocus, cursor, focusStack }) {
  const { sectionName: curSec, fieldName: curField } = idxToNames(cursor.sectionIndex, cursor.fieldIndex);
  const { sectionName: nextSec, fieldName: nextField } = idxToNames(nextFocus.sectionIndex, nextFocus.fieldIndex);
  const focusText = focusStack.length
    ? `Active focus: ${focusStack[focusStack.length-1].type} on ${focusStack[focusStack.length-1].topic} (turns left: ${focusStack[focusStack.length-1].turnsLeft}). `
    : '';
  return (
    `Agenda (keep headings stable): ${agenda.map(a=>`${a.name} [${a.fields.join(', ')}]`).join(' | ')}. ` +
    `Current cursor: ${curSec} → ${curField}. ` +
    `Next focus: ${nextSec} → ${nextField} (${nextFocus.status}). ` +
    focusText +
    `Rules: prioritize one focused question per turn; if in a deep dive/examples/standards focus, stay on that for at most ${MAX_TURNS_PER_FOCUS} turns then return to the agenda; ` +
    `after deep dives, bridge back to the agenda by asking about ${nextField}. Avoid copying the entire PRD in replies.`
  );
}

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
    // If a pending temp PRD exists, avoid drafting and steer user to review
    const tempPathExisting = path.join(__dirname, '..', 'Documents', `PRD_${sessionId}_temp.md`);
    const hasPendingTemp = fs.existsSync(tempPathExisting);
    // Initialize structure state
    session.cursor = session.cursor || { sectionIndex: 0, fieldIndex: 0 };
    session.focusStack = Array.isArray(session.focusStack) ? session.focusStack : [];
    session.consecutiveDigressions = session.consecutiveDigressions || 0;

    // Compute coverage and next focus from the ACCEPTED PRD on disk (not proposed draft)
    let acceptedPrd = '';
    try {
      acceptedPrd = fs.readFileSync(path.join(__dirname, '..', session.prdPath), 'utf-8');
    } catch {}
    const coveragePre = parsePrdCoverage(acceptedPrd);
    let nextFocus = getNextFocus(coveragePre, session.cursor);

    // Intent routing
    const intent = detectIntent(userInput);
    const curNames = idxToNames(session.cursor.sectionIndex, session.cursor.fieldIndex);
    if (intent.type === 'examples') pushFocus(session, 'examples', curNames.fieldName || curNames.sectionName);
    else if (intent.type === 'standards') pushFocus(session, 'standards', curNames.fieldName || curNames.sectionName);
    else if (intent.type === 'deep_dive') pushFocus(session, 'deep_dive', curNames.fieldName || curNames.sectionName);
    const userRequestedAdvance = intent.type === 'advance';

    // Confirmation handling
    const isConfirm = detectConfirmation(userInput);
    const isDisagree = detectDisagree(userInput);
    const awaiting = session.awaitingConfirmation;
    if (awaiting && isDisagree) {
      // Keep awaiting, we'll gather more
      session.awaitingConfirmation = awaiting;
    }

    // Build structure guidance system message (ephemeral)
    const agenda = PRD_SECTIONS.map(s => ({ name: s.name, fields: s.fields }));
    const structureMsg = buildStructureSystemMessage({ agenda, nextFocus, cursor: session.cursor, focusStack: session.focusStack });

    // Prepend system messages (ephemeral) to steer the assistant
    const replyConversation = [
      { role: 'system', content: REPLY_SYSTEM_PROMPT },
      { role: 'system', content: structureMsg },
      ...session.conversation,
    ];
    const scriptResult = await runLLMScript(scriptPath, {
      prompt: userInput,
      conversation: replyConversation,
      llm,
      // Anchor proposals to the accepted PRD on disk
      prdDraft: acceptedPrd || '',
      // Draft only after explicit confirmation, and never while a review is pending
      shouldDraft: Boolean(!hasPendingTemp && awaiting && isConfirm),
      // Lower temperature for PRD drafting to reduce arbitrary domain jumps
      temps: { reply: 0.6, draft: 0.2 },
      structure: {
        agenda,
        nextFocus,
        cursor: session.cursor,
        focusStack: session.focusStack,
        limits: { MAX_DEEP_DIVE_DEPTH, MAX_TURNS_PER_FOCUS, MAX_CONSECUTIVE_DIGRESSIONS }
      }
    });
    // Print whether scriptResult.prdDraft is truthy or not
    console.log('scriptResult.prdDraft is', scriptResult.prdDraft ? 'truthy' : 'falsy', '| Value:', scriptResult.prdDraft);
    // Planner decision + notes accumulation
    const planner = scriptResult.planner || {};
    const target = (Array.isArray(planner.targets) && planner.targets[0]) || { sectionIndex: nextFocus.sectionIndex, fieldIndex: nextFocus.fieldIndex };
    const extractedFacts = Array.isArray(scriptResult.facts) ? scriptResult.facts : [];
    try { console.log('[FACTS]', extractedFacts.length, extractedFacts); } catch {}
    // Determine facts strings to record (prefer exact_span then text)
    const factStrings = [];
    for (const f of extractedFacts) {
      if (!f) continue;
      const s = (typeof f.exact_span === 'string' && f.exact_span.trim()) ? f.exact_span.trim() : (typeof f.text === 'string' ? f.text.trim() : '');
      if (s) factStrings.push(s);
    }
    // Previous count for adaptive threshold
    const prevCount = getNotes(session, target.sectionIndex, target.fieldIndex).length;
    addFactsToNotes(session, target.sectionIndex, target.fieldIndex, planner.facts || []);
    addFactsToNotes(session, target.sectionIndex, target.fieldIndex, factStrings);
    const factsNow = getNotes(session, target.sectionIndex, target.fieldIndex);
    const newFactsAddedCount = Math.max(0, factsNow.length - prevCount);

    // Decide assistant content (summary gate or normal reply)
    let assistantContent = scriptResult.reply || '';
    const firstTurnForField = prevCount === 0;
    const shouldSummarize = !session.awaitingConfirmation && !hasPendingTemp && (
      planner.action === 'summarize' || planner.action === 'confirm_gate' ||
      (firstTurnForField && newFactsAddedCount >= 1) || (!firstTurnForField && factsNow.length >= FACTS_THRESHOLD)
    );
    if (hasPendingTemp) {
      assistantContent = 'You have pending PRD changes to review. Please accept or discard them before continuing.';
    } else if (shouldSummarize) {
      const names = idxToNames(target.sectionIndex, target.fieldIndex);
      const summaryText = (planner.summary && String(planner.summary).trim())
        ? planner.summary.trim()
        : `Here is my understanding so far for ${names.sectionName} → ${names.fieldName}:\n- ${factsNow.join('\n- ')}\n\nDoes this look right to include in the PRD?`;
      assistantContent = summaryText;
      session.awaitingConfirmation = {
        sectionIndex: target.sectionIndex,
        fieldIndex: target.fieldIndex,
        summaryText,
        createdAt: new Date().toISOString(),
      };
      session.lastSummaryAt = new Date().toISOString();
    } else if (awaiting && isConfirm && !hasPendingTemp) {
      // Clear awaiting on confirmation; drafting for this turn is already turned on
      session.awaitingConfirmation = null;
    }
    // Attach facts to the last user message for UI highlighting
    try {
      let idx = session.conversation.length - 1;
      while (idx >= 0 && session.conversation[idx].role !== 'user') idx--;
      if (idx >= 0) {
        session.conversation[idx].facts = extractedFacts;
      }
    } catch {}
    session.conversation.push({ role: 'assistant', content: assistantContent });
    // Normalize helper to reduce spurious diffs
    const normalizeMd = (s) => String(s || '')
      .replace(/\r\n/g, '\n')            // normalize EOLs
      .split('\n')
      .map(l => l.replace(/\s+$/,''))     // trim trailing spaces
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')       // collapse multiple blank lines
      .trim();

    // Only write temp PRD if the proposed draft differs from the ACCEPTED PRD
    const tempPrdPath = path.join(__dirname, '..', 'Documents', `PRD_${sessionId}_temp.md`);
    // Only consider explicit proposed text from this turn
    const proposed = typeof scriptResult.prdDraft === 'string' ? scriptResult.prdDraft : '';
    const nProposed = normalizeMd(proposed);
    const nAccepted = normalizeMd(acceptedPrd);
    let hasPrdChanges = Boolean(nProposed && nProposed !== nAccepted);
    if (hasPendingTemp) hasPrdChanges = true;
    if (hasPrdChanges) {
      fs.writeFileSync(tempPrdPath, proposed, 'utf-8');
    } else {
      // If identical, remove any existing temp to clear pending state
      try { if (fs.existsSync(tempPrdPath)) fs.unlinkSync(tempPrdPath); } catch {}
    }
    // Do not update session.prdDraft automatically; only update on accept/merge
    // Update structure state after reply — recompute from ACCEPTED PRD (unchanged until merge)
    try { acceptedPrd = fs.readFileSync(path.join(__dirname, '..', session.prdPath), 'utf-8'); } catch {}
    const coveragePost = parsePrdCoverage(acceptedPrd);
    const curFieldStatusPre = coveragePre[session.cursor.sectionIndex]?.fields?.[curNames.fieldName]?.status;
    const curFieldStatusPost = coveragePost[session.cursor.sectionIndex]?.fields?.[curNames.fieldName]?.status;
    // Improvement should only reflect accepted PRD changes (i.e., after merges)
    const improved = (curFieldStatusPre !== 'covered') && (curFieldStatusPost === 'covered');
    if (userRequestedAdvance || improved) {
      session.cursor = advanceCursor(session.cursor, coveragePost);
    }
    // Tick focus budget
    tickFocus(session);

    updateSession(sessionId, session);
    // Update conversation markdown file as well for transparency/export
    if (session.conversationPath) {
      try {
        const conversationAbsPath = path.join(__dirname, '..', session.conversationPath);
        const conversationMarkdown = generateConversationMarkdown(session);
        fs.writeFileSync(conversationAbsPath, conversationMarkdown);
      } catch (e) {
        console.warn('Failed to update conversation markdown for session', sessionId, e?.message || e);
      }
    }
    return res.json({ reply: scriptResult.reply, prdDraft: scriptResult.prdDraft, session, hasPrdChanges });
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
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  console.log('Session found:', req.params.id);
  res.json(session);
});

// Add a message to a session
// Add logging to /api/sessions/:id/message endpoint
app.post('/api/sessions/:id/message', async (req, res) => {
  console.log('POST /api/sessions/' + req.params.id + '/message called with body:', req.body);
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const { role, content } = req.body;
  if (!role || !content) return res.status(400).json({ error: 'Missing role or content' });
  session.conversation = session.conversation || [];
  session.conversation.push({ role, content });
  updateSession(req.params.id, session);
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
  const { prdContent } = req.body;
  if (typeof prdContent !== 'string') return res.status(400).json({ error: 'Missing prdContent' });
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const prdAbsPath = path.join(__dirname, '..', session.prdPath);
  fs.writeFileSync(prdAbsPath, prdContent);
  session.prdDraft = prdContent;
  updateSession(req.params.id, session);
  res.json({ ok: true });
});

// Get PRD for a session (returns markdown)
app.get('/api/sessions/:id/prd', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).send('Session not found');
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
  const { title } = req.body;
  if (!title) return res.status(400).json({ error: 'Missing title' });
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  session.title = title;
  updateSession(req.params.id, session);
  res.json(session);
});

// Delete a session (and its PRD file)
app.delete('/api/sessions/:id', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  // Delete PRD file if it exists
  const prdAbsPath = path.join(__dirname, '..', session.prdPath);
  if (fs.existsSync(prdAbsPath)) fs.unlinkSync(prdAbsPath);
  // Delete session file
  try {
    const sessionFile = path.join(sessionsDir, `${req.params.id}.json`);
    if (fs.existsSync(sessionFile)) fs.unlinkSync(sessionFile);
  } catch {}
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

    // Save proposed PRD draft to a temp file for user review (only if it differs from accepted PRD)
    if (newPrdDraft) {
      const tempPrdPath = path.join(__dirname, '..', 'Documents', `PRD_${sessionId}_temp.md`);
      const prdAbsPath = path.join(__dirname, '..', session.prdPath);
      let accepted = '';
      try { accepted = fs.readFileSync(prdAbsPath, 'utf-8'); } catch {}
      const normalizeMd = (s) => String(s || '')
        .replace(/\r\n/g, '\n')
        .split('\n').map(l => l.replace(/\s+$/,'')).join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      if (normalizeMd(newPrdDraft) && normalizeMd(newPrdDraft) !== normalizeMd(accepted)) {
        fs.writeFileSync(tempPrdPath, newPrdDraft);
      } else {
        try { if (fs.existsSync(tempPrdPath)) fs.unlinkSync(tempPrdPath); } catch {}
      }
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
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
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
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const prdAbsPath = path.join(__dirname, '..', session.prdPath);
  const tempPath = path.join(__dirname, '..', 'Documents', `PRD_${req.params.id}_temp.md`);
  if (!fs.existsSync(tempPath)) return res.status(400).json({ error: 'No temp PRD draft to accept' });
  const tempContent = fs.readFileSync(tempPath, 'utf-8');
  fs.writeFileSync(prdAbsPath, tempContent); // Overwrite main PRD
  session.prdDraft = tempContent;
  updateSession(req.params.id, session);
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
  const hasTemp = fs.existsSync(tempPath);
  if (hasTemp) {
    newText = fs.readFileSync(tempPath, 'utf-8');
  } else {
    // If no temp, show main PRD as both old and new (or new as blank for initial diff)
    newText = oldText; // or set to '' for blank diff
  }
  res.json({ oldText, newText, hasTemp });
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
