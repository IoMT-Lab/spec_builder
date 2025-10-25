const express = require('express');
const fetchModule = require('node-fetch');
const fetch = fetchModule.default || fetchModule;
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
require('dotenv').config();
const runLLMScript = require('./runLLMScript');
const { PRD_SECTIONS, QUESTION_TEMPLATES } = require('./prdConfig');
const { createSession, getSession, updateSession } = require('./prdSessionStore');
const demoStore = require('./demoStore');

const keepAlive = setInterval(() => {}, 1000);

const openaiApiKey = process.env.OPENAI_API_KEY;
const geminiApiKey = process.env.GEMINI_API_KEY;
const DEFAULT_OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
let ACTIVE_OPENAI_MODEL = DEFAULT_OPENAI_MODEL;
if (process.env.UI_DEFAULT_LLM && process.env.UI_DEFAULT_LLM.trim()) {
  ACTIVE_OPENAI_MODEL = process.env.UI_DEFAULT_LLM.trim();
}
let OPENAI_PROBE = { ok: false, error: 'not probed yet', tried: [], chosen: null };

const ROOT_DIR = path.join(__dirname, '..');
const SCRIPTS_DIR = path.join(ROOT_DIR, 'scripts');
const SCENARIOS_DIR = path.join(ROOT_DIR, 'scenarios');
const CODE_MAX_CHARS_PER_FILE = Math.max(parseInt(process.env.CODE_MAX_CHARS_PER_FILE || '40000', 10) || 40000, 2000);
const CODE_MAX_SELECTED_FILES = Math.max(parseInt(process.env.CODE_MAX_SELECTED_FILES || '6', 10) || 6, 1);
const STRICT_TEST_MODE = String(process.env.CODE_TEST_STRICT_MODE || '0').toLowerCase() !== '0';
const HARDWARE_REGEXES = [
  /\bPD_[A-Za-z0-9_]+\b/,
  /\bHAL_[A-Za-z0-9_]+\b/,
  /\bI2C_[A-Za-z0-9_]+\b/,
  /\bGPIO_[A-Za-z0-9_]+\b/,
  /\bINTERRUPT\b/i,
  /\bTHRESHOLD\b/i,
  /\bLED\b/i,
  /\bVALID\b/i,
  /\bMEASURE\b/i,
  /\bFAULT\b/i,
  /\bTIMEOUT\b/i
];
const DEFAULT_TEST_TARGETS = [
  {
    exts: ['c', 'h'],
    path: 'tests/generated_tests.c',
    language: 'c',
    framework: 'unity',
    instructions: 'Use Unity-style C tests with setUp/tearDown and TEST_ASSERT macros.'
  },
  {
    exts: ['cpp', 'cc', 'hpp', 'hh'],
    path: 'tests/generated_tests.cpp',
    language: 'cpp',
    framework: 'gtest',
    instructions: 'Use GoogleTest (TEST / TEST_F macros).'
  },
  {
    exts: ['py'],
    path: 'tests/test_generated.py',
    language: 'python',
    framework: 'pytest',
    instructions: 'Use pytest style functions prefixed with test_ and simple asserts.'
  },
  {
    exts: ['js', 'jsx', 'ts', 'tsx'],
    path: '__tests__/generated.test.js',
    language: 'javascript',
    framework: 'jest',
    instructions: 'Use Jest (describe/it) and expect assertions.'
  }
];

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

function normalizeDemoInput(str) {
  return String(str || '').trim().replace(/\s+/g, ' ');
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
// Code jobs directory
const codeJobsDir = path.join(__dirname, '..', 'Documents', 'code_jobs');
if (!fs.existsSync(codeJobsDir)) fs.mkdirSync(codeJobsDir, { recursive: true });

// Utility to load all sessions
function listSessions() {
  return fs.readdirSync(sessionsDir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const data = fs.readFileSync(path.join(sessionsDir, f), 'utf-8');
      return JSON.parse(data);
    });
}

// --- Health utilities ---
async function probeModel(modelId) {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${openaiApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: modelId, input: 'ping' })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'OpenAI API error');
  return true;
}

async function chooseOpenAIModel() {
  if (!openaiApiKey) {
    OPENAI_PROBE = { ok: false, error: 'No OpenAI API key set', tried: [], chosen: null };
    return OPENAI_PROBE;
  }
  const candidates = Array.from(new Set([
    DEFAULT_OPENAI_MODEL,
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-5',
    'gpt-5-nano',
  ])).filter(Boolean);
  const tried = [];
  for (const m of candidates) {
    try {
      await probeModel(m);
      ACTIVE_OPENAI_MODEL = m;
      OPENAI_PROBE = { ok: true, error: null, tried, chosen: m };
      return OPENAI_PROBE;
    } catch (e) {
      tried.push({ model: m, error: e.message });
    }
  }
  OPENAI_PROBE = { ok: false, error: tried[tried.length - 1]?.error || 'All probes failed', tried, chosen: null };
  return OPENAI_PROBE;
}

async function probeOpenAIResponses() {
  // Ensure we have chosen a working model if possible
  if (!OPENAI_PROBE.ok) await chooseOpenAIModel();
  return OPENAI_PROBE.ok
    ? { ok: true, model: ACTIVE_OPENAI_MODEL }
    : { ok: false, error: OPENAI_PROBE.error, tried: OPENAI_PROBE.tried };
}

// Health endpoint: checks env, OpenAI model, and Python script invocation
app.get('/api/health', async (req, res) => {
  const env = {
    OPENAI_API_KEY: Boolean(openaiApiKey),
    OPENAI_MODEL: DEFAULT_OPENAI_MODEL,
  };
  const openai = await probeOpenAIResponses();
  // Probe Python by running the script with a no-op (shouldDraft: false)
  let python = { ok: true };
  try {
    const scriptPath = path.join(__dirname, '..', 'llm', 'conversation_flow.py');
    const result = await runLLMScript(scriptPath, {
      prompt: 'ping',
      conversation: [{ role: 'user', content: 'ping' }],
      llm: openai.ok ? DEFAULT_OPENAI_MODEL : 'gpt-3.5-turbo',
      prdDraft: '',
      shouldDraft: false,
      structure: { agenda: [], nextFocus: { sectionIndex: 0, fieldIndex: 0 }, cursor: { sectionIndex: 0, fieldIndex: 0 }, focusStack: [] },
      temps: { reply: 0.0, draft: 0.0 }
    });
    python = { ok: true, reply: result.reply ? true : false };
  } catch (e) {
    python = { ok: false, error: e.message || e };
  }
  const ok = env.OPENAI_API_KEY && openai.ok && python.ok;
  res.json({ ok, env, openai, python, activeModel: openai.model || null });
});

