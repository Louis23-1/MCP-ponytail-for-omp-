import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  debtLedgerText,
  defaultModeInfo,
  getConfigPath,
  normalizeConfigMode,
  normalizeMode,
  persistDefaultMode,
  scanDebt,
} from '../lib/ponytail.mjs';

const ISOLATED_ENV = { XDG_CONFIG_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'ponytail-config-')) };

test('levels: runtime levels are a subset of the known levels', () => {
  assert.equal(normalizeMode('Lite '), 'lite');
  assert.equal(normalizeMode('review'), null); // session-only, never a default
  assert.equal(normalizeMode('bogus'), null);
  assert.equal(normalizeMode(7), null);
  assert.equal(normalizeConfigMode('review'), 'review');
  assert.equal(normalizeConfigMode('off'), 'off');
  assert.equal(normalizeConfigMode('nope'), null);
});

test('default level comes from the env var, then the config file, then full', () => {
  assert.deepEqual(defaultModeInfo({ ...ISOLATED_ENV }), { mode: 'full', source: 'built-in default' });
  assert.deepEqual(defaultModeInfo({ ...ISOLATED_ENV, PONYTAIL_DEFAULT_MODE: 'ultra' }), {
    mode: 'ultra',
    source: 'PONYTAIL_DEFAULT_MODE',
  });
  // A session-only level is not a valid default and is ignored, not applied.
  assert.equal(defaultModeInfo({ ...ISOLATED_ENV, PONYTAIL_DEFAULT_MODE: 'review' }).mode, 'full');

  persistDefaultMode('lite', ISOLATED_ENV);
  assert.deepEqual(defaultModeInfo({ ...ISOLATED_ENV }), {
    mode: 'lite',
    source: getConfigPath(ISOLATED_ENV),
  });
  assert.equal(defaultModeInfo({ ...ISOLATED_ENV, PONYTAIL_DEFAULT_MODE: 'ultra' }).mode, 'ultra');
  assert.equal(persistDefaultMode('review', ISOLATED_ENV), null);
});

test('persisting a level keeps the rest of the config file', () => {
  const env = { XDG_CONFIG_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'ponytail-config-')) };
  fs.mkdirSync(path.dirname(getConfigPath(env)), { recursive: true });
  fs.writeFileSync(getConfigPath(env), '{"quietStartup":true,"defaultMode":"full"}', 'utf8');
  persistDefaultMode('off', env);
  assert.deepEqual(JSON.parse(fs.readFileSync(getConfigPath(env), 'utf8')), {
    quietStartup: true,
    defaultMode: 'off',
  });
});

test('debt scan finds shortcut comments, skips prose and build output', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ponytail-debt-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'src', 'cache.js'),
    'const ttl = 60; // ponytail: single-process cache, move to redis when we run two nodes\n',
  );
  fs.writeFileSync(path.join(root, 'src', 'parse.py'), '# ponytail: no BOM handling\n');
  fs.writeFileSync(path.join(root, 'notes.md'), 'The convention is `ponytail: <ceiling>, <upgrade>`.\n');
  fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), '// ponytail: skipped\n');

  const { entries } = scanDebt(root);
  assert.deepEqual(
    entries.map((entry) => [entry.file, entry.line, entry.ceiling, entry.upgrade]),
    [
      ['src/cache.js', 1, 'single-process cache', 'move to redis when we run two nodes'],
      ['src/parse.py', 1, 'no BOM handling', null],
    ],
  );

  const ledger = debtLedgerText(root);
  assert.match(ledger, /2 markers, 1 with no trigger\./);
  assert.match(ledger, /src\/cache\.js:1, ceiling: single-process cache\. upgrade: move to redis when we run two nodes\./);
  assert.match(ledger, /src\/parse\.py:1, ceiling: no BOM handling\. upgrade: none\. \[no-trigger\]/);
  assert.doesNotMatch(ledger, /node_modules/);
  assert.doesNotMatch(ledger, /<ceiling>/);
});

test('an empty scan reports a clean ledger', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ponytail-clean-'));
  assert.match(debtLedgerText(root), /No ponytail: debt\. Clean ledger\./);
});
