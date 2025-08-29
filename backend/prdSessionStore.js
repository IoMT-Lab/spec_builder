// PRD session state management for each user/session
// Simple in-memory cache with JSON persistence to sessions/ directory.

const sessions = {};

function createSession({ projectDescription, industryDomain = '', projectType = '' }) {
  const sessionId = Date.now().toString();
  const prdPath = `Documents/PRD_${sessionId}.md`;
  const conversationPath = `Documents/CONVO_${sessionId}.md`;
  // Create the markdown file for the PRD
  const fs = require('fs');
  const path = require('path');
  const sessionsDir = path.join(__dirname, '..', 'sessions');
  const absPrdPath = path.join(__dirname, '..', prdPath);
  const absConvoPath = path.join(__dirname, '..', conversationPath);
  if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });
  if (!fs.existsSync(path.dirname(absPrdPath))) fs.mkdirSync(path.dirname(absPrdPath), { recursive: true });
  fs.writeFileSync(absPrdPath, `# PRD for session ${sessionId}\n`);
  fs.writeFileSync(absConvoPath, `# Conversation History for session ${sessionId}\n`);
  sessions[sessionId] = {
    projectDescription: projectDescription || '',
    industryDomain: industryDomain || '',
    projectType: projectType || '',
    answers: {}, // { sectionName: { fieldName: answer } }
    completedSections: [],
    currentSectionIdx: 0,
    startedAt: new Date().toISOString(),
    conversation: [], // LLM conversation history
    prdPath,
    conversationPath,
    id: sessionId,
    // Conversation structure control
    cursor: { sectionIndex: 0, fieldIndex: 0 },
    focusStack: [], // [{ type, topic, turnsLeft, depth }]
    consecutiveDigressions: 0,
  };
  // Persist initial session JSON
  try {
    const sessionFile = path.join(sessionsDir, `${sessionId}.json`);
    fs.writeFileSync(sessionFile, JSON.stringify(sessions[sessionId], null, 2));
  } catch (e) {
    console.warn('Failed to persist new session JSON:', e?.message || e);
  }
  return sessionId;
}

function getSession(sessionId) {
  if (sessions[sessionId]) return sessions[sessionId];
  // Try to load from disk if not in memory
  const fs = require('fs');
  const path = require('path');
  const sessionFile = path.join(__dirname, '..', 'sessions', `${sessionId}.json`);
  if (fs.existsSync(sessionFile)) {
    try {
      const data = fs.readFileSync(sessionFile, 'utf-8');
      const session = JSON.parse(data);
      sessions[sessionId] = session; // cache in memory
      return session;
    } catch (err) {
      console.error('Error reading session file:', sessionFile, err);
      return null;
    }
  }
  return null;
}

function updateSession(sessionId, updates) {
  const fs = require('fs');
  const path = require('path');
  const sessionsDir = path.join(__dirname, '..', 'sessions');
  if (!sessions[sessionId]) {
    // Try to hydrate from disk if missing in memory
    const hydrated = getSession(sessionId) || {};
    sessions[sessionId] = hydrated;
  }
  // Merge into memory
  Object.assign(sessions[sessionId], updates);
  // Persist to disk
  try {
    if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });
    const sessionFile = path.join(sessionsDir, `${sessionId}.json`);
    fs.writeFileSync(sessionFile, JSON.stringify(sessions[sessionId], null, 2));
  } catch (e) {
    console.warn('Failed to persist session JSON:', sessionId, e?.message || e);
  }
}

module.exports = { createSession, getSession, updateSession };
