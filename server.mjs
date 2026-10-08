#!/usr/bin/env node
// ponytail-mcp — ponytail ("lazy senior dev mode") as an MCP stdio server.
//
// Newline-delimited JSON-RPC 2.0 on stdio, MCP protocol revision 2025-11-25.
// No runtime dependencies: node's standard library only.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LEDGER_FILE,
  SKILL_NAMES,
  USAGE,
  VALID_MODES,
  debtLedgerMarkdown,
  debtLedgerText,
  defaultModeInfo,
  getConfigPath,
  normalizeConfigMode,
  persistDefaultMode,
  readSkillFile,
  rulesText,
  serverInstructions,
} from './lib/ponytail.mjs';

const VERSION = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const PROTOCOL_VERSION = '2025-11-25';
const SUPPORTED_PROTOCOLS = [PROTOCOL_VERSION, '2025-06-18', '2025-03-26', '2024-11-05'];

// Runtime level: set by the ponytail_mode tool or the /ponytail prompt, for this
// session only. The config file holds the level new sessions start at.
const state = { mode: null, root: null };
const effectiveMode = () => state.mode ?? defaultModeInfo().mode;
const workspace = () => state.root ?? process.cwd();

const DEBT_TOOL_NOTE =
  '\n\nIn this host the ledger is computed by the ponytail_debt tool: call it instead of grepping.';

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Transport

function write(message) {
  try {
    fs.writeSync(1, JSON.stringify(message) + '\n');
  } catch {
    process.exit(0); // Client closed the pipe; nothing left to serve.
  }
}

const reply = (id, result) => write({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });
const log = (message) => process.stderr.write(`ponytail-mcp: ${message}\n`);

// Requests we send to the client (only roots/list, to learn the project root).
let nextRequestId = 0;
const pendingRequests = new Map();

