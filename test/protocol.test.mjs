// Drives the real server over stdio, the way an MCP client does.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs');

function createClient(child) {
  const pending = new Map();
  const frames = [];
  let buffer = '';
  let stderr = '';
  let answerRequest = () => {};

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      frames.push(message);
      if (message.method !== undefined && message.id !== undefined) {
        answerRequest(message);
        continue;
      }
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        waiter(message);
      }
    }
  });

  let nextId = 0;
  /** Full JSON-RPC response, for error-code assertions. */
  function call(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`${method} timed out. stderr: ${stderr}`));
      }, 15000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  return {
    raw: call,
    request: async (method, params) => {
      const message = await call(method, params);
      if (message.error) throw new Error(`${method} failed: ${message.error.code} ${message.error.message}`);
      assert.equal(message.jsonrpc, '2.0');
      return message.result;
    },
    notify: (method, params) => {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    },
    write: (line) => child.stdin.write(line + '\n'),
    frames: () => frames,
    stderr: () => stderr,
    onRoots: (handler) => {
      answerRequest = (message) => {
        if (message.method !== 'roots/list') return;
        Promise.resolve(handler(message)).then((result) =>
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n'),
        );
      };
    },
  };
}

function startServer({ env = {}, roots = null } = {}) {
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ponytail-config-'));
  const child = spawn(process.execPath, [SERVER], {
    // Isolate from the real user config, and from a PONYTAIL_DEFAULT_MODE in the shell.
    env: { ...process.env, PONYTAIL_DEFAULT_MODE: '', XDG_CONFIG_HOME: configHome, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const client = createClient(child);
  if (roots) client.onRoots(() => ({ roots: [{ uri: pathToFileURL(roots).href, name: 'project' }] }));
  return { child, client, configHome };
}

async function withServer(options, run) {
  const { child, client } = startServer(options);
  try {
    const init = await client.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: { roots: { listChanged: false } },
      clientInfo: { name: 'ponytail-mcp-test', version: '1' },
    });
    client.notify('notifications/initialized', {});
    return await run(client, init);
  } finally {
    child.stdin.end();
  }
}

const toolText = async (client, name, args) => {
  const result = await client.request('tools/call', { name, arguments: args });
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  return result.content[0].text;
};

const debtFixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ponytail-workspace-'));
  fs.writeFileSync(path.join(root, 'cache.js'), '// ponytail: single-process cache, move to redis when we run two nodes\n');
  fs.writeFileSync(path.join(root, 'parse.py'), '# ponytail: no BOM handling\n');
  return root;
};

test('initialize injects the ruleset and stays under the host truncation limit', async () => {
  await withServer({}, async (client, init) => {
    assert.equal(init.protocolVersion, '2025-11-25');
    assert.deepEqual(init.serverInfo, { name: 'ponytail', title: 'Ponytail', version: '1.0.0' });
    assert.match(init.instructions, /^PONYTAIL MODE ACTIVE — level: full\n/);
    assert.match(init.instructions, /smallest complete change/);
    assert.match(init.instructions, /ponytail_mode/);
    // OMP truncates server instructions at 4000 characters.
    assert.ok(init.instructions.length < 4000, `instructions are ${init.instructions.length} chars`);
    assert.deepEqual(Object.keys(init.capabilities).sort(), ['prompts', 'resources', 'tools']);
  });
});

test('initialize negotiates down a protocol revision the client asks for', async () => {
  await withServer({}, async (client) => {
    const init = await client.request('initialize', { protocolVersion: '2024-11-05' });
    assert.equal(init.protocolVersion, '2024-11-05');
  });
});

test('tools are listed with usable schemas', async () => {
  await withServer({}, async (client) => {
    const { tools } = await client.request('tools/list', {});
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ['ponytail_mode', 'ponytail_skill', 'ponytail_debt'],
    );
    for (const tool of tools) {
      assert.equal(tool.inputSchema.type, 'object');
      assert.match(tool.description, /\S/);
    }
    assert.deepEqual(tools[1].inputSchema.required, ['skill']);
  });
});

test('ponytail_mode reports, switches, and rejects an unknown level', async () => {
  await withServer({}, async (client) => {
    assert.match(await toolText(client, 'ponytail_mode', {}), /level: full/);
    assert.match(await toolText(client, 'ponytail_mode', { mode: 'status' }), /level: full/);

    const ultra = await toolText(client, 'ponytail_mode', { mode: 'ultra' });
    assert.match(ultra, /^PONYTAIL MODE ACTIVE — level: ultra\n/);
    assert.match(ultra, /question the request/);
    assert.doesNotMatch(ultra, /\| \*\*lite\*\* \|/);
    assert.match(await toolText(client, 'ponytail_mode', {}), /level: ultra \(set this session\)/);

    const off = await toolText(client, 'ponytail_mode', { mode: 'off' });
    assert.match(off, /PONYTAIL OFF/);

    const bad = await client.raw('tools/call', { name: 'ponytail_mode', arguments: { mode: 'turbo' } });
    assert.equal(bad.error.code, -32602);
    assert.match(bad.error.message, /Unknown level "turbo"/);
  });
});

test('a persisted level is read back by the next session', async () => {
  const { child, client, configHome } = startServer({});
  try {
    await client.request('initialize', { protocolVersion: '2025-11-25' });
    client.notify('notifications/initialized', {});
    const text = await toolText(client, 'ponytail_mode', { mode: 'lite', persist: true });
    assert.match(text, /New sessions start at lite/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(configHome, 'ponytail', 'config.json'), 'utf8')), {
      defaultMode: 'lite',
    });
    assert.match(await toolText(client, 'ponytail_mode', {}), /new sessions start at: lite/);
  } finally {
    child.stdin.end();
  }

  const second = startServer({ env: { XDG_CONFIG_HOME: configHome } });
  try {
    const init = await second.client.request('initialize', { protocolVersion: '2025-11-25' });
    assert.match(init.instructions, /^PONYTAIL MODE ACTIVE — level: lite\n/);
  } finally {
    second.child.stdin.end();
  }
});

