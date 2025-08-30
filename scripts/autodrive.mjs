#!/usr/bin/env node
// Simple scenario runner: feeds a text file into the app one line at a time,
// waits for each LLM reply, auto-confirms summaries, and auto-accepts PRD changes.

// Requirements:
// - Backend running on BASE_URL (default http://localhost:4000)
// - Node 18+ (global fetch)

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const BASE_URL = process.env.BASE_URL || 'http://localhost:4000';
const LLM = process.env.LLM || 'gpt5';
const ACCEPT_PHRASE = process.env.ACCEPT_PHRASE || 'Looks right, please apply this to the PRD.';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function readLines(file) {
  const raw = fs.readFileSync(file, 'utf-8');
  return raw.split(/\r?\n/).map(s => s.trim()).filter(s => s.length > 0);
}

async function createSession(title) {
  const r = await fetch(`${BASE_URL}/api/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  if (!r.ok) throw new Error(`Create session failed: ${r.status}`);
  return r.json();
}

async function getSession(id) {
  const r = await fetch(`${BASE_URL}/api/sessions/${id}`);
  if (!r.ok) throw new Error(`Get session failed: ${r.status}`);
  return r.json();
}

async function sendLLM(sessionId, input) {
  const r = await fetch(`${BASE_URL}/api/llm`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, input, llm: LLM }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`LLM call failed ${r.status}: ${t}`);
  }
  return r.json();
}

async function getDiff(id) {
  const r = await fetch(`${BASE_URL}/api/sessions/${id}/prd/diff?ts=${Date.now()}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`Diff failed: ${r.status}`);
  return r.json();
}

async function acceptTemp(id) {
  const r = await fetch(`${BASE_URL}/api/sessions/${id}/prd/accept`, { method: 'POST' });
  if (!r.ok) throw new Error(`Accept temp failed: ${r.status}`);
  return r.json();
}

async function mergeText(id, mergedText) {
  const r = await fetch(`${BASE_URL}/api/sessions/${id}/prd/merge`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mergedText })
  });
  if (!r.ok) throw new Error(`Merge failed: ${r.status}`);
  return r.json();
}

async function getPRD(id) {
  const r = await fetch(`${BASE_URL}/api/sessions/${id}/prd`, { headers: { 'Accept': 'text/markdown' } });
  if (!r.ok) throw new Error(`Get PRD failed: ${r.status}`);
  return r.text();
}

async function driveFromFile(file, explicitTitle) {
  const lines = readLines(file);
  if (lines.length === 0) throw new Error('No lines to send');
  const title = explicitTitle || `Scenario ${path.basename(file)} ${new Date().toISOString()}`;
  const session = await createSession(title);
  const id = session.id;
  console.log(`[AUTO] Created session ${id} (${title})`);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    console.log(`\n[AUTO] >> (${i + 1}/${lines.length}) ${line}`);
    let resp = await sendLLM(id, line);
    console.log(`[AUTO] LLM: ${String(resp.reply || '').slice(0, 240)}${(resp.reply || '').length > 240 ? '…' : ''}`);

    // Auto-confirm if the server is awaiting confirmation
    let attempts = 0;
    while (resp.session && resp.session.awaitingConfirmation && attempts < 2) {
      attempts++;
      console.log('[AUTO] Confirming summary to allow drafting…');
      resp = await sendLLM(id, ACCEPT_PHRASE);
      console.log(`[AUTO] LLM (post-confirm): ${String(resp.reply || '').slice(0, 200)}${(resp.reply || '').length > 200 ? '…' : ''}`);
    }

    // If a temp PRD exists, accept it
    const diff = await getDiff(id);
    if (diff.hasTemp) {
      console.log('[AUTO] Accepting proposed PRD changes…');
      try {
        await acceptTemp(id);
      } catch (e) {
        // Fallback to merge if accept is not available
        console.warn('[AUTO] Accept failed; falling back to merge');
        await mergeText(id, diff.newText || diff.oldText || '');
      }
      // Small pause for filesystem
      await sleep(150);
    } else {
      console.log('[AUTO] No temp PRD to accept.');
    }
  }

  // Fetch and print final PRD
  const prd = await getPRD(id);
  console.log(`\n===== FINAL PRD (Session ${id}) =====\n`);
  console.log(prd);
}

async function main() {
  const argv = process.argv.slice(2);
  let file = null;
  let titleFlag = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--title' && i + 1 < argv.length) {
      titleFlag = argv[++i];
      continue;
    }
    if (!a.startsWith('-') && !file) file = a;
  }
  if (!file) {
    console.error('Usage: node scripts/autodrive.mjs [--title "My Run"] <path-to-lines.txt>');
    process.exit(2);
  }
  try {
    await driveFromFile(file, titleFlag);
  } catch (e) {
    console.error('[AUTO] Error:', e?.message || e);
    process.exit(1);
  }
}

main();
