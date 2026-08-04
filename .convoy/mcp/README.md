# KeeperHub MCP — the two authentication paths

Convoy talks to KeeperHub over **two separate surfaces with two separate auth mechanisms**. They are
not interchangeable, and collapsing them would break the product.

| Surface                               | Auth                   | Who uses it                                              | Config                                                  |
| ------------------------------------- | ---------------------- | -------------------------------------------------------- | ------------------------------------------------------- |
| **Interactive** — Claude Code session | Browser **OAuth 2.1**  | a developer at a terminal, and the judged MCP evaluation | the KeeperHub plugin's own `.mcp.json` (no auth header) |
| **Headless** — runtime execution      | `kh_` **Bearer** token | `packages/kh-client`, `services/worker`, CI              | [`mcp.json`](mcp.json) in this directory                |

Both point at the same endpoint, `https://app.keeperhub.com/mcp`. The difference is entirely in how
the caller proves who it is.

## CONSTRAINT — the runtime never uses OAuth

**`packages/kh-client` and `services/worker` stay on `kh_` Bearer authentication. This is not a
decision to revisit.**

They run unattended — a BullMQ worker draining a queue, a Vercel function answering a request, a CI
job. None of them has a browser, a human, or anywhere to put a consent screen. An OAuth flow needs
all three. Migrating them would mean the worker blocks forever on a sign-in that nobody is there to
complete, and CVY-004's entire execution path depends on Bearer auth working exactly as it does.

The plugin is a **development convenience and an evaluation surface**. It must never become a runtime
dependency of Convoy's production execution path. If the plugin is uninstalled, Convoy's execution is
unaffected — that is the test of whether this boundary is intact.

## The KeeperHub Claude Code plugin

```
/plugin marketplace add KeeperHub/claude-plugins
/plugin install keeperhub@keeperhub-plugins
/keeperhub:login
/keeperhub:status
```

These are **Claude Code REPL commands typed by a human**, not shell commands. An agent session cannot
run them, and `/keeperhub:login` opens a browser for OAuth consent.

### Inventory — from the published manifest, **not** from a running install

Measured 2026-08-04 by cloning `github.com/KeeperHub/claude-plugins` at `d3ba890` and reading the
artifact. Marketplace `keeperhub-plugins`, plugin `keeperhub` **v4.0.0**, MIT.

**Slash commands (2)**

| Command             | Purpose                                                             |
| ------------------- | ------------------------------------------------------------------- |
| `/keeperhub:login`  | Authorize via browser OAuth, **or** set an API key for headless use |
| `/keeperhub:status` | Connection, auth state, available tools                             |

**Skills (5)**

| Skill               | Relevance to Convoy                                                     |
| ------------------- | ----------------------------------------------------------------------- |
| `workflow-builder`  | **Not used.** Architecture §3 rules out the Workflow Builder (gap G-07) |
| `template-browser`  | **Not used.** Same reason — templates build workflows                   |
| `plugin-explorer`   | Discovery only                                                          |
| `execution-monitor` | Potentially useful for debugging executions during development          |
| `keeperhub-wallet`  | The x402 agentic wallet — relates to CVY-017, gated on G-06 and G-17    |

**MCP server declared by the plugin:**

```jsonc
{ "mcpServers": { "keeperhub": { "type": "http", "url": "https://app.keeperhub.com/mcp" } } }
```

### What this inventory does and does not establish

It establishes the surface the plugin _declares_. It does **not** establish what the MCP server
returns once authenticated — the tool list, their schemas, or how they differ from the raw `/mcp`
surface Convoy already reaches with a Bearer token. **That measurement is still owed** and requires
an interactive session; see gap **G-25**.

Two things are already clear from the artifact and worth stating:

1. **The plugin adds no new endpoint.** Its `.mcp.json` points at the same
   `https://app.keeperhub.com/mcp` that `mcp.json` here already uses. The plugin is an OAuth wrapper
   plus prompt-level skills over the same server — so it cannot expose execution capability that
   Bearer auth does not.
2. **Three of its five skills are things Convoy deliberately does not do.** `workflow-builder` and
   `template-browser` drive the Workflow Builder, which Architecture §3 omits and G-07 resolves
   against. Installing the plugin must not be read as an invitation to use them.

The plugin's own `status.md` reads `KH_API_KEY` — note the name differs from Convoy's
`KEEPERHUB_API_KEY`. Do not rename Convoy's variable to match; the plugin is not Convoy's runtime.