function requestClient(method, params) {
  const id = `ponytail:${++nextRequestId}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      resolve(null);
    }, 2000);
    pendingRequests.set(id, (message) => {
      clearTimeout(timer);
      pendingRequests.delete(id);
      resolve(message);
    });
    write({ jsonrpc: '2.0', id, method, params });
  });
}

let workspaceReady = null;

// Ask the client once for its roots; the debt tool waits on this so a scan made in
// the first seconds of a session still lands on the project, not on our cwd.
function ensureWorkspace() {
  workspaceReady ??= adoptWorkspaceRoot();
  return workspaceReady;
}

async function adoptWorkspaceRoot() {
  const response = await requestClient('roots/list', {});
  const roots = response?.result?.roots;
  const uri = Array.isArray(roots) ? roots.find((root) => typeof root?.uri === 'string')?.uri : null;
  if (!uri) return;
  try {
    state.root = uri.startsWith('file://') ? fileURLToPath(uri) : uri;
  } catch {
    state.root = null;
  }
}

// ---------------------------------------------------------------------------
// Text

function statusText() {
  const { mode, source } = defaultModeInfo();
  return [
    `PONYTAIL — level: ${effectiveMode()}${state.mode ? ' (set this session)' : ''}`,
    `new sessions start at: ${mode} (${source})`,
    `levels: ${VALID_MODES.join(', ')} — off disables ponytail, review is session-only`,
    `config file: ${getConfigPath()}`,
    `workspace: ${workspace()}`,
  ].join('\n');
}

function setMode(requested, persist) {
  const requestedMode = normalizeConfigMode(requested);
  if (!requestedMode) {
    throw new RpcError(-32602, `Unknown level "${requested}". Levels: ${VALID_MODES.join(', ')}.`);
  }
  if (persist && requestedMode === 'review') {
    throw new RpcError(-32602, 'The review level is session-only and cannot be persisted.');
  }
  state.mode = requestedMode;
  if (!persist) return rulesText(requestedMode);
  const configPath = persistDefaultMode(requestedMode);
  return `${rulesText(requestedMode)}\n\nNew sessions start at ${requestedMode} (${configPath}).`;
}

// One ponytail command, verbatim. The ruleset follows the active level; the other
// five commands are the upstream skill bodies.
function commandText(name, target) {
  const note = name === 'ponytail-debt' ? DEBT_TOOL_NOTE : '';
  const body = name === 'ponytail' ? rulesText(effectiveMode()) : readSkillFile(name).body;
  const takesTarget = name === 'ponytail-review' || name === 'ponytail-audit';
  const suffix = takesTarget && target ? `\n\nTarget: ${target}` : '';
  return `${body}${note}${suffix}`;
}

function skillName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!SKILL_NAMES.includes(name)) {
    throw new RpcError(-32602, `Unknown skill "${name}". Skills: ${SKILL_NAMES.join(', ')}.`);
  }
  return name;
}

// ---------------------------------------------------------------------------
// Tools

const TOOLS = [
  {
    name: 'ponytail_mode',
    title: 'Ponytail level',
    description:
      'Report or switch the ponytail level. Lite builds what was asked and names the smaller option, ' +
      'full takes the smallest complete change, ultra also questions the request, review reviews like the ' +
      'senior dev who gets paged, off returns to normal coding. With no mode, reports the current level. ' +
      'persist stores the level for future sessions in the same config file the ponytail hooks read.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: [...VALID_MODES, 'status'],
          description: 'Level to switch to; omit or pass "status" to report the current one.',
        },
        persist: {
          type: 'boolean',
          description: 'Also make this the level new sessions start at (runtime levels only).',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'ponytail_skill',
    title: 'Load a ponytail command',
    description:
      `Load one ponytail command verbatim and follow it: ${SKILL_NAMES.join(', ')}. ` +
      'The "ponytail" command loads the ruleset for the active level; use it when the rules are not in ' +
      'context any more, and after a context reset.',
    inputSchema: {
      type: 'object',
      properties: {
        skill: { type: 'string', enum: SKILL_NAMES, description: 'Which command to load.' },
        target: {
          type: 'string',
          description: 'What to review or audit: uncommitted, staged, a branch, a PR link, or paths.',
        },
      },
      required: ['skill'],
      additionalProperties: false,
    },
  },
  {
    name: 'ponytail_debt',
    title: 'Ponytail debt ledger',
    description:
      'Collect every `ponytail:` shortcut comment under a directory into one ledger: file, line, the ' +
      'ceiling it names, and the trigger to revisit it. Marks the rows that name no upgrade path. Reads only, ' +
      'unless write is set. Use it instead of grepping for the markers.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory to scan; defaults to the workspace root.' },
        write: {
          type: 'boolean',
          description: `Also write the ledger to ${LEDGER_FILE} in that directory.`,
        },
      },
      additionalProperties: false,
    },
  },
];

async function callTool(params) {
  const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
  switch (params?.name) {
    case 'ponytail_mode': {
      const requested = typeof args.mode === 'string' ? args.mode.trim() : '';
      const text =
        requested === '' || requested.toLowerCase() === 'status'
          ? statusText()
          : setMode(requested, args.persist === true);
      return text;
    }
    case 'ponytail_skill':
      return commandText(skillName(args.skill), typeof args.target === 'string' ? args.target.trim() : '');
    case 'ponytail_debt': {
      const relative = typeof args.path === 'string' ? args.path.trim() : '';
      if (!relative) await ensureWorkspace();
      const root = path.resolve(workspace(), relative || '.');
      let stats;
      try {
        stats = fs.statSync(root);
      } catch {
        throw new RpcError(-32602, `No such path: ${root}`);
      }
      if (!stats.isDirectory()) throw new RpcError(-32602, `Not a directory: ${root}`);
      const text = debtLedgerText(root);
      if (args.write !== true) return text;
      const ledgerFile = path.join(root, LEDGER_FILE);
      fs.writeFileSync(ledgerFile, debtLedgerMarkdown(root), 'utf8');
      return `${text}\n\nWrote ${ledgerFile}.`;
    }
    default:
      throw new RpcError(-32602, `Unknown tool: ${params?.name}`);
  }
}

// ---------------------------------------------------------------------------
// Resources

const RULES_RESOURCE = {
  uri: 'ponytail://rules',
  name: 'ponytail-rules',
  title: 'Ponytail ruleset (active level)',
  mimeType: 'text/markdown',
  description: 'The ponytail rules injected for the active level.',
};
const CONFIG_RESOURCE = {
  uri: 'ponytail://config',
  name: 'ponytail-config',
  title: 'Ponytail levels and config',
  mimeType: 'application/json',
  description: 'Active level, the level new sessions start at, and the config file path.',
};

function resourceList() {
  return [
    RULES_RESOURCE,
    ...SKILL_NAMES.map((name) => {
      const { meta } = readSkillFile(name);
      return {
        uri: `ponytail://skill/${name}`,
        name,
        title: meta.name || name,
        mimeType: 'text/markdown',
        description: meta.description || `${name} command.`,
      };
    }),
    CONFIG_RESOURCE,
  ];
}