app.get('/api/demos', (req, res) => {
  try {
    res.json({ demos: demoStore.listDemos() });
  } catch (err) {
    console.error('Failed to list demos:', err);
    res.status(500).json({ error: 'Failed to list demos' });
  }
});

// LLM API endpoint (stateful, session-based)
app.post('/api/llm', async (req, res) => {
  console.log('POST /api/llm called with body:', req.body);
  const sessionId = req.body.sessionId;
  let llm = req.body.llm;
  // Map provider aliases to concrete model IDs
  if (!llm || llm === 'openai' || llm === 'gpt5' || llm === 'gpt-5') llm = ACTIVE_OPENAI_MODEL;
  if (llm === 'gemini') llm = 'gemini-pro';
  const userInput = typeof req.body.input === 'string' ? req.body.input : '';
  // Structured confirm flag (frontend can send { confirm: true }) to avoid relying on text heuristics
  const structuredConfirm = req.body && (req.body.confirm === true || String(req.body.confirm) === 'true');
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
    // Hard gate: ensure model probe succeeded when using OpenAI
    if (llm !== 'gemini-pro') {
      const probe = await probeOpenAIResponses();
      if (!probe.ok) {
        return res.status(503).json({ error: 'LLM unavailable', details: probe });
      }
      llm = probe.model; // ensure we pass the active working model
    }
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
    const isConfirm = structuredConfirm || detectConfirmation(userInput);
    const isDisagree = detectDisagree(userInput);
    const awaiting = session.awaitingConfirmation;
    if (awaiting && isDisagree) {
      // Keep awaiting, we'll gather more
      session.awaitingConfirmation = awaiting;
    }

    const prdAbsPath = path.join(__dirname, '..', session.prdPath);
    const conversationAbsPath = path.join(__dirname, '..', session.conversationPath);

    if (session.demo && session.demo.name && !session.demo.breakout) {
      const demo = demoStore.getDemo(session.demo.name);
      if (!demo) {
        session.demo.breakout = true;
        console.warn('[DEMO] Demo data missing; falling back to live LLM.');
      } else {
        const step = Number(session.demo.step || 0);
        const normalizedInput = normalizeDemoInput(userInput);
        const expected = demo.conversation[step];
        if (expected && expected.role === 'user' && normalizeDemoInput(expected.content) === normalizedInput) {
          let currentPrd = acceptedPrd;
          if (demo.snapshots[step + 1]) {
            currentPrd = demo.snapshots[step + 1];
            fs.writeFileSync(prdAbsPath, currentPrd);
          }
          session.demo.step = step + 1;
          const replies = [];
          while (session.demo.step < demo.conversation.length) {
            const entry = demo.conversation[session.demo.step];
            if (entry.role !== 'assistant') break;
            replies.push(entry.content);
            session.conversation.push({ role: 'assistant', content: entry.content });
            session.demo.step += 1;
            if (demo.snapshots[session.demo.step]) {
              currentPrd = demo.snapshots[session.demo.step];
              fs.writeFileSync(prdAbsPath, currentPrd);
            }
          }
          const replyText = replies.length ? replies.join('\n\n') : '';
          let nextDemoPrompt = null;
          if (session.demo.step < demo.conversation.length) {
            const nextEntry = demo.conversation[session.demo.step];
            if (nextEntry.role === 'user') {
              nextDemoPrompt = nextEntry.content;
            }
          }
          try { if (fs.existsSync(tempPathExisting)) fs.unlinkSync(tempPathExisting); } catch {}
          const conversationMarkdown = generateConversationMarkdown(session);
          fs.writeFileSync(conversationAbsPath, conversationMarkdown);
          updateSession(sessionId, session);
          return res.json({
            reply: replyText,
            prdDraft: null,
            session,
            hasPrdChanges: false,
            demo: { breakout: false, nextPrompt: nextDemoPrompt }
          });
        } else {
          session.demo.breakout = true;
          console.log('[DEMO] Input did not match scripted step; switching to live mode.');
        }
      }
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
      llm, // model id like 'gpt-5' or 'gemini-pro'
      // Anchor proposals to the accepted PRD on disk
      prdDraft: acceptedPrd || '',
      // Draft only after explicit confirmation, and never while a review is pending
      shouldDraft: Boolean(!hasPendingTemp && (!awaiting || isConfirm)),
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
    // Build a resilient list of facts to attach for UI highlighting.
    // Start with structured facts from the extractor, then fall back to planner facts
    // and any strings we derived above. This ensures the UI can highlight even when
    // the extractor returns empty or paraphrased spans.
    const highlightFacts = [];
    const seen = new Set();
    const pushFact = (t) => {
      const key = String(t || '').trim().toLowerCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      highlightFacts.push({ text: t, exact_span: t });
    };
    // 1) Keep original structured facts first (preserve any attributes if present)
    for (const f of extractedFacts) {
      if (!f) continue;
      const base = (typeof f.exact_span === 'string' && f.exact_span.trim()) ? f.exact_span.trim() : (typeof f.text === 'string' ? f.text.trim() : '');
      if (base) {
        const key = base.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          // keep the extractor's object as-is for richer UI later
          highlightFacts.push(f);
        }
      }
    }
    // 2) Planner-provided fact strings
    if (Array.isArray(planner.facts)) {
      for (const s of planner.facts) pushFact(s);
    }
    // 3) Any additional derived strings (from exact spans)
    for (const s of factStrings) pushFact(s);
    // Previous count for adaptive threshold
    const prevCount = getNotes(session, target.sectionIndex, target.fieldIndex).length;
    // Heuristic fallback: if we have no extracted/planner facts on the first turn for this field,
    // seed with a concise snippet of the user's input so the summary gate can fire.
    if ((!Array.isArray(planner.facts) || planner.facts.length === 0) && factStrings.length === 0 && prevCount === 0) {
      const seed = String(userInput || '').trim().replace(/\s+/g, ' ').slice(0, 140);
      if (seed) factStrings.push(seed);
    }
    addFactsToNotes(session, target.sectionIndex, target.fieldIndex, planner.facts || []);
    addFactsToNotes(session, target.sectionIndex, target.fieldIndex, factStrings);
    const factsNow = getNotes(session, target.sectionIndex, target.fieldIndex);
    const newFactsAddedCount = Math.max(0, factsNow.length - prevCount);

  // Decide assistant content (summary gate or normal reply)
  let assistantContent = scriptResult.reply || '';
  // If we set awaitingConfirmation this turn, hold any proposed PRD draft instead of writing it to disk
  let setAwaitingThisTurn = false;
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
      // remember we set awaitingConfirmation this turn so we can avoid writing a temp PRD
      setAwaitingThisTurn = true;
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
        session.conversation[idx].facts = highlightFacts;
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

    // Flush any previously held pending draft if the user confirmed this turn
    let flushedPending = false;
    try {
      if (session.pendingPrdDraft && (isConfirm || !session.awaitingConfirmation)) {
        const pendingNorm = normalizeMd(session.pendingPrdDraft || '');
        if (pendingNorm && pendingNorm !== nAccepted) {
          fs.writeFileSync(tempPrdPath, session.pendingPrdDraft, 'utf-8');
          flushedPending = true;
        }
        // clear the held draft after attempting to flush
        delete session.pendingPrdDraft;
      }
    } catch (e) {
      console.warn('Failed flushing pendingPrdDraft for session', sessionId, e?.message || e);
    }

    // If we have changes from this turn, either write them now or hold them if we just asked for confirmation
    let heldPrd = false;
    if (hasPrdChanges) {
      if (!setAwaitingThisTurn) {
        // Normal path: write the temp PRD immediately
        fs.writeFileSync(tempPrdPath, proposed, 'utf-8');
      } else {
        // We just asked for confirmation this turn — hold the proposed draft in session until user confirms
        try {
          session.pendingPrdDraft = proposed;
          heldPrd = true;
        } catch (e) {
          console.warn('Failed to store pendingPrdDraft in session', sessionId, e?.message || e);
        }
      }
    } else {
      // If identical, remove any existing temp to clear pending state (but don't remove held pending draft)
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
    // Include lightweight diagnostics for the UI
    const diagnostics = {
      model: llm,
      factsCount: Array.isArray(extractedFacts) ? extractedFacts.length : 0,
      awaitingConfirmation: Boolean(session.awaitingConfirmation),
    };
    let demoPayload = null;
    if (session.demo && session.demo.name) {
      demoPayload = {
        name: session.demo.name,
        breakout: Boolean(session.demo.breakout)
      };
      if (!session.demo.breakout) {
        const demo = demoStore.getDemo(session.demo.name);
        if (demo && session.demo.step < demo.conversation.length) {
          const nextEntry = demo.conversation[session.demo.step];
          if (nextEntry && nextEntry.role === 'user') {
            demoPayload.nextPrompt = nextEntry.content;
          }
        }
      }
    }
    return res.json({
      reply: scriptResult.reply,
      prdDraft: scriptResult.prdDraft,
      session,
      hasPrdChanges,
      diagnostics,
      demo: demoPayload,
      heldPrd: Boolean(heldPrd),
      flushedPending: Boolean(flushedPending)
    });
  } catch (error) {
    return res.status(500).json({ error: 'LLM script error', details: error });
  }
});

