# ponytail-mcp

[Ponytail](https://github.com/DietrichGebert/ponytail) — "the best code is the code you never wrote" — as an MCP server. Built for [OMP](https://github.com/can1357/oh-my-pi); works in any MCP host.

Ponytail ships as a prompt file. Loading it into every session of every agent, switching level mid-task, and harvesting the `ponytail:` shortcuts you deferred all need a host adapter. This is that adapter, over MCP: the ruleset is injected through the server `instructions` field (main session *and* subagents), the six commands are MCP prompts and resources, and the debt ledger is a real tool.

Single file of runtime code, zero dependencies: node's standard library only.

## Register it with OMP

Clone this repo anywhere — no build step, no dependencies:

```sh
git clone https://github.com/Louis23-1/MCP-ponytail-for-omp-.git
```

Then add to `~/.omp/agent/mcp.json` (user level) or `.omp/mcp.json` (project level):

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "ponytail": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/MCP-ponytail-for-omp-/server.mjs"]
    }
  }
}
```

Then `/mcp reload`. Point `args` at your clone; on Windows use forward slashes (`C:/path/to/MCP-ponytail-for-omp-/server.mjs`). `command` must be a `node` OMP can spawn — use an absolute path if it is not on PATH.

Nothing else to add to a project: OMP appends the server's instructions to the system prompt, so ponytail is on from the first turn. `/ponytail` and `/ponytail-review`, `/ponytail-audit`, `/ponytail-debt`, `/ponytail-gain`, `/ponytail-help` are registered as prompt commands.

## What it exposes

| Tool | What it does |
|---|---|
| `ponytail_mode` | Report or switch the level (`lite`, `full`, `ultra`, `review`, `off`). `persist: true` stores it as the level new sessions start at. |
| `ponytail_skill` | Load one ponytail command verbatim and follow it: `ponytail`, `ponytail-review`, `ponytail-audit`, `ponytail-debt`, `ponytail-gain`, `ponytail-help`. |
| `ponytail_debt` | Scan the repo for `ponytail:` shortcut comments: file, line, the ceiling each names, the trigger to revisit it, and the rows that name no trigger at all. `write: true` saves the ledger as `PONYTAIL-DEBT.md`. |

MCP prompts `ponytail`, `ponytail-review`, `ponytail-audit`, `ponytail-debt`, `ponytail-gain`, `ponytail-help` carry the same commands for user invocation. MCP resources `ponytail://rules`, `ponytail://skill/<name>` and `ponytail://config` carry the same text for `read` (`mcp://ponytail://rules` or bare `ponytail://rules` in OMP).

`ponytail_mode`, the `/ponytail` prompt, and `ponytail_skill(ponytail)` return the filtered ruleset, so switching level mid-session re-injects the rules the model must follow.

## Levels and configuration

Resolution order, identical to the upstream hooks: `PONYTAIL_DEFAULT_MODE` environment variable, then `defaultMode` in the shared config file, then `full`.

Config file: `$XDG_CONFIG_HOME/ponytail/config.json` when set, else `%APPDATA%\ponytail\config.json` on Windows, else `~/.config/ponytail/config.json`. Same file the upstream Claude Code/Codex hooks read, so a level persisted by either is honoured by both. `review` is session-only and cannot be a default (upstream #377).

## Prompts are vendored from upstream

`prompts/*.md` are the upstream `skills/*/SKILL.md` files, pinned in `prompts/UPSTREAM.json` with the commit they came from; `prompts/LICENSE` is upstream's MIT license. Refresh them with:

```sh
npm run sync
```

`lib/ponytail.mjs` ports `hooks/ponytail-instructions.js` line-filtering exactly: for `lite`, `full` and `ultra` the injected text is byte-identical to what the upstream hooks inject. `off` and `review` differ on purpose — an MCP server has no hook that can cancel an injection already in the system prompt, so those two levels state explicitly that the rules are inactive or delegated.

## Development

```sh
npm test          # unit tests for levels, config and the ledger, plus a real stdio session
npm start         # run the server standalone
```

## License

MIT — see `LICENSE`. The vendored prompts under `prompts/` are from [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail), MIT — see `prompts/LICENSE`.
