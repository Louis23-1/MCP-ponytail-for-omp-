// Shared logic for ponytail-mcp: level resolution, the injected ruleset, skill
// bodies, and the `ponytail:` debt ledger.
//
// Level/config resolution mirrors upstream hooks/ponytail-config.js and the
// injected ruleset mirrors hooks/ponytail-instructions.js, so this server and a
// regular ponytail install agree on both when they share the same config file.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROMPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts');

export const DEFAULT_MODE = 'full';
// Levels that mean "ponytail is active at this intensity".
export const RUNTIME_MODES = ['off', 'lite', 'full', 'ultra'];
// Every level, including session-only ones.
export const VALID_MODES = ['off', 'lite', 'full', 'ultra', 'review'];
export const SKILL_NAMES = [
  'ponytail',
  'ponytail-review',
  'ponytail-audit',
  'ponytail-debt',
  'ponytail-gain',
  'ponytail-help',
];
export const LEDGER_FILE = 'PONYTAIL-DEBT.md';

export function normalizeMode(value) {
  if (typeof value !== 'string') return null;
  const mode = value.trim().toLowerCase();
  return RUNTIME_MODES.includes(mode) ? mode : null;
}

export function normalizeConfigMode(value) {
  if (typeof value !== 'string') return null;
  const mode = value.trim().toLowerCase();
  return VALID_MODES.includes(mode) ? mode : null;
}

// ---------------------------------------------------------------------------
// Config file (shared with the upstream hooks)

export function getConfigDir(env = process.env) {
  if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, 'ponytail');
  if (process.platform === 'win32') {
    return path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ponytail');
  }
  return path.join(os.homedir(), '.config', 'ponytail');
}

export function getConfigPath(env = process.env) {
  return path.join(getConfigDir(env), 'config.json');
}

export function readConfigFile(env = process.env) {
  try {
    // Strip a UTF-8 BOM so a Windows-saved file still parses (upstream does the same).
    const parsed = JSON.parse(fs.readFileSync(getConfigPath(env), 'utf8').replace(/^\uFEFF/, ''));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // Missing or invalid config: no defaults from the file.
  }
  return {};
}

// The level a fresh session starts at: env var, then config file, then full.
export function defaultModeInfo(env = process.env) {
  const fromEnv = normalizeMode(env.PONYTAIL_DEFAULT_MODE);
  if (fromEnv) return { mode: fromEnv, source: 'PONYTAIL_DEFAULT_MODE' };
  const fromFile = normalizeMode(readConfigFile(env).defaultMode);
  if (fromFile) return { mode: fromFile, source: getConfigPath(env) };
  return { mode: DEFAULT_MODE, source: 'built-in default' };
}

// Only a runtime level can be a default; `review` is session-only (upstream #377).
export function persistDefaultMode(mode, env = process.env) {
  const normalized = normalizeMode(mode);
  if (!normalized) return null;
  const configPath = getConfigPath(env);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const config = readConfigFile(env);
  config.defaultMode = normalized;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  return configPath;
}

// ---------------------------------------------------------------------------
// Skills (vendored upstream prompts)

const bodyCache = new Map();

export function readSkillFile(name) {
  if (!SKILL_NAMES.includes(name)) return null;
  if (!bodyCache.has(name)) {
    const raw = fs.readFileSync(path.join(PROMPTS_DIR, `${name}.md`), 'utf8');
    bodyCache.set(name, { raw, meta: parseFrontmatter(raw), body: stripFrontmatter(raw) });
  }
  return bodyCache.get(name);
}

function parseFrontmatter(raw) {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!block) return {};
  const lines = block[1].split(/\r?\n/);
  const meta = {};
  for (let i = 0; i < lines.length; i++) {
    const entry = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!entry) continue;
    let value = entry[2].trim();
    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      const folded = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) folded.push(lines[++i].trim());
      value = folded.join(' ');
    }
    if (value.length >= 2 && /^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    meta[entry[1]] = value;
  }
  return meta;
}

function stripFrontmatter(raw) {
  return raw.replace(/^---[\s\S]*?---\s*/, '');
}