// Endpoint to check API key and model access
app.post('/api/llm/check', async (req, res) => {
  const raw = req.body.llm;
  const provider = (raw == null ? '' : String(raw)).toLowerCase();
  try {
    // Treat any non-gemini value as OpenAI/Responses by default
    if (provider !== 'gemini') {
      if (!openaiApiKey) return res.json({ ok: false, error: 'No OpenAI API key set' });
      // Responses API probe
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${openaiApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ model: DEFAULT_OPENAI_MODEL, input: 'ping' })
      });
      const data = await response.json();
      if (!response.ok) {
        return res.json({ ok: false, error: data.error?.message || 'OpenAI API error' });
      }
      return res.json({ ok: true, model: DEFAULT_OPENAI_MODEL });
    } else {
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
      return res.json({ ok: true, model: 'gemini-pro' });
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
  res.set('Cache-Control', 'no-store');
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
  const { title, demoName } = req.body || {};
  const id = Date.now().toString();
  const prdPath = path.join('Documents', `PRD_${id}.md`);
  const conversationPath = path.join('Documents', `CONVO_${id}.md`);
  const prdAbsPath = path.join(__dirname, '..', prdPath);
  const conversationAbsPath = path.join(__dirname, '..', conversationPath);
  const session = {
    id,
    title: title || `Session ${id}`,
    conversation: [],
    prdDraft: '',
    prdPath,
    conversationPath,
    state: 'awaiting_project_description',
    demo: null,
  };

  let prdContent = `# PRD for ${session.title}\n`;
  let nextDemoPrompt = null;

  if (demoName) {
    const demo = demoStore.getDemo(demoName);
    if (!demo) {
      return res.status(400).json({ error: `Demo "${demoName}" not found` });
    }
    session.demo = { name: demoName, step: 0, breakout: false };
    if (demo.snapshots.length > 0) {
      prdContent = demo.snapshots[0];
    }

    // Auto-play any leading assistant messages
    while (session.demo.step < demo.conversation.length) {
      const entry = demo.conversation[session.demo.step];
      if (entry.role !== 'assistant') break;
      session.conversation.push({ role: 'assistant', content: entry.content });
      session.demo.step += 1;
      if (demo.snapshots[session.demo.step]) {
        prdContent = demo.snapshots[session.demo.step];
      }
    }

    if (session.demo.step < demo.conversation.length) {
      const nextEntry = demo.conversation[session.demo.step];
      if (nextEntry.role === 'user') {
        nextDemoPrompt = nextEntry.content;
      }
    }
  } else {
    const initialAssistantMsg = {
      role: 'assistant',
      content: 'Welcome! Please provide a brief description of your project.'
    };
    session.conversation.push(initialAssistantMsg);
  }

  if (!fs.existsSync(path.dirname(prdAbsPath))) fs.mkdirSync(path.dirname(prdAbsPath), { recursive: true });
  fs.writeFileSync(prdAbsPath, prdContent);
  const conversationMarkdown = generateConversationMarkdown(session);
  fs.writeFileSync(conversationAbsPath, conversationMarkdown);

  // Persist session file
  const sessionFilePath = path.join(sessionsDir, `${id}.json`);
  const fd = fs.openSync(sessionFilePath, 'w');
  fs.writeSync(fd, JSON.stringify(session, null, 2));
  fs.fsyncSync(fd);
  fs.closeSync(fd);

  console.log('Session created with id:', session.id, 'demo=', session.demo?.name || null);
  res.status(201).json({ ...session, demoNextPrompt: nextDemoPrompt });
});