test('ponytail_skill loads a command verbatim and takes a target', async () => {
  await withServer({}, async (client) => {
    const review = await toolText(client, 'ponytail_skill', { skill: 'ponytail-review', target: 'staged changes' });
    assert.match(review, /Review a change like the senior developer who will be paged/);
    assert.match(review, /Must fix/);
    assert.match(review, /\n\nTarget: staged changes$/);
    assert.doesNotMatch(review, /^---/m);

    assert.match(await toolText(client, 'ponytail_skill', { skill: 'ponytail' }), /^PONYTAIL MODE ACTIVE — level: full/);
    assert.match(await toolText(client, 'ponytail_skill', { skill: 'ponytail-debt' }), /ponytail_debt tool/);

    const bad = await client.raw('tools/call', { name: 'ponytail_skill', arguments: { skill: 'nope' } });
    assert.equal(bad.error.code, -32602);
  });
});

test('resources expose the ruleset, the commands, and the config', async () => {
  await withServer({}, async (client) => {
    const { resources } = await client.request('resources/list', {});
    assert.equal(resources.length, 8);
    assert.ok(resources.some((resource) => resource.uri === 'ponytail://rules'));
    assert.ok(resources.some((resource) => resource.uri === 'ponytail://skill/ponytail-review'));
    for (const resource of resources) assert.match(resource.description, /\S/);

    const read = async (uri) => (await client.request('resources/read', { uri })).contents[0];
    assert.match((await read('ponytail://rules')).text, /^PONYTAIL MODE ACTIVE — level: full/);
    assert.match((await read('ponytail://skill/ponytail-review')).text, /Must fix/);
    const config = await read('ponytail://config');
    assert.equal(config.mimeType, 'application/json');
    assert.equal(JSON.parse(config.text).level, 'full');

    const { resourceTemplates } = await client.request('resources/templates/list', {});
    assert.equal(resourceTemplates[0].uriTemplate, 'ponytail://skill/{name}');

    const missing = await client.raw('resources/read', { uri: 'ponytail://skill/nope' });
    assert.equal(missing.error.code, -32002);
  });
});

test('prompts mirror the six ponytail commands', async () => {
  await withServer({}, async (client) => {
    const { prompts } = await client.request('prompts/list', {});
    assert.deepEqual(
      prompts.map((prompt) => prompt.name),
      ['ponytail', 'ponytail-review', 'ponytail-audit', 'ponytail-debt', 'ponytail-gain', 'ponytail-help'],
    );

    const get = async (name, args) => (await client.request('prompts/get', { name, arguments: args })).messages[0].content.text;
    assert.match(await get('ponytail-review', { target: 'HEAD~1' }), /Target: HEAD~1$/);
    assert.match(await get('ponytail-help', {}), /Ponytail Help/);

    assert.match(await get('ponytail', { mode: 'off' }), /^PONYTAIL OFF/);
    // No level, ponytail off: switch on at the level new sessions start at.
    assert.match(await get('ponytail', {}), /^PONYTAIL MODE ACTIVE — level: full/);

    const bad = await client.raw('prompts/get', { name: 'ponytail-typo', arguments: {} });
    assert.equal(bad.error.code, -32602);
  });
});

test('ponytail_debt scans the workspace the client reports and writes the ledger on request', async () => {
  const root = debtFixture();
  await withServer({ roots: root }, async (client) => {
    const ledger = await toolText(client, 'ponytail_debt', {});
    assert.match(ledger, /2 markers, 1 with no trigger\./);
    assert.match(ledger, /cache\.js:1, ceiling: single-process cache\./);
    assert.doesNotMatch(ledger, /parse\.py:1.*single-process/);

    const written = await toolText(client, 'ponytail_debt', { write: true });
    assert.match(written, /Wrote .*PONYTAIL-DEBT\.md\./);
    assert.match(fs.readFileSync(path.join(root, 'PONYTAIL-DEBT.md'), 'utf8'), /2 markers, 1 with no trigger\./);

    const withPath = await toolText(client, 'ponytail_debt', { path: root });
    assert.match(withPath, /2 markers, 1 with no trigger\./);

    const missing = await client.raw('tools/call', { name: 'ponytail_debt', arguments: { path: path.join(root, 'nope') } });
    assert.equal(missing.error.code, -32602);
    assert.match(missing.error.message, /No such path/);
  });
});

test('unknown methods and pings are answered', async () => {
  await withServer({}, async (client) => {
    assert.equal((await client.raw('resources/subscribe', { uri: 'ponytail://rules' })).error.code, -32601);
    assert.deepEqual(await client.request('ping', {}), {});
  });
});

test('a malformed frame produces a parse error response', async () => {
  await withServer({}, async (client) => {
    client.write('{not json');
    const parseError = await client.request('ping', {});
    assert.deepEqual(parseError, {});
    const frame = client.frames().find((message) => message.error?.code === -32700);
    assert.equal(frame.id, null);
    assert.equal(frame.error.message, 'Parse error');
  });
});

test('notifications get no response', async () => {
  await withServer({}, async (client) => {
    const before = client.frames().length;
    client.notify('notifications/cancelled', { requestId: 1, reason: 'test' });
    assert.deepEqual(await client.request('ping', {}), {});
    const added = client.frames().slice(before).filter((message) => message.id === null || message.id === undefined);
    assert.deepEqual(added, []);
  });
});
