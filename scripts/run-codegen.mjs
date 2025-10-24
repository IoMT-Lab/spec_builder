#!/usr/bin/env node
// One-shot code generation runner. Reads an instruction file, bundles it with the
// accepted PRD and selected repo path, and calls the dedicated /api/codegen/run
// endpoint. No PRD drafting or conversation flow involved.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const BASE_URL = process.env.BASE_URL || 'http://localhost:4000';

function usage() {
  console.error('Usage: node scripts/run-codegen.mjs --session <id> --code-root <path> [--files path1,path2] <instructions-file>');
  process.exit(2);
}

function readInstructions(file) {
  const abs = path.resolve(file);
  const raw = fs.readFileSync(abs, 'utf-8').trim();
  if (!raw) throw new Error(`Instruction file ${file} is empty`);
  return raw;
}

async function runCodegen({ sessionId, codeRoot, prompt, files }) {
  const res = await fetch(`${BASE_URL}/api/codegen/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      codeRoot,
      files,
      extraPrompt: prompt
    })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`codegen failed (${res.status}): ${text}`);
  }
  return res.json();
}

function printDiff(diff = []) {
  if (!Array.isArray(diff) || diff.length === 0) {
    console.log('[CODEGEN] No diff produced.');
    return;
  }
  diff.forEach((file) => {
    console.log(`\n=== ${file.path} ===`);
    const lines = String(file.newText || '').split('\n');
    lines.forEach(line => {
      process.stdout.write(`+ ${line}\n`);
    });
  });
}

async function main() {
  const argv = process.argv.slice(2);
  let sessionId = null;
  let codeRoot = null;
  let instructionFile = null;
  let selectedFiles = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--session' && i + 1 < argv.length) {
      sessionId = argv[++i];
      continue;
    }
    if (arg === '--code-root' && i + 1 < argv.length) {
      codeRoot = argv[++i];
      continue;
    }
     if (arg === '--files' && i + 1 < argv.length) {
      selectedFiles = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
      continue;
    }
    if (!arg.startsWith('-') && !instructionFile) {
      instructionFile = arg;
      continue;
    }
  }
  if (!sessionId || !codeRoot || !instructionFile) usage();
  let prompt = '';
  try {
    prompt = readInstructions(instructionFile);
  } catch (err) {
    console.error('[CODEGEN] Failed to read instructions:', err?.message || err);
    process.exit(1);
  }
  try {
    console.log('[CODEGEN] requesting proposal…');
    const result = await runCodegen({ sessionId, codeRoot, prompt, files: selectedFiles });
    console.log(`[CODEGEN] job ${result.jobId} touched ${result.changes?.length || 0} file(s)`);
    if (result.notes) {
      console.log('\n[NOTES]');
      console.log(result.notes);
    }
    printDiff(result.diff);
    console.log('\n[CODEGEN] To apply changes: POST /api/code/accept/' + result.jobId);
  } catch (err) {
    console.error('[CODEGEN] Error:', err?.message || err);
    process.exit(1);
  }
}

main();