// Get a session by ID
app.get('/api/sessions/:id', (req, res) => {
  console.log('GET /api/sessions/' + req.params.id + ' called');
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  console.log('Session found:', req.params.id);
  res.json(session);
});

function runAutodriveScenario({ scenarioPath, title, baseUrl }) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(SCRIPTS_DIR, 'autodrive.mjs');
    if (!fs.existsSync(scriptPath)) {
      return reject(new Error('autodrive script not found'));
    }
    const args = [scriptPath];
    if (title && String(title).trim()) {
      args.push('--title', String(title).trim());
    }
    args.push(scenarioPath);
    const child = spawn(process.execPath, args, {
      cwd: ROOT_DIR,
      env: { ...process.env, BASE_URL: baseUrl }
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) {
        const err = new Error(`autodrive exited with code ${code}`);
        err.details = { stdout, stderr };
        return reject(err);
      }
      const match = stdout.match(/\[AUTO\]\s+Created session\s+(\d+)/);
      resolve({
        sessionId: match ? match[1] : null,
        stdout,
        stderr
      });
    });
  });
}

app.post('/api/sessions/autodrive', async (req, res) => {
  try {
    const { scenario, title } = req.body || {};
    const scenarioName = String(scenario || 'photo_detector_tests.txt').trim();
    const scenarioPath = path.resolve(SCENARIOS_DIR, scenarioName);
    if (!scenarioName) {
      return res.status(400).json({ error: 'Scenario name is required' });
    }
    if (!scenarioPath.startsWith(SCENARIOS_DIR)) {
      return res.status(400).json({ error: 'Invalid scenario path' });
    }
    if (!fs.existsSync(scenarioPath)) {
      return res.status(404).json({ error: `Scenario file not found: ${scenarioName}` });
    }
    const port = Number(process.env.PORT || 4000);
    const baseUrl = process.env.BASE_URL || `http://127.0.0.1:${port}`;
    const result = await runAutodriveScenario({ scenarioPath, title, baseUrl });
    let session = null;
    if (result.sessionId) {
      session = getSession(result.sessionId) || null;
    }
    res.json({
      ok: true,
      sessionId: result.sessionId,
      session,
      logs: (result.stdout || '').split('\n').slice(-40).join('\n'), // return tail for context
      stderr: result.stderr
    });
  } catch (err) {
    console.error('autodrive scenario failed:', err.details || err);
    res.status(500).json({
      error: err.message || 'autodrive failed',
      details: err.details || null
    });
  }
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
  res.set('Cache-Control', 'no-store');
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
  res.set('Cache-Control', 'no-store');
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
  // Create a timestamped snapshot of the newly accepted PRD for history/demo purposes
  try {
    const versionsDir = path.join(__dirname, '..', 'Documents', 'prd_versions');
    if (!fs.existsSync(versionsDir)) fs.mkdirSync(versionsDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const snapName = `PRD_${req.params.id}_${ts}.md`;
    const snapPath = path.join(versionsDir, snapName);
    const header = `<!-- PRD snapshot for session ${req.params.id} createdAt: ${new Date().toISOString()} -->\n\n`;
    fs.writeFileSync(snapPath, header + tempContent, 'utf-8');
  } catch (e) {
    console.warn('Failed to write PRD snapshot on accept for session', req.params.id, e?.message || e);
  }
  try { fs.unlinkSync(tempPath); } catch (e) { /* non-fatal */ }
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
  try {
    console.log('[PRD DIFF] hasTemp=%s oldLen=%d newLen=%d', hasTemp, oldText.length, newText.length);
  } catch {}
  res.set('Cache-Control', 'no-store');
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
  try {
    console.log('[PRD MERGE] Saved mergedText length=%d and removed temp=%s', mergedText.length, fs.existsSync(tempPath) ? 'false' : 'true');
  } catch {}
  // Also update session.prdDraft if session exists
  const sessionFile = path.join(sessionsDir, `${sessionId}.json`);
  if (fs.existsSync(sessionFile)) {
    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
    session.prdDraft = mergedText;
    fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));
  }
  // Write a snapshot for the merged PRD version so demos can access historical versions
  try {
    const versionsDir = path.join(__dirname, '..', 'Documents', 'prd_versions');
    if (!fs.existsSync(versionsDir)) fs.mkdirSync(versionsDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const snapName = `PRD_${sessionId}_${ts}.md`;
    const snapPath = path.join(versionsDir, snapName);
    const header = `<!-- PRD snapshot (merged) for session ${sessionId} createdAt: ${new Date().toISOString()} -->\n\n`;
    fs.writeFileSync(snapPath, header + mergedText, 'utf-8');
  } catch (e) {
    console.warn('Failed to write PRD snapshot on merge for session', sessionId, e?.message || e);
  }
  res.json({ ok: true });
});

// --- Code Jobs (MVP scaffolding) ---
function isTextLike(file) {
  const ext = (file.split('.').pop() || '').toLowerCase();
  const allow = new Set(['js','jsx','ts','tsx','json','md','py','rb','go','java','cs','c','h','hpp','cpp','yaml','yml','toml','ini','sh','bash','zsh','cfg','txt','rs','kt','swift','php','html','css','sass','scss']);
  return allow.has(ext);
}
function shouldIgnore(rel) {
  const parts = rel.split(path.sep);
  if (parts.includes('node_modules')) return true;
  if (parts.includes('.git')) return true;
  if (parts.includes('dist') || parts.includes('build')) return true;
  return false;
}
function walkFiles(root) {
  const out = [];
  const stack = ['.'];
  while (stack.length) {
    const rel = stack.pop();
    const abs = path.join(root, rel);
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    if (st.isDirectory()) {
      if (shouldIgnore(rel)) continue;
      const items = fs.readdirSync(abs);
      for (const it of items) stack.push(path.join(rel, it));
    } else {
      if (shouldIgnore(rel)) continue;
      out.push({ rel, abs, size: st.size });
    }
  }
  return out;
}



