const fs = require('fs');
const path = require('path');

const DEMOS_DIR = path.join(__dirname, '..', 'demos');

const demos = loadDemos();

function safeRead(filePath, fallback = '') {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return fallback;
  }
}

function loadDemos() {
  const registry = {};
  if (!fs.existsSync(DEMOS_DIR)) return registry;
  const demoDirs = fs.readdirSync(DEMOS_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);

  demoDirs.forEach(name => {
    try {
      const dir = path.join(DEMOS_DIR, name);
      const conversationPath = path.join(dir, 'conversation.json');
      if (!fs.existsSync(conversationPath)) {
        console.warn(`[DEMO] conversation.json missing for demo "${name}"`);
        return;
      }
      const conversation = JSON.parse(fs.readFileSync(conversationPath, 'utf-8'));
      if (!Array.isArray(conversation) || conversation.length === 0) {
        console.warn(`[DEMO] conversation.json invalid for demo "${name}"`);
        return;
      }
      const metaPath = path.join(dir, 'demo.json');
      const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf-8')) : {};

      const snapshotsDir = path.join(dir, 'prd_snapshots');
      const snapshots = [];
      if (fs.existsSync(snapshotsDir)) {
        const files = fs.readdirSync(snapshotsDir)
          .filter(f => f.toLowerCase().endsWith('.md'))
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        files.forEach(f => {
          snapshots.push(safeRead(path.join(snapshotsDir, f), ''));
        });
      }

      registry[name] = {
        name,
        title: meta.title || name,
        description: meta.description || '',
        conversation,
        snapshots
      };
    } catch (err) {
      console.error(`[DEMO] Failed to load demo "${name}":`, err);
    }
  });
  return registry;
}

function listDemos() {
  return Object.values(demos).map(d => ({
    name: d.name,
    title: d.title,
    description: d.description,
    conversationLength: d.conversation.length
  }));
}

function getDemo(name) {
  return demos[name] || null;
}

module.exports = {
  DEMOS_DIR,
  listDemos,
  getDemo,
};
