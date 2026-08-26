# pi-discuss — Locked Design

> A pi **extension** that convenes a panel of 2–5 agents, each backed by a **different** frontier
> model, on one topic: they answer independently, then debate across rounds, then the host session
> synthesizes where they agree, disagree, and what only one of them raised. Absorbs the read-only half
> of [disler/fusion-harness](https://github.com/disler/fusion-harness) — its "AND, not OR" thesis
> applied to *research and discussion*, not code. Nothing here writes the repo; the deliverable is a
> durable, inspectable discussion record. Interactive sibling of the gated services
> `pi-deployment-manager` and `pi-pages`: it borrows their tool-layer discipline but is **not** an RPC
> agent (§2). Read alongside [`../../docs/building-pi-agents.md`](../../docs/building-pi-agents.md).
>
> Status: **BUILT — all three §18 stages, research included** (2026-08-26). Targets
> `@earendil-works/pi-coding-agent` `^0.84.3` — the ModelRuntime API generation (`AuthStorage` left
> the exports in 0.80.8). Sections below describe what the code does; §15's first-run verification
> list ran green against live providers on 2026-08-27 and is now automated as `bun run smoke:rpc`.

## 1. Problem & goal — betting on one model inherits its blind spots

**Today:** a hard research question goes to whichever model the session is running, and its training
run decides which considerations surface and which never come up. A wrong-but-fluent answer is
indistinguishable from a right one, because there is nothing to disagree with it.

**Goal:** make disagreement visible. Run the same question through several frontier models
independently, let them argue, and keep the **divergence map** — "all five agree on X; Claude and
Gemini split on Y for these reasons; only DeepSeek raised Z" — which is what tells you where to dig.
Model diversity is the mechanism and forced consensus destroys it, so there is deliberately **no**
fusion-harness-style ACK/consensus ritual (§17).

## 2. Topology — interactive tool, not a gated service

The siblings are **services**: a caller summons them over RPC, they gate an LLM behind semantic verbs,
they return a structured result. pi-discuss inverts that — **you** are the caller, sitting in the
session, and the product is prose you read, not a JSON result a driver greps for.

- **Host session = moderator.** You run `pi` with the extension loaded; your session routes the
  `/pd-*` commands and performs synthesis with **its own** model. The moderator is the host, never a
  panel slot.
- **Panelists = child `AgentSession`s**, one per slot, created in-process (§2.1).
- **No RPC surface, no result event, no config secrets** — auth comes from the normal `agentDir`
  `auth.json` that `ModelRuntime` already reads, so `panel.yaml` holds nothing secret. It is still
  untracked, because secret-free is not the same as portable (§3).

Two principles from [`../../docs/building-pi-agents.md`](../../docs/building-pi-agents.md) still bind,
because they are code facts rather than service ceremony: **read-only is enforced at the tool layer,
not by prompt** (§5), and **capabilities are wrapped, not exposed** — the deferred research stage
gives panelists a custom `fetch_url` whose *code* does the fetching, never raw bash to curl with.

### 2.1 Run mode — in-process SDK children on one shared ModelRuntime

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

**One `ModelRuntime`, shared by every panelist.** `prepareRequest` resolves provider + auth per call
and holds no shared mutable state, so concurrent panelists on *different* providers are safe against
one runtime. **Never share one `AgentSession` across concurrent prompts** — a session is one
transcript, which is why `pi-4b-tester` serializes onto a promise chain. Here the rule is free: one
slot, one session, one in-flight prompt.

### 2.2 Rejected: subprocess clean-room children

fusion-harness spawns each model as a separate `pi` process. Same capability, much more plumbing —
JSON-stream parsing, escalating termination ladders, no type safety across the boundary — and cleanup
becomes signal handling instead of `dispose()`. In-process children cost one thing: a panelist fault
lands in *our* process, so every slot call is wrapped and demoted to an outcome (§7) rather than
allowed to reject the round.

## 3. Panel config — `panel.yaml`, personal and untracked, no secrets

`panel.yaml` is gitignored; `panel.yaml.example` is the tracked twin, and the first install step is
copying one to the other. It holds no secrets — auth is the `agentDir` `auth.json` (§2) — but
secret-free was never the test. The file names which models *this* install resolves and bills, and a
`provider/id` is only as real as the reader's own `auth.json` and model registry: a tracked default
panel is a list of slots that fail to resolve on someone else's machine, presented as if it were the
project's configuration. Personal machine config gets an example, not a checked-in value.

```yaml
panel:
  - name: claude
    model: anthropic/claude-fable-5
    thinking: high
    color: accent
    persona: ""            # optional system-prompt append; empty = model diversity only
  - name: gpt
    model: openai/gpt-5.2  # the example leaves this slot commented: ids differ per install
    thinking: high
    color: success
  - name: deepseek
    model: deepseek/deepseek-v4
    thinking: medium
    color: warning
defaults:
  rounds: 2                # debate rounds after the independent round
  repo_access: true        # panelists may read the cwd repo
  research: false          # web_search / fetch_url via Exa; needs an "exa" key in pi's auth.json
  max_cost:                # unset ⇒ soft cap + warning; set ⇒ hard refusal (§8.5)
```

- **`name`** — unique slug; it is the artifact filename, the render label, the `/pd-ask` target, and
  the session filename. 2–5 slots, or the panel is refused.
- **`model`** — `provider/id`, resolved at startup through `modelRuntime.getModel()`. The importable
  `getModel` from `pi-ai` is stale; the runtime is the only source.
- **`thinking`** — `off|minimal|low|medium|high|xhigh|max`, clamped to what the model supports.
- **`color`** — a **named `ThemeColor` token** (`accent`, `success`, `warning`, `mdLink`,
  `customMessageLabel`, …), not hex. `theme.fg(color, text)` takes a closed union and there is no
  truecolor helper, so hex is not merely ugly — it does not typecheck — and a fixed token palette
  stays legible when the user is on a light theme.
- **`persona`** — one appended system-prompt line (§9). Optional and empty by default: model
  diversity first, role diversity as a deliberate config choice.
- **`repo_access`** — default `true`; drives `noContextFiles` on the panelist loader (§5), overridable
  per discussion with `/pd --no-repo`.
- **`research`** — default `false`; adds the Exa-backed `web_search` / `fetch_url` tools (§5.1),
  overridable per discussion with `/pd --research` / `/pd --no-research`. Still secret-free: the key
  lives in pi's `auth.json`, never here.

Dropped from the fusion-harness model-stack this descends from: architect/primary role flags. The
moderator is the host session, not a slot.

## 4. Command surface — `/pd-*`, locked

| command | r/w | does |
|---|---|---|
| `/pd [--no-repo] [--research\|--no-research] <topic>` | write | create `discussions/<date>-<slug>/`, boot the slot sessions, run **round 0** — every panelist answers independently, zero cross-contamination |
| `/pd-debate [n]` | write | run `n` debate rounds (default `defaults.rounds`); each panelist receives the others' **labeled** positions from the previous round and may revise or hold |
| `/pd-steer <text>` | write | inject verbatim steering into every panelist's next round ("focus on cost, ignore latency") |
| `/pd-ask <slot> <q>` | write | press one panelist directly, its session context intact |
| `/pd-synthesize` | write | feed the collected rounds to the moderator and write `synthesis.md` |
| `/pd-abort` | write | cancel the in-flight round (§12) |
| `/pd-status` | read | slots, models, per-slot tokens/cost, current round |
| `/pd-resume <dir>` | read→write | reopen a past discussion, restoring per-slot sessions |
| `/pd-close` | write | dispose the panel and clear the open discussion; artifacts and slot sessions stay on disk, so `/pd-resume` reopens it |

`read ≠ write`: `/pd-status` touches nothing and writes no artifact; `/pd-resume` reads and validates
before it opens anything for writing (§8.4).

**`/pd-ask` writes no round artifact.** Its exchange persists in that slot's own
`sessions/<slot>.jsonl` — which is exactly what "session context intact" means — and renders as a
panelist block. It is never added to the peer set, so pressing one panelist cannot leak its answer
into another's next round.

**`/pd-close` exists because one discussion is open at a time.** Without it `/pd` refuses for the rest
of the session once a discussion has been opened, and restarting `pi` becomes the only way to convene
a second panel. It aborts nothing: a round in flight refuses the close.

`registerCommand` hands the handler the **raw argument remainder**, so every command parses its own
args in code; `getArgumentCompletions` supplies slot names for `/pd-ask` and existing discussion dirs
for `/pd-resume`. Name collisions are auto-suffixed by pi (`/pd:1`), so the prefix choice is cosmetic
rather than a correctness risk — `/pd-*` is locked.

**You stay in the loop between rounds. Nothing auto-advances.** Typical flow: `/pd` → read round 0 →
`/pd-steer` or `/pd-ask` → `/pd-debate` → `/pd-synthesize`.

## 5. Panelist tool surface — read-only at the tool layer

| capability | scope |
|---|---|
| **read** | `tools: ["read", "grep", "find", "ls"]` — the allowlist mechanically excludes `write`/`edit`/`bash`/`powershell`. Repo context files load only when `repo_access: true`. |
| **network** | none unless `research` is on, which adds `web_search` / `fetch_url` as `defineTool` custom tools, **named explicitly** in `tools` — an allowlist does not auto-include custom tools, so registering them without naming them would hand every panelist a tool it is forbidden to call. Both wrap Exa; a panelist gets no raw HTTP (§5.1). |
| **write** | none, ever. Only the extension's artifact writer touches disk. |
| **denied** | `write`, `edit`, `bash`, `powershell`; and via the loader: extensions, skills, prompt templates, themes. |

Each panelist gets **its own `DefaultResourceLoader`** — one per slot, because each carries a
different persona — built as `{ cwd, agentDir, systemPrompt, appendSystemPrompt: [persona],
noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles:
!repo_access }`, then `await loader.reload()`. `createAgentSession` has no `systemPrompt` option; the
loader is the only route.

**`noExtensions: true` is load-bearing.** A default loader discovers `.pi/extensions/` and would
recursively re-instantiate pi-discuss *inside every panelist* — a panel that convenes a panel. The
field-proven precedent is `createWarmJudge` in
[`../../pi-4b-tester/hub/verdict.ts`](../../pi-4b-tester/hub/verdict.ts)`:391`, which builds the same
loader shape; pi-discuss diverges from it in exactly three places — a persistent `SessionManager`
instead of `inMemory()` (§10), the read-only tool allowlist above, and `noContextFiles: false` when
`repo_access` is on.

### 5.1 Web research — Exa, wrapped, metered

**Off by default** (`defaults.research: false`), because it spends money outside the model ledger and
needs a credential pi may not hold. `/pd --research` and `/pd --no-research` override per discussion;
the choice is recorded in `meta.yaml` so a resume restores the same capability set.

**Backend: Exa** (`POST https://api.exa.ai/search`, `/contents`), chosen over prime-agent's Serper for
three reasons that are properties of the API, not preferences:

1. `contents` returns page text **inline with the search**, so one credential and one round-trip cover
   both `web_search` and `fetch_url`. Serper returns snippets and would need a separate fetcher.
2. The response carries **`costDollars`**, so §8.5 meters what was actually charged rather than an
   estimate. This is what makes search spend governable at all.
3. A key was already provisioned for it.

**The credential never enters this repo.** It lives in pi's own `auth.json` under the provider id
`exa`, read through `readStoredCredential` — the same store already holding the model keys — with
`EXA_API_KEY` taking precedence when set. It is read **on every call**, not cached at boot, so a key
added mid-session works without restarting the panel (prime-agent's rationale for the same pattern).
A stored value may be a literal or the *name* of an env var; a `!command` ref is resolved by pi at
login time and reads as absent here rather than as a broken key.

**Failure is a lost source, not a lost turn.** A 429, an unreachable host, unreadable JSON — all come
back to the panelist as explanatory text (§7's "record the non-answer" applied at the tool layer). Two
exceptions: a caller abort propagates so `/pd-abort` still ends the turn (§12), and a *missing key* is
refused at `/pd` time by the §8.1 readiness guard rather than discovered mid-round by five panelists
at once. Exa reports per-URL fetch failures out-of-band in `statuses`; those are surfaced as labelled
"Not retrieved" hits, so a page that 404s is visible rather than silently absent.

**Clamped, not trusted.** `num_results` ≤ 10, `max_characters` ≤ 10,000 (Exa's own ceiling), fetch
batches ≤ 5 URLs with the dropped tail named in the result. A panelist that asks for 100 full pages
would otherwise bury its own context before it answered.

## 6. Round lifecycle — dispatch → concurrency → timeout → capture → finish

The behavioral template is the 5-step intent lifecycle in
[`../../pi-4b-tester/docs/architecture.md`](../../pi-4b-tester/docs/architecture.md)`:164`.

1. **Dispatch** — build each slot's prompt from the named prompt module (§9). Round 0 receives the
   topic and nothing else; debate rounds receive the previous round's peer answers labeled by slot
   name, plus any pending `/pd-steer` text. **Steering is consumed only once the round that carried it
   is on the record** — command handlers genuinely re-enter (the interactive mode does not await
   `onSubmit`), so a second `/pd-debate` arriving mid-round is refused, and clearing the pending text
   before the round commits would let that refusal silently destroy it.
2. **Concurrency** — all slots fire together, collected with `Promise.allSettled`. One in-flight
   prompt per session; one shared `ModelRuntime` (§2.1).
3. **Timeout** — each slot races its prompt against a timer (`DEFAULT_ROUND_TIMEOUT_MS`, 10 minutes)
   and the discussion's `AbortSignal`; on
   either, `await session.abort()` runs before the outcome is recorded. Pattern lifted from
   [`../../pi-4b-tester/hub/verdict.ts`](../../pi-4b-tester/hub/verdict.ts)`:458-485`.
4. **Capture** — snapshot `getLastAssistantText()` *before* prompting, then
   `await session.prompt(text, { expandPromptTemplates: false })`, then
   `session.getLastAssistantText()`, then a belt-and-braces `await session.waitForIdle()` (0.84.3
   compacts mid-flight on long turns). `expandPromptTemplates: false` is not optional: debate prompts
   embed other models' output, which routinely contains `/`-prefixed lines that would otherwise expand
   as templates. `prompt()` resolves after the run finishes *including retries*, so the
   `agent_end`-vs-`agent_settled` trap in
   [`../../docs/pi-0.84-upgrade-checks.md`](../../docs/pi-0.84-upgrade-checks.md) does **not** apply —
   do not copy the RPC spokes' capture/resolve split here. The pre-prompt snapshot is what makes the
   `timed-out` capture honest: `getLastAssistantText()` falls back to the *previous* round's answer
   when an aborted turn produced nothing, and filing that as partial output would feed a stale
   position into the next round's peer set and into synthesis (§7).
5. **Finish** — write each slot's markdown, update `meta.yaml`, `pi.appendEntry` one block per slot in
   panel order, re-checking the disposed latch (§12) between every await.

**A panelist error mid-round never aborts the round.** It becomes that slot's outcome (§7); the other
slots run to completion and the round artifact is written with the failure recorded in place.

## 7. Per-slot outcome taxonomy — a missing slot is never silently dropped

| outcome | cause | artifact |
|---|---|---|
| `answered` | prompt resolved with non-empty text | the answer |
| `errored` | the SDK call threw (auth, transport, model error) | a stub naming the error |
| `timed-out` | the round budget expired or `/pd-abort` tripped the signal; session aborted | a stub, plus only text *this* turn produced (§6.4) |
| `refused` | the model returned a refusal or empty text | a stub with the raw reply |

Silence is not agreement. The synthesis prompt is handed the taxonomy, not just the answers, so it
says "gpt timed out on round 2" instead of quietly presenting a four-model panel as five-model
consensus. `meta.yaml` records the outcome per slot per round, so a discussion whose divergence map
looks unanimous can be audited for whether it *was*.

## 8. Guards — fail-closed, in code

1. **Startup model + auth guard** — at load, every slot's model resolves via
   `modelRuntime.getModel(provider, id)` and its provider passes `hasConfiguredAuth(provider)` (sync,
   cheap). Any failure refuses the panel before a discussion opens. *The failure this prevents: a
   five-slot round burning four models' tokens, then dying on the fifth's missing key.*
2. **Round-0 contamination guard** — the dispatcher asserts the peer set is empty at round 0, **and
   that no steering text is attached**: steering is the moderator's opinion, and §9 gives round 0 the
   topic and nothing else. Nothing about the output would look wrong if either were violated; the
   anti-anchoring property is invisible once broken, so it is checked rather than trusted. The
   practical consequence is that `/pd-steer` only ever reaches debate rounds.
3. **Artifact-dir collision guard** — an existing `<date>-<slug>/` refuses. *The failure this prevents:
   round files appended into a previous discussion's directory, producing a record that reads as one
   debate and isn't.*
4. **Panel-drift guard on `/pd-resume`** — `meta.yaml`'s panel snapshot is compared to the current
   `panel.yaml`; a changed slot set, a changed model, or a changed thinking level for any slot refuses.
   *The failure this prevents: restoring `claude.jsonl` into a slot now pointing at another model,
   yielding one transcript in two models' voices.* Thinking level is in the comparison because
   `createAgentSession` restores the saved level **only when the caller passes none**, and the panelist
   factory always passes the configured one — so without the guard an edited `panel.yaml` would have a
   slot reasoning at a different depth than the snapshot claims for the whole discussion, invisibly.
   `modelFallbackMessage` is **not** the mechanism here: `createAgentSession` sets it only when it had
   to choose a model itself, and every panelist is created with an explicit one. Model resolvability is
   guaranteed ahead of that call by §8.1, and a slot repointed at another model is caught by this guard.
   *`/pd-resume` also refuses while a round is running, and boots the replacement panel before tearing
   down the incumbent, so a failed restore leaves the open discussion untouched.*
5. **Cost guard** — per-slot `session.getSessionStats()` (which reflects what was actually billed,
   including compacted-away history) is summed per discussion. Default is a **soft cap: warn and
   continue** (`DEFAULT_SOFT_CAP_USD`, $5); a `max_cost` set explicitly in `panel.yaml` makes it a
   **hard refusal** at the next round boundary — never mid-round, which would strand a paid-for round
   unwritten. **`/pd-ask` passes the same guard**, since an ask spends real tokens and a limit that
   only gates `/pd-debate` is bypassable one slot at a time.
6. **Boot re-entrancy latch** — `/pd` and `/pd-resume` set a synchronous latch at handler entry.
   *The failure this prevents: two quick submissions racing through the many awaits before the
   discussion is assigned, booting two panels and orphaning N undisposed sessions.*

## 9. Prompts — named, filed, each carrying one guarantee

House rule: no prompt prose inline in this doc. Every prompt lives in `src/modules/prompts/` and is
identified here by name and by the one property it must guarantee. The anti-anchoring rules **are**
these guarantees.

| prompt | guarantee |
|---|---|
| `round-0` | Carries the topic and nothing else — no peer text, no moderator opinion. Panelists never see each other before first commitment. |
| `debate` | Peer positions appear **labeled by slot name**, and each answer must state: what I changed my mind on, what I still dispute, what evidence would move me. Attribution survives into the next round. |
| `synthesis` | Preserves attributed disagreement; averaging positions into mush is forbidden. Unique-to-one-slot points get their own section, and non-`answered` slots are reported as missing (§7), not omitted. |
| `persona-append` | Frames a role only; never states a position on the topic — a persona that pre-commits is anchoring wearing a costume. |
| `steer` | The user's steering text reaches every slot **verbatim and identically**, so a round's divergence stays attributable to the models. Debate rounds only — round 0 refuses it (§8.2). |
| `ask` | `/pd-ask` carries the moderator's question and **no peer text**, so pressing one panelist cannot leak another's position into it. |
| `panelist-system` | The base `systemPrompt` for every slot, replacing pi's coding-agent prompt: panelists reason about a codebase and never propose applied edits (§17), matching the tool surface they actually have (§5). |

## 10. Artifacts are the product, not debug residue

Everything lands in a durable per-discussion directory under the cwd — **not** `/tmp`:

```
discussions/2026-08-26-topic-slug/
  topic.md               # the prompt + every steering injection, timestamped
  meta.yaml              # panel snapshot (models, thinking), per-round outcomes, tokens, cost
  round-0/claude.md      # independent opinions
  round-0/gpt.md
  round-1/claude.md      # debate rounds (each notes: revised / held, and why)
  synthesis.md           # the divergence map
  sessions/claude.jsonl  # one pi session per slot — resume + post-hoc digging
  sessions/gpt.jsonl
```

`sessions/` lives **inside** the discussion dir: a discussion is one self-contained thing to keep,
delete, or publish.

Three format rules the writers owe the readers:

- **Round answers carry YAML front matter** (`slot`, `round`, `model`, `outcome`, `tokens`, `cost`,
  and `error` when there is one) above the human `# slot — round k` heading. `/pd-resume` has to read
  the model's prose back out of these files for the next round's peer set, and a debate answer
  routinely opens with its own heading or bullet list — a prose header leaves no findable boundary.
- **`meta.yaml` is written through a temp file and renamed.** It is rewritten after every round, and a
  crash partway through a bare overwrite leaves an unparseable ledger, which makes the discussion
  permanently unresumable — `/pd-resume` reads this file first (§8.4).
- **A slug that reduces to nothing falls back to a content hash**, not to a fixed word. An all-CJK
  topic strips to empty, and a fixed fallback would make every such topic collide on the same
  directory on a given day, which surfaces as the collision guard (§8.3) refusing rather than as the
  naming problem it is.

**Per-slot session files come from `SessionManager.open("/abs/.../sessions/<slot>.jsonl")`.**
`SessionManager.create()` always generates a `timestamp_uuid` filename and cannot be told to name a
file by slot. `open()` accepts a path that does not exist yet (`_setSessionFile` handles missing and
zero-byte files), which gives **one code path for create and resume** — the parent directory is
`mkdir -p`'d first, and `/pd-resume` is then the same call with the same argument. Pass the
discussion's cwd as `open()`'s third argument: without the override a newly created session header
records `process.cwd()`, which is the pi process's directory rather than the discussion's.
`createAgentSession` restores the transcript from whatever the manager opened; model and thinking
level are always passed explicitly from the current `panel.yaml`, which is why drift is refused
rather than reconciled (§8.4).

The files read fine with no tooling, and a finished discussion is publishable through pi-pages via the
`deploy-pages` skill. This upgrades fusion-harness's "/tmp artifacts for debuggability" into the
deliverable itself.

## 11. Flows

**Open** — `/pd <topic>`: `[startup guard] → slug + mkdir → [collision guard] → open N sessions →
round-0 dispatch → [contamination guard] → allSettled → capture → write round-0/ + meta.yaml →
appendEntry × N`.

**Debate** — `/pd-debate [n]`: `for each round: [cost guard at boundary] → build labeled peer set +
pending steer → dispatch → allSettled → capture → write round-k/ → appendEntry × N`.

**Synthesize** — `/pd-synthesize`: `[moderator idle?] → collect rounds + outcome taxonomy →
pi.sendMessage (the one deliberate context injection) → moderator turn → write synthesis.md`. The
idle check is a guard, not politeness: `sendMessage` into a streaming moderator **steers the running
turn** instead of opening its own, which both derails that turn and leaves the capture reading someone
else's reply. The capture is scoped to the turn the send triggers — armed just before the send, bound
to the first `agent_start` that follows, released in a `finally`. If nothing is captured, `synthesis.md`
is left **unchanged** and the refusal says so explicitly, because the moderator's reply may well have
rendered in the transcript and been paid for.

**Resume** — `/pd-resume <dir>`: `[not mid-round] → read meta.yaml → [panel-drift guard] →
SessionManager.open per slot → createAgentSession → close the incumbent → ready`.

**Abort** — `/pd-abort`: `controller.abort() → each in-flight session.abort() → outcomes recorded as
timed-out → partial artifacts flushed`.

**Close** — `/pd-close`: `[not mid-round] → dispose panelists → clear active → footer/status cleared`.
Nothing on disk is touched, so the discussion stays resumable.

## 12. Lifecycle & teardown

The traps are catalogued in
[`../../pi-references/guides/extension-lifecycle-and-cleanup.md`](../../pi-references/guides/extension-lifecycle-and-cleanup.md);
read it before writing lifecycle code. Four bind here:

- **`session_shutdown` fires on replacement, not just quit** — reason is `quit|reload|new|resume|fork`,
  so a `/new` mid-discussion must tear the panel down exactly like a quit.
- **Latch detached work.** The shutdown handler sets `disposed = true` **first**, then
  `controller.abort()`, then waits a bounded 15s for the in-flight round to write what it has, then
  `Promise.allSettled` over `session.abort()`, then `dispose()` each panelist — `dispose()` removes
  listeners but does **not** abort an in-flight turn, so abort comes first, always. `session_start`
  resets the latch.

  **The latch gates rendering, not the artifact writes.** Rendering touches a `ctx` and a session a
  replacement may already have invalidated, so it must stop between awaits. The writes touch nothing
  but the filesystem, and they *are* the "flush partial artifacts" step: a round that was already paid
  for must not be discarded because a `/new` landed while it was finishing. Aborting resolves every
  outstanding slot as `timed-out`, and those stubs are still the record (§7).
- **A stale `ctx` throws on any access, including `ctx.hasUI`** — `lastCtx?.hasUI` does not protect
  you, so every out-of-turn `ctx` touch is wrapped in try/catch. This bites the footer updater, which
  ticks while a round runs and outlives the turn that created it.
- **Never create panelist sessions in the extension factory** — factories run in invocations that
  never start a session. Panelists are created in the `/pd` handler, or on `session_start` for a
  resume.

**Cancellation is extension-owned, and that is core, not polish.** `ctx.signal` is **undefined** in
idle-fired command handlers, so a multi-minute `/pd` round cannot see Escape or Ctrl+C at all. The
discussion owns an `AbortController`; `/pd-abort` (optionally with a registered shortcut) trips it;
each slot races prompt vs timeout vs signal and calls `await session.abort()` in the catch (§6.3).

## 13. Observability & cost

`/pd-status` reads `session.getSessionStats()` per slot — `{ tokens{…}, cost, userMessages,
assistantMessages, toolCalls, contextUsage }`, aggregated over all entries including compacted-away
history, so it reflects what was actually billed. The `Model` object supplies name, provider, context
window, and per-token cost for the display; `session.getContextUsage()` returns `tokens: null` right
after a compaction, rendered as `—` and never as zero. `meta.yaml` is the durable ledger (per round,
per slot: outcome, tokens, cost, plus the panel snapshot), and the §8.5 cost guard reads it from the
same place the display does.

**Search spend is tracked separately and then folded in.** `getSessionStats()` cannot see it — Exa
bills it, not the model provider — so `ResearchLedger` accumulates each call's reported `costDollars`
per slot, `aggregateCost` adds the total into `totalCost` (what the cap rules on), and the footer
breaks it out as `(search $0.041)` because it is the one number a user cannot derive from token
counts. Each round stamps its own delta into `meta.yaml` as `research_cost`, and `/pd-resume` seeds
the ledger from those — without that, every resume would hand the discussion a fresh budget.

**What a wedged round looks like:** the footer holds one slot at "running" past its budget while the
others read "done". That is the signal to `/pd-abort` — the round timeout fires on its own too, but
the footer is what makes a stall distinguishable from a slow model, which is the whole reason it
exists.

## 14. UI — start boring

Each panelist's answer renders as a labeled, colored block as it completes (parallel execution,
sequential display), plus a one-line footer widget (`slot · model · tokens · cost`).

**Rendering goes through `pi.appendEntry(customType, data)` + `pi.registerEntryRenderer(customType,
…)`.** That path renders the block *and* records it in the host session **without entering the
moderator's LLM context** — the property that makes the panel affordable, since five models' full
answers across three rounds would otherwise flood the moderator's window before synthesis ever runs.
*Recorded, not necessarily on disk:* pi's `SessionManager` withholds the session file until the session
holds an assistant message, and a panel that never reaches `/pd-synthesize` gives the moderator no turn
to produce one — so those entries live only in memory for the session's lifetime (§15). Nothing rests
on it: `discussions/` is the durable record (§10), written by our own writer.
`pi.sendMessage({ display: true })` **does** enter context, and is reserved for the single deliberate
injection in `/pd-synthesize` (§11). Renderers use `Box`/`Text`/`Markdown`/`VStack` from `pi-tui` with
`getMarkdownTheme()`, and `theme.fg(slot.color, slot.name)` for the label (§3).

Mode guards, per the pi-e2e-tester README's hasUI discipline: component factories are gated behind
`ctx.mode === "tui"`, dialogs behind `ctx.hasUI` (true for `tui` and `rpc`). `ctx.ui.setStatus(key,
text)` marks a long round and is **cleared when it ends**; the footer is `ctx.ui.setWidget(key,
factory, { placement: "belowEditor" })`, re-rendered periodically so per-slot stats stay fresh — via
the try/catch'd stale-ctx path in §12. The refresh is a self-rearming timeout rather than a fixed
interval, fast (1s) only while a round is in flight and near-dormant (15s) otherwise: a discussion
sits idle between rounds for as long as the user takes to read it, and repainting through all of that
buys nothing. The widget owns the timer and clears it on `dispose()`, so the tick never reaches for a
captured `ctx` at all. The fusion-harness 5-column live grid is deferred (§20); with
artifacts-as-files and a footer, it may never be needed.

## 15. Test strategy & first-run verification

**Deterministic, zero paid calls** (fusion-harness's bar, and the fleet's). Tests stub at the
`PanelistSession` seam — a structural subset of `AgentSession`, so the compiler still checks that a
real session satisfies it — which exercises the round dispatcher, the outcome taxonomy, the guards,
the artifact writer, and the prompt builders without a network, a model runtime, or auth.
`SessionManager.inMemory()` plus `exportToJsonl` remains available for fixtures if a test ever needs a
real transcript.

**First-run verification list — automated by `bun run smoke:rpc`.** In the spirit of
[`../../docs/pi-0.84-upgrade-checks.md`](../../docs/pi-0.84-upgrade-checks.md), these paths compile
without ever having executed against a live provider. The list stays here as the **spec of what the
harness covers**; `smoke/` (§16) is the executable form. It is opt-in and paid — never reachable from
`bun run test` — and drives a real `pi --mode rpc` process with a scratch cwd, a scratch
`--session-dir`, and a generated two-slot panel pinned to the cheapest available `anthropic` and
`deepseek` models under a `max_cost` of $0.50. Each check prints PASS / FAIL / SKIP with its evidence
and the run exits nonzero on any FAIL.

1. `SessionManager.open()` against a **non-existent** path actually creating the file.
2. Resume restoring a slot's transcript intact from its `sessions/<slot>.jsonl`.
3. `appendEntry` + `registerEntryRenderer` surviving a session reload (renderer re-registration order).
   The RPC harness covers the durable half — no `extension_error` on reload, entries round-trip through
   `get_entries`. That the re-registered renderer still *paints* needs a terminal, and is covered by
   `bun run smoke:tui` below.
4. `/pd-abort` mid-round: signal → `session.abort()` → outcomes recorded, no orphaned turn.
5. Concurrent dispatch across **different providers** on one shared `ModelRuntime`.
6. `session_shutdown` with `reason: "new"` arriving mid-round, and the disposed latch stopping the loop
   between awaits.
7. A real Exa call: that `readStoredCredential("exa")` finds a key pi's `/login` wrote, that
   `costDollars.total` is present on both `/search` and `/contents`, and that a panelist's custom tool
   is actually callable — i.e. that naming it in `tools` alongside `customTools` was sufficient (§5.1).

**First live run: 2026-08-27** — all seven green, ~$0.05. No code defect surfaced. What it *did*
surface is one pi behaviour the list had assumed away, in two places: **`SessionManager` does not write
a session file until that session holds an assistant message** (`_persist` buffers everything until
then and flushes in one rewrite).

- A slot's `sessions/<slot>.jsonl` therefore appears on its **first assistant reply**, not at
  `open()` — measured 5–8s after the round-0 dispatch. `open()` reserves the path; the round writes it.
  A round that produces no assistant output for a slot leaves that slot no transcript at all, which is
  the honest outcome but is not what "open() creates the file" implies.
- The **host** session is never persisted by `appendEntry` alone, because the moderator takes no turn
  of its own until `/pd-synthesize` (§14). Check 3 has to spend one cheap moderator turn to flush the
  file before a reload can test anything — without it, `switch_session` loads an empty session and both
  checks 3 and 6 pass vacuously. This is the correction to §14's "renders *and* persists".

Both are properties of pi, not defects here, and neither changes the design: the artifacts under
`discussions/` are the durable record (§10), and they are written by our own writer, not by pi's
session store.

**The rendered half — `bun run smoke:tui`.** RPC cannot see a paint, and the failure it would miss is
silent: pi's `addCustomEntryToChat` returns early for a `customType` with no registered renderer, so a
renderer that failed to re-register leaves `get_entries` intact and the transcript **blank**. A
companion runner drives a real `pi` TUI inside a herdr pane (herdr is the terminal multiplexer already
on this machine; it exposes panes over a socket API) — `pane run`, then `wait-output` / `read` against
the rendered screen — and asserts four things a terminal is the only witness to:

1. Both panelist blocks and the notice repaint from the reloaded JSONL, collapsed past
   `COLLAPSED_LINES`, with no raw entry text and no extension error (§15/3's visual half).
2. Each slot label comes back in its own configured colour and a non-`answered` slot in the error
   colour — the JSONL round-trip hazard `isThemeColor()` guards, which would otherwise flatten every
   slot to the same fallback token (§14).
3. `/pd-resume <dir>` paints its notice **into the already-reloaded session**, covering the live half a
   replay of the JSONL cannot (§15/3).
4. The `belowEditor` footer widget carries the discussion name, both slots' state, and token counts read
   back from the restored transcripts — a widget RPC mode never builds at all, since `showFooter` is
   gated on `ctx.mode === "tui"` (§14).

It is **free**: the discussion is a fixture written to disk through the product's own artifact writers
plus two `SessionManager` transcripts, and no slot is ever prompted. Its one live dependency is model
*resolution* — the panel is pinned to models pi reports as available, so `/pd-resume`'s readiness guard
(§8.1) passes. It SKIPs with exit 0, not FAIL, when the `herdr` binary is missing, its server is not
running, `pi` is not on `PATH`, or no provider has configured auth. **First green run: 2026-08-27**, all
four, $0.00. Note that `/pd-resume` opens an argument-completion popup that consumes the first `Enter`.

## 16. Repo layout

```
pi-discuss/
  docs/DESIGN.md      # this file
  panel.yaml.example  # the tracked twin — copy to panel.yaml on install (§3)
  panel.yaml          # your live panel — gitignored, personal machine config, no secrets
  src/index.ts        # extension entry: command registration, session_start/shutdown hooks
  src/modules/        # config.ts, panelists.ts, rounds.ts, discussion.ts, artifacts.ts,
                      # cost.ts, research.ts, research-tools.ts, ui.ts, types.ts, prompts/
  src/modules/prompts/  # round-0.ts, debate.ts, synthesis.ts, persona.ts, steer.ts, ask.ts,
                        # panelist-system.ts
  test/               # deterministic, zero paid calls (§15)
  smoke/              # rpc.ts + rpc-client.ts + scratch.ts — the paid §15 runner, `bun run smoke:rpc`
                      # tui.ts + herdr.ts — its free rendered-output twin, `bun run smoke:tui`
  discussions/        # the artifacts (§10)
```

`types.ts` holds the outcome taxonomy (§7) and the ledger shapes, so `prompts/` and `rounds.ts` share
them without a value-level import cycle. `discussion.ts` holds the active-discussion state and the
guards that read it — the drift guard (§8.4) and the debate loop's steering-consumption order (§6.1).
`panel.yaml` is resolved from the extension's own directory via `import.meta.url`; there is no cwd
override — which is why `smoke/` pins a scratch panel by copying the extension tree beside a generated
one rather than by pointing the running extension at another file. `research.ts` is the credential/HTTP/ledger layer and `research-tools.ts` the `defineTool`
wrappers over it — split so the backend seam tests without pulling in TypeBox or a tool runtime (§15).

Install for use: add `pi-discuss/src/index.ts` to pi's extension sources in `settings.json`, or symlink
it into `~/.pi/agent/extensions/`.

## 17. Scope & non-goals

- **No ACK/consensus ritual.** Panelists never negotiate agreement; the divergence map is the output.
- **Nothing writes the repo.** Panelists cannot (§5); the extension writes only under `discussions/`.
- **No auto-advance.** Every round is user-initiated — a panel that keeps debating unattended is a
  bill, not a feature.
- **Not an RPC service.** No `convene` verb, no structured result event, no gated caller (§20).
- **Not a code agent.** Panelists read to reason about a codebase; they never propose applied edits.

## 18. Build order

**Core loop** — config loader + validation, per-slot session pool with read-only allowlists, the round
dispatcher, `AbortController` + `/pd-abort`, artifact writer, `/pd` · `/pd-ask` · `/pd-status`;
pure-reasoning + repo-read panelists. *Proves:* N different models can be driven concurrently
in-process and their answers persisted and rendered without entering the moderator's context.

**Discussion mechanics** — `/pd-debate`, `/pd-steer`, `/pd-synthesize`, `/pd-resume`, `/pd-close`; the
`meta.yaml` outcome + cost ledger. *Proves:* labeled cross-exposure moves positions in a way synthesis
can attribute, and a discussion survives a session restart.

**Research tools** — `web_search` / `fetch_url` as Exa-backed wrapped custom tools, the search-spend
ledger folded into the §8.5 cap, footer polish. *Proves:* panelists can bring in evidence neither model
had memorized, without touching a shell and without a credential entering the repo. Publishing a
finished discussion through pi-pages stayed out (§20): the manual `deploy-pages` handoff is one
command and nothing yet runs it often enough to earn the coupling.

## 19. Locked decisions at a glance

| decision | ruling |
|---|---|
| Execution model | In-process `createAgentSession()` children, not subprocess pi instances (§2.2). |
| Panelist isolation | One `DefaultResourceLoader` per slot with `noExtensions/noSkills/noPromptTemplates/noThemes: true`; `noExtensions` prevents recursive self-instantiation (§5). |
| Tool surface | `["read","grep","find","ls"]` — read-only by allowlist, not by prompt (§5). |
| Session persistence | `SessionManager.open("<discussion>/sessions/<slot>.jsonl", undefined, cwd)` — one code path for create and resume (§10). |
| Rendering path | `pi.appendEntry` + `registerEntryRenderer`: renders and persists, never enters moderator context (§14). |
| Context injection | `pi.sendMessage` exactly once per synthesis, to feed the collected rounds to the moderator (§11). |
| Prompts & personas | `systemPrompt` + `appendSystemPrompt` on the per-slot loader; prose lives in `src/modules/prompts/` (§9). |
| Slot colors | Named `ThemeColor` tokens, never hex (§3). |
| Cancellation | Extension-owned `AbortController` + `/pd-abort`; `ctx.signal` is undefined in idle-fired handlers (§12). |
| Artifact location | `discussions/<date>-<slug>/` in the cwd, sessions inside it; never `/tmp` (§10). |
| Synthesis ownership | The host session's model, not a panel slot (§2). |
| Round 0 | Always independent, asserted by a guard — no peers AND no steering — rather than trusted to the prompt (§8.2). |
| Cost policy | Soft cap + warning by default ($5); hard refusal only when `max_cost` is set explicitly. Gates `/pd-debate` and `/pd-ask` alike (§8.5). Covers model **and** search spend, and carries across a resume via `meta.yaml`'s per-round `research_cost`. |
| Panel config | `panel.yaml` is gitignored personal config; `panel.yaml.example` is the tracked twin (§3). Reversed 2026-08-27 from "tracked, no `.example` twin": holding no secrets was the wrong test — the slots name models only *this* install resolves and pays for. |
| Repo access | `repo_access: true` by default, per-discussion `/pd --no-repo` override (§3). |
| Web research | Exa, off by default, key in pi's `auth.json` under `exa` — never in this repo. Search spend folds into the §8.5 cap from Exa's own `costDollars` (§5.1). |
| Command prefix | `/pd-*`, locked — pi auto-suffixes collisions, so the risk is cosmetic (§4). |
| Discussion lifetime | One open at a time; `/pd-close` ends it without ending the session, leaving it resumable (§4). |
| Panel drift | Slot set, model, **and thinking level** must match the `meta.yaml` snapshot to resume (§8.4). |
| Shutdown latch | Gates rendering, not artifact writes — the writes are the partial-artifact flush (§12). |

## 20. Deferred

- **Publishing a discussion from inside pi-discuss.** *Revisit when* the manual `deploy-pages` handoff
  is being run on most discussions.
- **Dedicated synthesizer slot** (a different model than the host); config key reserved. *Revisit when*
  a synthesis is observed favoring the moderator model's own round position.
- **RPC exposure** — a `convene` verb so fleet agents can commission a panel. It would then be a gated
  agent and owe the full [`../../docs/building-pi-agents.md`](../../docs/building-pi-agents.md)
  treatment. *Revisit when* a sibling agent actually wants a panel, not before.
- **TUI live grid** (fusion-harness's 5-column view). *Revisit when* the footer proves insufficient for
  spotting a stalled slot (§13).
- **Interactive model picker** (`/pd-model`). *Revisit when* editing `panel.yaml` between discussions
  becomes the common case rather than the rare one.

## 21. Open questions

Settled items live in the sections above; one is kept struck-through here because the *reason* it was
open was itself a mistake worth not repeating.

- ~~**Web research backend.**~~ **Settled 2026-08-26: Exa** (§5.1). The framing was wrong — the choice
  was never "credential vs. no credential", because pi's `auth.json` already holds the model keys and
  takes an arbitrary provider id, so a search key never had to touch this repo at all. Given that, the
  `fetch_url`-only option bought nothing and cost the discovery that is most of the value. Exa over
  Serper because `contents` comes back inline with the search (one tool covers both halves) and
  `costDollars` makes the spend meterable.
- **Synthesis context budget.** A 5-slot × 3-round discussion pushes fifteen full answers through
  `sendMessage` into the moderator's window in one turn. Whether synthesis is fed full text, per-round
  slot summaries, or a two-pass reduce is unknown until real rounds exist to measure — and summarizing
  is exactly the "averaging into mush" that §9 forbids, so it cannot be chosen casually. Research
  widens this: a panelist that quotes three fetched pages produces a materially longer answer than one
  reasoning from memory, so the first live research discussion is also the measurement for this.