function summarizeHardwareSignals(files = []) {
  const apiTokens = new Set();
  const constantTokens = new Set();
  for (const f of files) {
    const content = String(f.content || '');
    const apiMatches = content.match(/\b(?:HAL_|I2C_|GPIO_|SPI_|ADC_|UART_|DMA_|PWM_|TIM_)[A-Z0-9_]+\b/g);
    if (apiMatches) apiMatches.forEach(t => apiTokens.add(t));
    const constMatches = content.match(/\b0x[0-9a-fA-F]{2,}\b/g);
    if (constMatches) constMatches.slice(0, 20).forEach(t => constantTokens.add(t));
  }
  const parts = [];
  if (apiTokens.size) {
    parts.push('Hardware APIs: ' + Array.from(apiTokens).slice(0, 12).join(', '));
  }
  if (constantTokens.size) {
    parts.push('Register constants: ' + Array.from(constantTokens).slice(0, 8).join(', '));
  }
  return parts.join('\n');
}

function extractPrdHighlights(prdText = '') {
  const lines = String(prdText || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const highlights = [];
  const keyPattern = /(latency|throughput|performance|fault|error|timeout|safety|sensor|calibration|startup|recovery|accuracy|compliance)/i;
  for (const line of lines) {
    if (/^[-*]/.test(line) && line.length <= 200) {
      highlights.push(line.replace(/^[-*]\s*/, ''));
    } else if (keyPattern.test(line) && line.length <= 180) {
      highlights.push(line);
    }
    if (highlights.length >= 8) break;
  }
  return highlights.join('\n');
}

function extractInsightKeywords(insights = '') {
  return String(insights || '')
    .toLowerCase()
    .split(/\W+/)
    .filter(w => w && w.length >= 4)
    .slice(0, 24);
}

function buildFallbackPrompt(prdText = '') {
  const lines = String(prdText || '').split(/\r?\n/);
  const bullets = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('-') || trimmed.startsWith('*')) {
      bullets.push(trimmed.replace(/^[-*]\s*/, ''));
    }
    if (bullets.length >= 6) break;
  }
  const summary = bullets.length
    ? bullets.join('; ')
    : lines.filter(l => l.trim()).slice(0, 5).join(' ');
  return (
    'Generate realistic hardware-focused automated tests that cover nominal behaviour, ' +
    'failure paths, timeouts, and misconfiguration scenarios. ' +
    'Respect the following requirements: ' + summary
  ).slice(0, 600);
}

function prioritizeFileContent(content, insightKeywords = []) {
  if (typeof content !== 'string') return '';
  const limit = CODE_MAX_CHARS_PER_FILE;
  if (content.length <= limit) return content;
  const lines = content.split(/\r?\n/);
  const lowerKeywords = Array.isArray(insightKeywords)
    ? insightKeywords.map(k => String(k || '').toLowerCase()).filter(Boolean)
    : [];
  const matchedIndices = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let matched = HARDWARE_REGEXES.some(re => re.test(line));
    if (!matched && lowerKeywords.length) {
      const lower = line.toLowerCase();
      matched = lowerKeywords.some(word => lower.includes(word));
    }
    if (matched) matchedIndices.push(i);
  }
  const sections = [];
  const prelude = lines.slice(0, 80).join('\n');
  if (prelude) sections.push(prelude);
  if (matchedIndices.length) {
    matchedIndices.sort((a, b) => a - b);
    const ranges = [];
    let currentStart = null;
    let currentEnd = null;
    matchedIndices.forEach(idx => {
      const start = Math.max(0, idx - 20);
      const end = Math.min(lines.length, idx + 40);
      if (currentStart === null) {
        currentStart = start;
        currentEnd = end;
        return;
      }
      if (start <= currentEnd + 5) {
        currentEnd = Math.max(currentEnd, end);
      } else {
        ranges.push([currentStart, currentEnd]);
        currentStart = start;
        currentEnd = end;
      }
    });
    if (currentStart !== null) ranges.push([currentStart, currentEnd]);
    ranges.forEach(([start, end]) => {
      sections.push(lines.slice(start, end).join('\n'));
    });
  }
  if (sections.length < 2) {
    const tail = lines.slice(-80).join('\n');
    if (tail) sections.push(tail);
  }
  let combined = sections.join('\n\n');
  if (combined.length > limit) combined = combined.slice(0, limit);
  return combined || content.slice(0, limit);
}



function pickTestTarget(chunkFiles) {
  const counts = new Map();
  for (const f of chunkFiles) {
    const extMatch = /\.([a-z0-9]+)$/i.exec(f.path || '');
    if (!extMatch) continue;
    const ext = extMatch[1].toLowerCase();
    counts.set(ext, (counts.get(ext) || 0) + 1);
  }
  let chosen = null;
  if (counts.size) {
    const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [ext] of ordered) {
      const target = DEFAULT_TEST_TARGETS.find(t => t.exts.includes(ext));
      if (target) {
        chosen = target;
        break;
      }
    }
  }
  if (!chosen) {
    chosen = {
      path: 'tests/generated_tests.txt',
      language: 'text',
      framework: '',
      instructions: 'Write plain text test notes.'
    };
  }
  return { ...chosen };
}

function createHttpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function resolveCodeRoot(codeRoot) {
  if (!codeRoot) throw createHttpError(400, 'Missing codeRoot');
  const raw = String(codeRoot);
  const expanded = raw.replace(/^~(?=$|\/)/, os.homedir());
  const root = path.resolve(expanded);
  if (!fs.existsSync(root)) throw createHttpError(400, 'codeRoot does not exist');
  try {
    if (!fs.statSync(root).isDirectory()) {
      throw createHttpError(400, 'codeRoot is not a directory');
    }
  } catch (err) {
    if (err && err.status) throw err;
    throw createHttpError(400, 'codeRoot is not a directory');
  }
  const allowed = (process.env.CODE_ALLOWED_ROOTS || '').split(':').filter(Boolean);
  if (allowed.length && !allowed.some(a => root.startsWith(path.resolve(a)))) {
    throw createHttpError(400, 'codeRoot not in allowed roots');
  }
  return root;
}

