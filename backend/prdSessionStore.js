// PRD session state management for each user/session
// This is a simple in-memory store. For production, use a database or persistent storage.

const sessions = {};

function createSession({ projectDescription, industryDomain = '', projectType = '' }) {
  const sessionId = Date.now().toString();
  const prdPath = `Documents/PRD_${sessionId}.md`;
  const conversationPath = `Documents/CONVO_${sessionId}.md`;
  // Create the markdown file for the PRD
  const fs = require('fs');
  const path = require('path');
  const absPrdPath = path.join(__dirname, '..', prdPath);
  const absConvoPath = path.join(__dirname, '..', conversationPath);
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
  };
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
  if (sessions[sessionId]) {
    Object.assign(sessions[sessionId], updates);
  }
}

module.exports = { createSession, getSession, updateSession };