// Keep only the rules that apply to the active level: the intensity table row and
// any worked example keyed by a level name. Ported from upstream
// hooks/ponytail-instructions.js so the injected text matches a normal install.
export function filterSkillBodyForMode(body, mode) {
  const effectiveMode = normalizeMode(mode) || DEFAULT_MODE;
  return stripFrontmatter(String(body || ''))
    .split(/\r?\n/)
    .filter((line) => {
      const tableRow = line.match(/^\|\s*\*\*(.+?)\*\*\s*\|/);
      if (tableRow) {
        const label = normalizeMode(tableRow[1].trim());
        if (label) return label === effectiveMode;
      }
      // Only a quoted value counts as a worked example (`- lite: "..."`); an
      // ordinary rule bullet that starts with a level word survives verbatim.
      const example = line.match(/^-\s*([^:]+):\s*"/);
      if (example) {
        const label = normalizeMode(example[1].trim());
        if (label) return label === effectiveMode;
      }
      return true;
    })
    .join('\n');
}

const OFF_RULES =
  'PONYTAIL OFF — normal coding mode. If ponytail rules appear earlier in this prompt they are inactive: ' +
  'ignore them until a level is switched on with the ponytail_mode tool.';

const REVIEW_RULES =
  'PONYTAIL MODE ACTIVE — level: review. Behavior defined by the ponytail-review skill; ' +
  'load it with the ponytail_skill tool.';

// The text injected as context for a level: the upstream header plus the skill
// body, filtered to that level.
export function rulesText(mode) {
  if (mode === 'off') return OFF_RULES;
  if (mode === 'review') return REVIEW_RULES;
  return `PONYTAIL MODE ACTIVE — level: ${mode}\n\n${filterSkillBodyForMode(readSkillFile('ponytail').body, mode)}`;
}

// Pointer block appended to the MCP server instructions only; it is how the model
// learns the MCP-specific entry points. Kept short: OMP truncates server
// instructions at 4000 characters.
export const USAGE = [
  'Ponytail over MCP:',
  '- ponytail_mode — report or switch the level (lite, full, ultra; off disables; review is session-only).',
  '- ponytail_skill — load one ponytail command verbatim: ponytail, ponytail-review, ponytail-audit, ponytail-debt, ponytail-gain, ponytail-help.',
  '- ponytail_debt — build the `ponytail:` shortcut ledger for this repo.',
  '- The same commands are MCP prompts (/ponytail-*) and MCP resources (ponytail://skill/*).',
].join('\n');

export function serverInstructions(mode) {
  return `${rulesText(mode)}\n\n${USAGE}`;
}

// ---------------------------------------------------------------------------
// Debt ledger

const SKIP_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'bower_components', 'vendor', 'dist', 'build', 'out',
  'coverage', 'target', 'bin', 'obj', '.venv', 'venv', 'env', '__pycache__', '.next', '.nuxt',
  '.cache', '.turbo', '.parcel-cache', '.idea', '.gradle', 'Pods', '.terraform', '.tox',
]);
const MARKER = /(?:#|\/\/|\/\*|\*|<!--|--|;|%)[ \t]*ponytail:[ \t]?(.*)$/;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

// Collect every `ponytail:` shortcut comment under root, grouped by file.
export function scanDebt(root) {
  const files = [];
  const entries = [];

  const walk = (dir) => {
    let dirents;
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // Unreadable directory: not a reason to fail the whole ledger.
    }
    for (const dirent of dirents) {
      const full = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        if (!SKIP_DIRS.has(dirent.name)) walk(full);
        continue;
      }
      if (!dirent.isFile() || dirent.name === LEDGER_FILE) continue;
      let stats;
      try {
        stats = fs.statSync(full);
      } catch {
        continue;
      }
      if (stats.size > MAX_FILE_BYTES) continue;
      let text;
      try {
        text = fs.readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      if (text.includes('\0')) continue; // Binary.
      files.push(full);

      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const match = MARKER.exec(lines[i]);
        if (!match) continue;
        const note = match[1].trim();
        const comma = note.indexOf(',');
        const ceiling = (comma === -1 ? note : note.slice(0, comma)).trim();
        const upgrade = comma === -1 ? null : note.slice(comma + 1).trim() || null;
        entries.push({
          file: path.relative(root, full).split(path.sep).join('/'),
          line: i + 1,
          ceiling,
          upgrade,
        });
      }
    }
  };

  walk(root);
  return { files: files.length, entries };
}

export function debtLedgerText(root) {
  const { files, entries } = scanDebt(root);
  if (entries.length === 0) {
    return `Scanned ${files} files in ${root}.\nNo ponytail: debt. Clean ledger.`;
  }

  const rows = [];
  let currentFile = null;
  for (const entry of entries) {
    if (entry.file !== currentFile) {
      currentFile = entry.file;
      if (rows.length) rows.push('');
      rows.push(entry.file);
    }
    const upgrade = entry.upgrade ? `upgrade: ${entry.upgrade}.` : 'upgrade: none. [no-trigger]';
    rows.push(`  ${entry.file}:${entry.line}, ceiling: ${entry.ceiling}. ${upgrade}`);
  }

  const noTrigger = entries.filter((entry) => !entry.upgrade).length;
  return [
    `ponytail debt — ${root} (${files} files scanned)`,
    '',
    ...rows,
    '',
    `${entries.length} markers, ${noTrigger} with no trigger.`,
  ].join('\n');
}

export function debtLedgerMarkdown(root) {
  return `${debtLedgerText(root)}\n`;
}