function suggestFilesForTesting(files = []) {
  const selected = [];
  const seen = new Set();
  const pushUnique = (path) => {
    if (!path || seen.has(path)) return;
    seen.add(path);
    selected.push(path);
  };
  const testHints = /(test|spec|fixture|unit)/i;
  const codeExts = new Set(['c','cc','cpp','h','hpp','hh','py','js','jsx','ts','tsx','java','kt','go','rb','rs']);
  for (const f of files) {
    const rel = String(f.path || '');
    if (!rel) continue;
    const lower = rel.toLowerCase();
    if (testHints.test(lower)) pushUnique(rel);
  }
  if (selected.length < 3) {
    for (const f of files) {
      const rel = String(f.path || '');
      if (!rel) continue;
      const lower = rel.toLowerCase();
      const extMatch = /\.([a-z0-9]+)$/.exec(lower);
      if (extMatch && codeExts.has(extMatch[1])) pushUnique(rel);
      if (selected.length >= 5) break;
    }
  }
  return selected.slice(0, 5);
}


async function llmSuggestPrompt({ prdText, files, model }) {
  try {
    const scriptPath = path.join(__dirname, '..', 'llm', 'select_prompt.py');
    const subset = Array.isArray(files) ? files.slice(0, 250) : [];
    const result = await runLLMScript(scriptPath, {
      prd: prdText,
      files: subset.map(f => ({ path: f.path, size: f.size })),
      llm: model
    });
    if (result && typeof result.prompt === 'string') {
      return result.prompt.trim();
    }
  } catch (err) {
    console.warn('[CODE PREPARE] select_prompt LLM failed:', err?.message || err);
  }
  return '';
}
async function llmSelectRelevantFiles({ prdText, files, limit = 12, model }) {
  try {
    const scriptPath = path.join(__dirname, '..', 'llm', 'select_files.py');
    const subset = Array.isArray(files) ? files.slice(0, 250) : [];
    const result = await runLLMScript(scriptPath, {
      prd: prdText,
      files: subset.map(f => ({ path: f.path, size: f.size })),
      limit,
      llm: model
    });
    if (result && Array.isArray(result.files)) {
      return result.files.map(p => String(p || '').trim()).filter(Boolean);
    }
  } catch (err) {
    console.warn('[CODE PREPARE] select_files LLM failed:', err?.message || err);
  }
  return [];
}

async function prepareCodeJob(sessionId, codeRoot) {
  if (!sessionId) throw createHttpError(400, 'Missing sessionId');
  const root = resolveCodeRoot(codeRoot);
  const all = walkFiles(root);
  const maxFile = 256 * 1024;
  const maxBytes = 5 * 1024 * 1024;
  const files = [];
  let total = 0;
  for (const f of all) {
    if (!isTextLike(f.rel)) continue;
    if (f.size > maxFile) continue;
    if (files.length >= 500) break;
    if (total + f.size > maxBytes) break;
    files.push({ path: f.rel, size: f.size });
    total += f.size;
  }
  const jobId = Date.now().toString();
  const jobDir = path.join(codeJobsDir, jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  const meta = {
    jobId,
    sessionId,
    codeRoot: root,
    files,
    bytes: total,
    createdAt: new Date().toISOString()
  };
  fs.writeFileSync(path.join(jobDir, 'job.json'), JSON.stringify(meta, null, 2));
  let recommended = [];
  let recommendedPrompt = '';
  const warnings = [];
  const session = getSession(sessionId);
  const prdText = readPrdText(session);
  if (prdText) {
    const llmFiles = await llmSelectRelevantFiles({ prdText, files, model: ACTIVE_OPENAI_MODEL });
    if (llmFiles.length) {
      recommended = llmFiles;
    } else {
      warnings.push('LLM file selection failed; using fallback recommendations.');
    }
    const llmPrompt = await llmSuggestPrompt({ prdText, files, model: ACTIVE_OPENAI_MODEL });
    if (llmPrompt) {
      recommendedPrompt = llmPrompt;
    } else {
      warnings.push('LLM prompt summarizer failed; using PRD-based fallback prompt.');
    }
  }
  if (!recommended.length) {
    recommended = suggestFilesForTesting(files);
  }
  if (!recommendedPrompt) {
    recommendedPrompt = buildFallbackPrompt(prdText);
  }
  if (!recommended.length) {
    const defaults = chooseDefaultTarget(files);
    defaults.forEach(p => { if (!recommended.includes(p)) recommended.push(p); });
  }
  const metaPath = path.join(jobDir, 'job.json');
  try {
    const metaContents = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    metaContents.recommended = recommended;
    metaContents.recommendedPrompt = recommendedPrompt;
    if (warnings.length) metaContents.warnings = warnings;
    else delete metaContents.warnings;
    fs.writeFileSync(metaPath, JSON.stringify(metaContents, null, 2));
  } catch (err) {
    console.warn('[CODE PREPARE] Failed to persist recommended metadata:', err?.message || err);
  }
  return {
    jobId,
    fileCount: files.length,
    bytes: total,
    ignored: all.length - files.length,
    files,
    recommended,
    recommendedPrompt,
    warnings
  };
}

function loadJobMeta(jobId) {
  if (!jobId) throw createHttpError(400, 'Missing jobId');
  const jobDir = path.join(codeJobsDir, jobId);
  const metaPath = path.join(jobDir, 'job.json');
  if (!fs.existsSync(metaPath)) throw createHttpError(404, 'Job not found');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  return { meta, jobDir };
}

function readPrdText(session) {
  if (!session) throw createHttpError(404, 'Session not found');
  const prdAbsPath = path.join(__dirname, '..', session.prdPath);
  try {
    return fs.readFileSync(prdAbsPath, 'utf-8');
  } catch {
    return '';
  }
}

function buildLangHint(filesPayload) {
  const counts = new Map();
  for (const f of filesPayload) {
    const m = /\.([a-z0-9]+)$/i.exec(f.path || '');
    if (m) counts.set(m[1].toLowerCase(), (counts.get(m[1].toLowerCase()) || 0) + 1);
  }
  if (!counts.size) return '';
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const map = {
    js: 'JavaScript/Jest',
    jsx: 'JavaScript/Jest',
    ts: 'TypeScript/Jest',
    tsx: 'TypeScript/Jest',
    py: 'Python/pytest',
    java: 'Java/JUnit',
    kt: 'Kotlin/JUnit',
    cs: 'C#/xUnit',
    rb: 'Ruby/RSpec',
    go: 'Go/testing',
    rs: 'Rust/cargo test'
  };
  return map[top] || top;
}

function readJobDiff(jobId) {
  const { jobDir, meta } = loadJobMeta(jobId);
  const staging = path.join(jobDir, 'staging');
  const files = [];
  const stack = ['.'];
  while (stack.length) {
    const rel = stack.pop();
    const abs = path.join(staging, rel);
    if (!fs.existsSync(abs)) continue;
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      for (const it of fs.readdirSync(abs)) stack.push(path.join(rel, it));
    } else {
      const newText = fs.readFileSync(abs, 'utf-8');
      let oldText = '';
      try {
        oldText = fs.readFileSync(path.join(meta.codeRoot, rel), 'utf-8');
      } catch {}
      files.push({ path: rel.replace(/^\./, ''), oldText, newText });
    }
  }
  return files;
}