function readResource(uri) {
  if (uri === RULES_RESOURCE.uri) {
    return { uri, mimeType: 'text/markdown', text: rulesText(effectiveMode()) };
  }
  if (uri === CONFIG_RESOURCE.uri) {
    const { mode, source } = defaultModeInfo();
    return {
      uri,
      mimeType: 'application/json',
      text: JSON.stringify(
        {
          level: effectiveMode(),
          levelSource: state.mode ? 'session' : source,
          defaultLevel: mode,
          configFile: getConfigPath(),
          workspace: workspace(),
          levels: VALID_MODES,
          usage: USAGE,
        },
        null,
        2,
      ),
    };
  }
  const skill = /^ponytail:\/\/skill\/(.+)$/.exec(uri);
  // Unknown names are a resource-not-found, not a bad-params: the list is dynamic.
  if (!skill || !SKILL_NAMES.includes(skill[1])) throw new RpcError(-32002, `Resource not found: ${uri}`);
  return { uri, mimeType: 'text/markdown', text: commandText(skill[1], '') };
}

// ---------------------------------------------------------------------------
// Prompts

function promptList() {
  const fromSkill = (name) => {
    const { meta } = readSkillFile(name);
    return { name, description: meta.description || `${name} command.`, arguments: [] };
  };
  return [
    {
      name: 'ponytail',
      description: 'Switch ponytail on at a level, or report the current one.',
      arguments: [
        { name: 'mode', description: `one of: ${VALID_MODES.join(', ')}`, required: false },
      ],
    },
    {
      ...fromSkill('ponytail-review'),
      arguments: [
        {
          name: 'target',
          description: 'what to review: uncommitted (default), staged, a branch, a PR link, or paths',
          required: false,
        },
      ],
    },
    {
      ...fromSkill('ponytail-audit'),
      arguments: [
        { name: 'target', description: 'what to audit: the repo (default), a folder or a package', required: false },
      ],
    },
    fromSkill('ponytail-debt'),
    fromSkill('ponytail-gain'),
    fromSkill('ponytail-help'),
  ];
}

function promptMessages(name, args) {
  if (name === 'ponytail') {
    const requested = typeof args.mode === 'string' ? args.mode.trim() : '';
    if (requested) {
      return setMode(requested, args.persist === true);
    }
    // No level: keep the current one, or switch on at the default level if ponytail
    // was off (upstream /ponytail command semantics).
    if (effectiveMode() === 'off') {
      const fallback = defaultModeInfo().mode;
      state.mode = fallback === 'off' ? 'full' : fallback;
    }
    return rulesText(effectiveMode());
  }
  if (!SKILL_NAMES.includes(name)) throw new RpcError(-32602, `Unknown prompt: ${name}`);
  return commandText(name, typeof args.target === 'string' ? args.target.trim() : '');
}

// ---------------------------------------------------------------------------
// Dispatch

function initializeResult(params) {
  const requested = params?.protocolVersion;
  return {
    protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : PROTOCOL_VERSION,
    capabilities: {
      tools: { listChanged: false },
      resources: { subscribe: false, listChanged: false },
      prompts: { listChanged: false },
    },
    serverInfo: { name: 'ponytail', title: 'Ponytail', version: VERSION },
    instructions: serverInstructions(effectiveMode()),
  };
}

async function handle(message) {
  const { id, method, params } = message;
  const isRequest = id !== undefined && id !== null;
  switch (method) {
    case 'initialize':
      return reply(id, initializeResult(params));
    case 'notifications/initialized':
      void ensureWorkspace();
      return;
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: TOOLS });
    case 'tools/call':
      return reply(id, { content: [{ type: 'text', text: await callTool(params) }] });
    case 'resources/list':
      return reply(id, { resources: resourceList() });
    case 'resources/templates/list':
      return reply(id, {
        resourceTemplates: [
          {
            uriTemplate: 'ponytail://skill/{name}',
            name: 'ponytail-skill',
            title: 'Ponytail command',
            mimeType: 'text/markdown',
            description: `One of: ${SKILL_NAMES.join(', ')}.`,
          },
        ],
      });
    case 'resources/read':
      return reply(id, { contents: [readResource(params?.uri)] });
    case 'prompts/list':
      return reply(id, { prompts: promptList() });
    case 'prompts/get': {
      const text = promptMessages(params?.name, params?.arguments || {});
      return reply(id, { description: `ponytail: ${params.name}`, messages: [{ role: 'user', content: { type: 'text', text } }] });
    }
    default:
      if (isRequest) fail(id, -32601, `Method not found: ${method}`);
  }
}

function dispatchLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    fail(null, -32700, 'Parse error');
    return;
  }
  // A response to a request we sent (roots/list).
  if (message?.method === undefined && message?.id !== undefined) {
    pendingRequests.get(message.id)?.(message);
    return;
  }
  handle(message).catch((error) => {
    if (message?.id === undefined || message?.id === null) {
      log(String(error?.stack || error));
      return;
    }
    fail(message.id, error instanceof RpcError ? error.code : -32603, error?.message || 'Internal error');
  });
}

// ---------------------------------------------------------------------------
// Startup

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) dispatchLine(line);
  }
});
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(0));
log(`ready (v${VERSION}, level: ${effectiveMode()})`);
