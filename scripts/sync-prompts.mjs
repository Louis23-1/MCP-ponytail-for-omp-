#!/usr/bin/env node
// Re-vendor the ponytail prompts from upstream.
//
//   node scripts/sync-prompts.mjs [--repo owner/name] [--ref ref]
//
// Writes prompts/*.md plus LICENSE, then records the resolved commit and the
// file map in prompts/UPSTREAM.json. Everything is fetched before anything is
// written, so a failed download leaves the vendored copies untouched.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'prompts', 'UPSTREAM.json');

const FILES = [
  { source: 'skills/ponytail/SKILL.md', target: 'prompts/ponytail.md' },
  { source: 'skills/ponytail-review/SKILL.md', target: 'prompts/ponytail-review.md' },
  { source: 'skills/ponytail-audit/SKILL.md', target: 'prompts/ponytail-audit.md' },
  { source: 'skills/ponytail-debt/SKILL.md', target: 'prompts/ponytail-debt.md' },
  { source: 'skills/ponytail-gain/SKILL.md', target: 'prompts/ponytail-gain.md' },
  { source: 'skills/ponytail-help/SKILL.md', target: 'prompts/ponytail-help.md' },
  { source: 'LICENSE', target: 'LICENSE' },
];

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const repo = arg('repo', manifest.repository.replace(/^https:\/\/github\.com\//, ''));
const ref = arg('ref', 'main');

const downloaded = [];
for (const file of FILES) {
  const url = `https://raw.githubusercontent.com/${repo}/${ref}/${file.source}`;
  const response = await fetch(url);
  if (!response.ok) {
    console.error(`Failed: ${url} (HTTP ${response.status})`);
    process.exit(1);
  }
  downloaded.push({ target: path.join(ROOT, file.target), text: await response.text(), file });
  console.log(`fetched ${file.source}`);
}

let commit = null;
try {
  const response = await fetch(`https://api.github.com/repos/${repo}/commits/${ref}`);
  if (response.ok) commit = (await response.json()).sha;
} catch {
  // Provenance only: a missing sha must not fail the sync.
}

for (const { target, text } of downloaded) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text, 'utf8');
}

manifest.repository = `https://github.com/${repo}`;
manifest.ref = ref;
manifest.commit = commit;
manifest.syncedAt = new Date().toISOString().slice(0, 10);
manifest.files = Object.fromEntries(downloaded.map(({ file }) => [file.target, file.source]));
fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log(`synced ${downloaded.length} files from ${repo}@${ref}${commit ? ` (${commit.slice(0, 10)})` : ''}`);