function chooseDefaultTarget(metaFiles = []) {
  if (!Array.isArray(metaFiles)) metaFiles = [];
  const heuristics = [
    f => /test/i.test(String(f.path || '')),
    f => /\.(c|cc|cpp|py|js|ts|tsx|java|kt|go|rb)$/i.test(String(f.path || ''))
  ];
  for (const fn of heuristics) {
    const hit = metaFiles.find(fn);
    if (hit) return [hit.path];
  }
  for (const target of DEFAULT_TEST_TARGETS) {
    if (metaFiles.some(f => new RegExp(`\.(${target.exts.join('|')})$`, 'i').test(f.path || ''))) {
      return [target.path];
    }
  }
  if (DEFAULT_TEST_TARGETS.length) return [DEFAULT_TEST_TARGETS[0].path];
  if (metaFiles.length) return [metaFiles[0].path];
  return [];
}

async function proposeCodeChanges(sessionId, jobId, extraPrompt, selectedPaths = []) {
  if (!sessionId) throw createHttpError(400, 'Missing sessionId');
  const timings = [];
  const startTime = Date.now();
  let last = startTime;
  const stamp = (label) => {
    const now = Date.now();
    timings.push({ label, ms: now - last });
    last = now;
  };
  const { meta, jobDir } = loadJobMeta(jobId);
  stamp('load job');
  const session = getSession(sessionId);
  if (!session) throw createHttpError(404, 'Session not found');
  const prdText = readPrdText(session);
  stamp('read PRD');
  const prdInsights = extractPrdHighlights(prdText);
  const insightKeywords = extractInsightKeywords(prdInsights);

  const available = new Map((meta.files || []).map(f => [f.path, f]));
  let targetPaths = Array.isArray(selectedPaths)
    ? selectedPaths.map(p => String(p || '').trim()).filter(Boolean)
    : [];
  if (!targetPaths.length) targetPaths = chooseDefaultTarget(meta.files || []);
  if (!targetPaths.length) throw createHttpError(400, 'No files available for generation');
  if (targetPaths.length > CODE_MAX_SELECTED_FILES) {
    targetPaths = targetPaths.slice(0, CODE_MAX_SELECTED_FILES);
  }

  const scriptPath = path.join(__dirname, '..', 'llm', 'code_transform.py');
  const codeModel = process.env.OPENAI_CODE_MODEL || ACTIVE_OPENAI_MODEL;
  const strictMode = STRICT_TEST_MODE;
  const noteLines = [];
  const aggregatedChanges = [];
  const truncatedSet = new Set();

  for (let idx = 0; idx < targetPaths.length; idx++) {
    const relPath = targetPaths[idx];
    const info = available.get(relPath);
    let original = '';
    if (info) {
      const abs = path.join(meta.codeRoot, relPath);
      try { original = fs.readFileSync(abs, 'utf-8'); } catch {}
    }
    let content = original || '';
    const truncatedPaths = [];
    if (content.length > CODE_MAX_CHARS_PER_FILE) {
      content = content.slice(0, CODE_MAX_CHARS_PER_FILE);
      truncatedPaths.push(relPath);
      truncatedSet.add(relPath);
    }
    const spotlight = content ? (prioritizeFileContent(content, insightKeywords) || content) : '';
    const filesPayload = [{ path: relPath, content: spotlight }];
    try {
      console.log('[CODE PROPOSE] model=%s files=%d prdBytes=%d extraBytes=%d target=%s',
        codeModel, filesPayload.length, prdText.length, String(extraPrompt || '').length, relPath);
    } catch {}
    const attemptInput = {
      prd: prdText,
      extraPrompt: String(extraPrompt || ''),
      llm: codeModel,
      limits: { maxChanges: 50, maxTokens: 4000 },
      langHint: buildLangHint(filesPayload),
      files: filesPayload,
      chunk: { index: idx, total: targetPaths.length },
      truncatedPaths,
      analysis: {
        hardwareSummary: summarizeHardwareSignals(filesPayload),
        prdInsights,
        strictMode,
        strictRetry: false
      },
      testTarget: pickTestTarget(filesPayload)
    };
    const chunkBegin = Date.now();
    const result = await runLLMScript(scriptPath, attemptInput);
    timings.push({ label: `llm ${relPath}`, ms: Date.now() - chunkBegin });
    if (result && result.error) {
      console.error('[CODE PROPOSE] LLM error:', result.error);
      if (result.traceback) console.error(result.traceback);
      throw createHttpError(502, result.error);
    }
    const changes = Array.isArray(result?.changes) ? result.changes : [];
    const note = String(result?.notes || '').trim();
    if (note) noteLines.push(`[${relPath}] ${note}`);
    if (!changes.length) {
      console.warn('[CODE PROPOSE] File %s produced no changes. Raw result: %s', relPath, JSON.stringify(result));
      continue;
    }
    aggregatedChanges.push(...changes);
  }

  if (!aggregatedChanges.length) {
    throw createHttpError(502, 'Code model returned no actionable edits for selected files.');
  }

  const staging = path.join(jobDir, 'staging');
  try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(staging, { recursive: true });
  for (const ch of aggregatedChanges) {
    const rel = String(ch.path || '').replace(/^\//, '');
    const dst = path.join(staging, rel);
    const action = String(ch.action || '').toLowerCase();
    if (action === 'add' || action === 'modify') {
      const content = String(ch.new_content || '');
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, content, 'utf-8');
    } else if (action === 'delete') {
      const mark = dst + '.delete.TOMBSTONE';
      fs.mkdirSync(path.dirname(mark), { recursive: true });
      fs.writeFileSync(mark, 'delete', 'utf-8');
    }
  }
  stamp('stage writes');
  const metaNotes = [];
  if (truncatedSet.size) {
    metaNotes.push(`Trimmed ${truncatedSet.size} file(s) to ${CODE_MAX_CHARS_PER_FILE} chars for token limits.`);
  }
  const combinedNotes = [...noteLines, ...metaNotes].filter(Boolean).join('\n');
  const proposalMeta = {
    changes: aggregatedChanges,
    notes: combinedNotes,
    truncatedFiles: Array.from(truncatedSet),
    skippedChunks: 0,
    extraPrompt: String(extraPrompt || '')
  };
  fs.writeFileSync(path.join(jobDir, 'proposed.json'), JSON.stringify(proposalMeta, null, 2));
  stamp('write metadata');
  const total = Date.now() - startTime;
  console.log(`[CODE TIMING] job ${jobId}`, [...timings, { label: 'total', ms: total }]);
  return { jobId, changes: aggregatedChanges, notes: combinedNotes, truncatedFiles: Array.from(truncatedSet), skippedChunks: 0 };
}


