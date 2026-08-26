# pi-discuss

A [pi](https://github.com/earendil-works/pi) **extension** that convenes a panel of 2–5 agents, each on a **different** frontier model, on one topic: they answer independently, then debate across rounds, then your own session synthesizes where they agree, disagree, and what only one of them raised.

Betting on one model inherits its blind spots — a wrong-but-fluent answer is indistinguishable from a right one when there is nothing to disagree with it. The product is the **divergence map**, not a consensus: model diversity is the mechanism and forced agreement destroys it, so there is deliberately no ACK/consensus ritual. See [`docs/DESIGN.md`](docs/DESIGN.md).

Interactive sibling of the gated services `pi-deployment-manager` and `pi-pages`: same tool-layer discipline, but **you** are the caller sitting in the session, and the deliverable is prose you read rather than a JSON result a driver greps for.

## What it is (and isn't)

- **Is:** a research and discussion instrument. Nothing writes the repo — panelists are read-only at the tool layer, and the extension writes only under `discussions/`.
- **Isn't:** a code-fusion harness. No parallel implementations, no merge, no auto-advance — every round is user-initiated, because a panel that keeps debating unattended is a bill, not a feature.

## Topology

The host session is the **moderator** — your model, your context. Panelists are child `AgentSession`s created in-process, one per slot, sharing one `ModelRuntime`.

```
host pi session  (moderator: your model, your context)
  │
  ├─ /pd-* ──▶ extension code  (rounds · guards · artifact writer)
  │                 │  createAgentSession() × N, in-process, one per slot
  │                 ├── claude    anthropic/…    sessions/claude.jsonl
  │                 ├── gpt       openai/…       sessions/gpt.jsonl
  │                 └── deepseek  deepseek/…     sessions/deepseek.jsonl
  │                 │
  │  ◀── pi.appendEntry ─────────  renders + persists, NOT in moderator context
  │  ── pi.sendMessage ──────────▶  ONCE per synthesis: the round enters context
```

Panel answers render and persist without entering the moderator's LLM context — that is what makes the panel affordable. Exactly one deliberate injection happens, at `/pd-synthesize`.

## Commands

| command | r/w | does |
|---|---|---|
| `/pd [--no-repo] <topic>` | write | create `discussions/<date>-<slug>/`, boot the slots, run **round 0** — every panelist answers independently, zero cross-contamination |
| `/pd-debate [n]` | write | run `n` debate rounds; each panelist sees the others' **labeled** positions from the previous round and may revise or hold |
| `/pd-steer <text>` | write | inject verbatim steering into every panelist's next round |
| `/pd-ask <slot> <q>` | write | press one panelist directly, its session context intact — never added to the peer set |
| `/pd-synthesize` | write | feed the collected rounds to the moderator and write `synthesis.md` |
| `/pd-abort` | write | cancel the in-flight round |
| `/pd-status` | read | slots, models, per-slot tokens/cost, current round |
| `/pd-resume <dir>` | read→write | reopen a past discussion, restoring per-slot sessions |
| `/pd-close` | write | dispose the panel and clear the open discussion; artifacts stay on disk |

Typical flow: `/pd` → read round 0 → `/pd-steer` or `/pd-ask` → `/pd-debate` → `/pd-synthesize`.

## Artifacts are the product

Everything lands in a durable per-discussion directory under the cwd — not `/tmp`:

```
discussions/2026-08-26-topic-slug/
  topic.md               # the prompt + every steering injection, timestamped
  meta.yaml              # panel snapshot, per-round outcomes, tokens, cost
  round-0/claude.md      # independent opinions
  round-1/claude.md      # debate rounds (each notes: revised / held, and why)
  synthesis.md           # the divergence map
  sessions/claude.jsonl  # one pi session per slot — resume + post-hoc digging
```

`sessions/` lives **inside** the discussion dir: a discussion is one self-contained thing to keep, delete, or publish.

## Setup

```bash
bun install
bun run typecheck
bun test test/
```

No config secrets: auth comes from the normal `agentDir` `auth.json` that `ModelRuntime` already reads, so [`panel.yaml`](panel.yaml) is tracked with no `.example` twin. Edit it to pick your slots — 2–5 of them, each `name` / `model` / `thinking` / `color`, plus an optional `persona`.

Install for use: add `pi-discuss/src/index.ts` to pi's extension sources in `settings.json`, or symlink it into `~/.pi/agent/extensions/`.

## Status

Built through the core loop and discussion mechanics; the research-tool stage is deferred. Targets `@earendil-works/pi-coding-agent` `^0.84.3`. Tests are deterministic and make zero paid calls — they stub at the `PanelistSession` seam, a structural subset of `AgentSession`, so the compiler still checks that a real session satisfies it.

`docs/DESIGN.md` §15 lists the first-run verification paths that compile but have never executed against a live provider — check there before debugging a first-run failure from scratch.

## License

MIT
