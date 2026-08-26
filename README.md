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
| `/pd [--no-repo] [--research\|--no-research] <topic>` | write | create `discussions/<date>-<slug>/`, boot the slots, run **round 0** — every panelist answers independently, zero cross-contamination |
| `/pd-debate [n]` | write | run `n` debate rounds; each panelist sees the others' **labeled** positions from the previous round and may revise or hold |
| `/pd-steer <text>` | write | inject verbatim steering into every panelist's next round |
| `/pd-ask <slot> <q>` | write | press one panelist directly, its session context intact — never added to the peer set |
| `/pd-synthesize` | write | feed the collected rounds to the moderator and write `synthesis.md` |
| `/pd-abort` | write | cancel the in-flight round |
| `/pd-status` | read | slots, models, per-slot tokens/cost, current round |
| `/pd-resume <dir>` | read→write | reopen a past discussion, restoring per-slot sessions |
| `/pd-close` | write | dispose the panel and clear the open discussion; artifacts stay on disk |

Typical flow: `/pd` → read round 0 → `/pd-steer` or `/pd-ask` → `/pd-debate` → `/pd-synthesize`.

## Web research (optional)

Off by default. With `research: true` in your `panel.yaml` — or `/pd --research <topic>` for one discussion — each panelist gets two extra tools, `web_search` and `fetch_url`, both wrapping [Exa](https://exa.ai). Search results come back with the page text inline, so a panelist can check a claim and quote the source in the same call rather than arguing from memory.

**The key never goes in this repo** — there is no `auth.json` here and no credential template to fill in. It lives in pi's own credential store, `~/.pi/agent/auth.json`, alongside your model keys, under the provider id `exa`:

```jsonc
{
  "anthropic":  { "type": "api_key", "key": "…" },
  "exa":        { "type": "api_key", "key": "your-exa-key" }
}
```

The `key` may instead be the *name* of an environment variable holding the value. `EXA_API_KEY` in the environment takes precedence over the stored entry either way. The entry is re-read on every call, so a key added mid-session works without restarting the panel.

Exa reports what it charged on every response, so search spend is metered rather than estimated: it counts toward `max_cost` like model spend, shows in the footer as `(search $0.041)`, and is stamped per round into `meta.yaml` so resuming a discussion does not hand it a fresh budget. Without a key configured, `/pd --research` is refused up front rather than discovered mid-round by five panelists at once.

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
cp panel.yaml.example panel.yaml
bun run typecheck
bun test test/
```

Then edit `panel.yaml` to pick your slots — 2–5 of them, each `name` / `model` / `thinking` / `color`, plus an optional `persona`. Each `model` is a `provider/id` **your** pi resolves, so take the ids from pi's own `/model` picker rather than from the example.

`panel.yaml` holds no secrets — auth, model keys and the optional Exa key alike, comes from the normal `agentDir` `auth.json` that pi already reads. It is gitignored anyway: it names the models this machine resolves and pays for, which is yours to choose, not the project's to ship. [`panel.yaml.example`](panel.yaml.example) is the tracked twin.

## Live smoke

`bun test test/` makes zero paid calls, which means it cannot cover the seven paths in [`docs/DESIGN.md`](docs/DESIGN.md) §15 — session files, resume, mid-round abort, session replacement, cross-provider dispatch, and a real Exa call only exist against live providers. Those live in a separate, opt-in runner:

```bash
bun run smoke:rpc
```

It drives a real `pi --mode rpc` process over JSONL with a scratch working directory, a scratch session directory, and a generated two-slot panel — the cheapest `anthropic` and cheapest `deepseek` models the registry offers, at `thinking: low` with a hard `max_cost` of $0.50. Each check prints PASS / FAIL / SKIP with its evidence, and the run exits nonzero if any check fails.

**Prerequisites:** `pi` on `PATH`, and `anthropic`, `deepseek`, and `exa` credentials in pi's own `~/.pi/agent/auth.json`. A missing Exa key downgrades the research check to SKIP rather than failing the run.

**Cost:** about **$0.05 per run** — two cheap models, one short question, two rounds cut short on purpose, one `/pd-ask`, and one research round. `bun run test` never invokes it, and nothing in CI should.

The scratch workspace under `.smoke/` is deleted on a green run and kept for inspection on a failure, or always with `SMOKE_KEEP=1`.

Install for use: add `pi-discuss/src/index.ts` to pi's extension sources in `settings.json`, or symlink it into `~/.pi/agent/extensions/`.

## Status

Built — core loop, discussion mechanics, and research tools. Targets `@earendil-works/pi-coding-agent` `^0.84.3`. Tests are deterministic and make zero paid calls: they stub at the `PanelistSession` seam for the round loop and at the `ResearchBackend` seam for search, both structural subsets of the real thing, so the compiler still checks that a real session and a real backend satisfy them.

`docs/DESIGN.md` §15 lists the first-run verification paths that only exist against a live provider. All seven ran green on 2026-08-27 and are now automated as `bun run smoke:rpc` (above) — check there before debugging a first-run failure from scratch.

## License

MIT