// Prepare: scan a folder and create a job manifest
app.post('/api/code/prepare', async (req, res) => {
  try {
    const { sessionId, codeRoot } = req.body || {};
    const result = await prepareCodeJob(sessionId, codeRoot);
    res.json(result);
  } catch (e) {
    const status = e?.status || 500;
    res.status(status).json({ error: e.message || 'prepare failed' });
  }
});

app.post('/api/code/propose', async (req, res) => {
  try {
    const { sessionId, jobId, extraPrompt, files } = req.body || {};
    const result = await proposeCodeChanges(sessionId, jobId, extraPrompt, files);
    res.json(result);
  } catch (e) {
    console.error('[CODE PROPOSE] Failed:', e?.message || e);
    if (e && e.stderr) console.error('[CODE PROPOSE] stderr:', e.stderr);
    if (e && e.stdout) console.error('[CODE PROPOSE] stdout:', e.stdout);
    const status = e?.status || 500;
    res.status(status).json({ error: e.message || 'propose failed' });
  }
});

// Diff: return old/new text for each staged file
app.get('/api/code/diff/:jobId', (req, res) => {
  try {
    const files = readJobDiff(req.params.jobId);
    res.set('Cache-Control', 'no-store');
    res.json({ files });
  } catch (e) {
    const status = e?.status || 500;
    res.status(status).json({ error: e.message || 'diff failed' });
  }
});

// One-shot code generation (prepare → propose) without PRD conversation
app.post('/api/codegen/run', async (req, res) => {
  try {
    const { sessionId, codeRoot, jobId, instructions, extraPrompt, files } = req.body || {};
    const promptPieces = [];
    if (Array.isArray(instructions)) promptPieces.push(...instructions.map(String));
    if (extraPrompt) promptPieces.push(String(extraPrompt));
    const combinedPrompt = promptPieces.join('\n\n').trim();

    let activeJobId = jobId || null;
    let prepSummary = null;
    if (activeJobId) {
      const { meta } = loadJobMeta(activeJobId);
      prepSummary = {
        jobId: activeJobId,
        fileCount: Array.isArray(meta.files) ? meta.files.length : 0,
        bytes: meta.bytes || 0,
        ignored: 0,
        files: meta.files || [],
        recommendedPrompt: meta.recommendedPrompt || '',
        warnings: meta.warnings || []
      };
    } else {
      const prep = await prepareCodeJob(sessionId, codeRoot);
      activeJobId = prep.jobId;
      prepSummary = prep;
    }

    const proposal = await proposeCodeChanges(sessionId, activeJobId, combinedPrompt, files);
    const diffFiles = readJobDiff(activeJobId);
    res.json({
      jobId: activeJobId,
      fileCount: prepSummary.fileCount,
      bytes: prepSummary.bytes,
      ignored: prepSummary.ignored,
      files: prepSummary.files,
      recommendedPrompt: prepSummary.recommendedPrompt || '',
      warnings: prepSummary.warnings || [],
      changes: proposal.changes,
      notes: proposal.notes,
      truncatedFiles: proposal.truncatedFiles,
      skippedChunks: proposal.skippedChunks,
      diff: diffFiles
    });
  } catch (e) {
    const status = e?.status || 500;
    res.status(status).json({ error: e.message || 'codegen run failed' });
  }
});

// Accept: apply staged files into codeRoot
app.post('/api/code/accept/:jobId', (req, res) => {
  try {
    const jobId = req.params.jobId;
    const jobDir = path.join(codeJobsDir, jobId);
    const meta = JSON.parse(fs.readFileSync(path.join(jobDir, 'job.json'), 'utf-8'));
    const staging = path.join(jobDir, 'staging');
    let proposed = {};
    const proposedPath = path.join(jobDir, 'proposed.json');
    if (fs.existsSync(proposedPath)) {
      try { proposed = JSON.parse(fs.readFileSync(proposedPath, 'utf-8')); } catch {}
    }
    const stack = ['.'];
    while (stack.length) {
      const rel = stack.pop();
      const abs = path.join(staging, rel);
      if (!fs.existsSync(abs)) continue;
      const st = fs.statSync(abs);
      if (st.isDirectory()) {
        for (const it of fs.readdirSync(abs)) stack.push(path.join(rel, it));
      } else {
        if (abs.endsWith('.delete.TOMBSTONE')) continue; // handled below
        const src = abs;
        const dst = path.join(meta.codeRoot, rel);
        const dstDir = path.dirname(dst);
        fs.mkdirSync(dstDir, { recursive: true });
        fs.copyFileSync(src, dst);
      }
    }
    // Apply deletions
    const deletions = (proposed.changes || []).filter(ch => String(ch.action||'').toLowerCase() === 'delete');
    for (const d of deletions) {
      const rel = String(d.path || '').replace(/^\//,'');
      const target = path.join(meta.codeRoot, rel);
      try { if (fs.existsSync(target)) fs.unlinkSync(target); } catch {}
    }
    // cleanup
    try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch {}
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message || 'accept failed' });
  }
});

// Reject: discard job
app.post('/api/code/reject/:jobId', (req, res) => {
  try {
    const jobId = req.params.jobId;
    const jobDir = path.join(codeJobsDir, jobId);
    try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch {}
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message || 'reject failed' });
  }
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
