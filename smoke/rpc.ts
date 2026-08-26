/**
 * Live RPC smoke run for the seven first-run checks in DESIGN §15. Opt-in and
 * paid: it drives a real `pi --mode rpc` against real providers, so it is wired
 * as `bun run smoke:rpc` and deliberately not reachable from `bun run test`.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createExaBackend, resolveExaKey } from "../src/modules/research.ts";
import { STATUS_KEY } from "../src/modules/ui.ts";
import { type AvailableModel, cheapestModel, createScratch, discussionDirs, fileSize, readJsonl, readMetaYaml, removeScratch, type Scratch, totalSpend, writePanelYaml } from "./scratch.ts";
import { isStatus, RpcClient, type RpcMessage, SmokeTimeout, statusText } from "./rpc-client.ts";

const PANEL_ENTRY_TYPE = "pi-discuss.panelist";
const NOTICE_ENTRY_TYPE = "pi-discuss.notice";

const BOOT_MS = 120_000;
const ROUND_MS = 8 * 60_000;
/** How long a round is left in flight before the abort lands. One LLM round trip is longer than this. */
const DWELL_MS = 2_500;
const SETTLE_MS = 4_000;
const POLL_MS = 50;

/** A rare token: check 2 proves a restored transcript by asking the slot to recall it. */
const NONCE = "ZARQUON-7";
const TOPIC = `Is "${NONCE}" a good codename for a database migration tool? Answer in at most three sentences.`;
const RESEARCH_TOPIC =
  "Use web_search to look up the current stable release version of the Bun JavaScript runtime, then give the " +
  "version and the source URL. Do not answer from memory. Two sentences maximum.";
const RECALL_QUESTION = "Reply with only the codename I asked you about earlier, nothing else.";

const SLOTS = ["claude", "deepseek"] as const;

type Status = "PASS" | "FAIL" | "SKIP";

interface StepResult {
  name: string;
  status: Status;
  reason: string;
  notes: string[];
}

const CHECKS = [
  "1 SessionManager.open() creates the file",
  "2 resume restores a slot transcript",
  "3 appendEntry + renderer survive a reload",
  "4 /pd-abort mid-round",
  "5 concurrent dispatch across providers",
  "6 session_shutdown reason=new mid-round",
  "7 live Exa call + panelist custom tool",
] as const;

const results = new Map<string, StepResult>();
const transcript: string[] = [];

function log(line: string): void {
  transcript.push(line);
  process.stdout.write(`${line}\n`);
}

function record(name: string, status: Status, reason: string, notes: string[] = []): void {
  if (results.has(name)) return;
  results.set(name, { name, status, reason, notes });
  log(`\n[${status}] ${name}\n       ${reason}`);
  for (const note of notes) log(`       · ${note}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function describe(err: unknown): string {
  if (err instanceof SmokeTimeout) {
    const tail = err.recent.map((m) => JSON.stringify(m).slice(0, 160)).join("\n         ");
    return `${err.message}\n       last events:\n         ${tail}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/* ─────────────────────────── RPC conveniences ─────────────────────────── */

interface SessionEntry {
  id: string;
  type: string;
  customType?: string;
  data?: Record<string, unknown>;
}

async function getEntries(client: RpcClient): Promise<SessionEntry[]> {
  const response = await client.request({ type: "get_entries" }, 30_000);
  if (!response.success) throw new Error(`get_entries failed: ${response.error}`);
  return (response.data?.["entries"] ?? []) as SessionEntry[];
}

function panelEntries(entries: SessionEntry[]): SessionEntry[] {
  return entries.filter((e) => e.type === "custom" && e.customType === PANEL_ENTRY_TYPE);
}

function noticeTitles(entries: SessionEntry[]): string[] {
  return entries
    .filter((e) => e.type === "custom" && e.customType === NOTICE_ENTRY_TYPE)
    .map((e) => String(e.data?.["title"] ?? ""));
}

function roundStarted(round: number) {
  return (m: RpcMessage): boolean => isStatus(m, STATUS_KEY) && (statusText(m) ?? "").includes(`round ${round} `);
}

function statusCleared(m: RpcMessage): boolean {
  return isStatus(m, STATUS_KEY) && statusText(m) === undefined;
}

function extensionErrors(client: RpcClient, cursor: number): RpcMessage[] {
  return client.since(cursor, (m) => m.type === "extension_error");
}

/* ─────────────────────────── filesystem waits ─────────────────────────── */

function slotSessionPaths(discussionDir: string): Map<string, string> {
  const paths = new Map<string, string>();
  for (const slot of SLOTS) paths.set(slot, join(discussionDir, "sessions", `${slot}.jsonl`));
  return paths;
}

async function waitForDiscussionDir(workDir: string, known: Set<string>, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const fresh = discussionDirs(workDir).find((d) => !known.has(d));
    if (fresh !== undefined) return fresh;
    if (Date.now() > deadline) throw new Error(`no new discussion directory appeared under ${workDir} in ${timeoutMs}ms`);
    await sleep(POLL_MS);
  }
}

interface FileSighting {
  atMs: number;
  lines: number;
  headerFirst: boolean;
}

/**
 * Watches for each slot's session file the moment it appears. It deliberately does
 * not stop when the round starts: `createAgentSession` runs both slots in a few
 * milliseconds, so the window between "the file exists" and "round 0 dispatched"
 * is shorter than any poll interval, and stopping on the round would race it away.
 */
async function watchSessionFiles(discussionDir: string, timeoutMs: number): Promise<Map<string, FileSighting>> {
  const paths = slotSessionPaths(discussionDir);
  const seen = new Map<string, FileSighting>();
  const deadline = Date.now() + timeoutMs;
  while (seen.size < paths.size && Date.now() < deadline) {
    for (const [slot, path] of paths) {
      if (seen.has(slot) || !existsSync(path)) continue;
      const entries = readJsonl(path);
      if (entries.length === 0) continue;
      // The header is what SessionManager writes when it creates a file, so its
      // presence separates "open() created this" from "something appended to it".
      seen.set(slot, { atMs: Date.now(), lines: entries.length, headerFirst: entries[0]?.["type"] === "session" });
    }
    if (seen.size === paths.size) break;
    await sleep(POLL_MS);
  }
  return seen;
}

async function waitForGrowth(paths: Map<string, string>, before: Map<string, number>, timeoutMs: number): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  const grown = new Set<string>();
  while (grown.size < paths.size && Date.now() < deadline) {
    for (const [slot, path] of paths) {
      if (!grown.has(slot) && fileSize(path) > (before.get(slot) ?? 0)) grown.add(slot);
    }
    if (grown.size === paths.size) break;
    await sleep(POLL_MS);
  }
  return [...grown];
}

function sizeSnapshot(paths: Map<string, string>): Map<string, number> {
  return new Map([...paths].map(([slot, path]) => [slot, fileSize(path)]));
}

/* ───────────────────────────── tool-call probe ───────────────────────────── */

interface ToolSighting {
  structured: string[];
  rawMentions: number;
}

/**
 * A panelist's tool calls live in its own child session, never on the host's RPC
 * event stream (§2.1), so the transcript file is the only place to see them.
 */
function findResearchToolCalls(path: string): ToolSighting {
  const names = new Set(["web_search", "fetch_url"]);
  const structured: string[] = [];
  for (const entry of readJsonl(path)) {
    const message = entry["message"] as Record<string, unknown> | undefined;
    const content = message?.["content"];
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (typeof part !== "object" || part === null) continue;
      const record_ = part as Record<string, unknown>;
      if (record_["type"] !== "toolCall") continue;
      const name = String(record_["name"] ?? "");
      if (names.has(name)) structured.push(name);
    }
  }
  const raw = existsSync(path) ? readFileSync(path, "utf8") : "";
  return { structured, rawMentions: (raw.match(/web_search/g) ?? []).length };
}

/* ──────────────────────────────── phases ──────────────────────────────── */

function piArgs(scratch: Scratch): string[] {
  // -ne keeps the user's own extensions out of the run; -e still loads ours.
  // -na declines project-local config so no trust dialog can block the run.
  return ["--mode", "rpc", "-ne", "-na", "-e", scratch.extEntry, "--session-dir", scratch.sessionDir];
}

interface PanelChoice {
  anthropic: AvailableModel;
  deepseek: AvailableModel;
}

async function choosePanel(client: RpcClient): Promise<PanelChoice> {
  const response = await client.request({ type: "get_available_models" }, 60_000);
  if (!response.success) throw new Error(`get_available_models failed: ${response.error}`);
  const models = (response.data?.["models"] ?? []) as AvailableModel[];
  const anthropic = cheapestModel(models, "anthropic");
  const deepseek = cheapestModel(models, "deepseek");
  if (anthropic === undefined || deepseek === undefined) {
    const providers = [...new Set(models.map((m) => m.provider))].join(", ");
    throw new Error(`need a cheap anthropic and deepseek model; available providers: ${providers}`);
  }
  return { anthropic, deepseek };
}

interface Phase1Outcome {
  discussionDir: string;
  panel: PanelChoice;
}

async function phase1(scratch: Scratch): Promise<Phase1Outcome> {
  const client = new RpcClient({ args: piArgs(scratch), cwd: scratch.workDir, log });
  try {
    const panel = await choosePanel(client);
    log(`  panel: anthropic/${panel.anthropic.id} + deepseek/${panel.deepseek.id}`);
    writePanelYaml(
      scratch.panelPath,
      [
        { name: "claude", model: `anthropic/${panel.anthropic.id}`, thinking: "low", color: "accent" },
        { name: "deepseek", model: `deepseek/${panel.deepseek.id}`, thinking: "low", color: "warning" },
      ],
      { rounds: 1, repo_access: true, research: false, max_cost: 0.5 },
    );
    // The moderator never takes a turn in this run, but a stray one must not be expensive.
    await client.request({ type: "set_model", provider: "anthropic", modelId: panel.anthropic.id }, 30_000);

    /* ── checks 1 and 5: open the panel and run round 0 ── */
    // Nothing under the scratch cwd exists yet, so every path the session manager
    // is about to open is provably non-existent — which is the premise of check 1.
    const rootExisted = existsSync(join(scratch.workDir, "discussions"));
    const openCursor = client.mark();
    const openId = client.notify({ type: "prompt", message: `/pd ${TOPIC}` });

    const discussionDir = await waitForDiscussionDir(scratch.workDir, new Set(), BOOT_MS);
    log(`  discussion: ${discussionDir}`);
    const watching = watchSessionFiles(discussionDir, BOOT_MS);
    const roundStartedAtMs = await client
      .waitFrom(openCursor, "round 0 start status", roundStarted(0), BOOT_MS)
      .then(() => Date.now());
    const sighted = await watching;

    const missing = SLOTS.filter((s) => !sighted.has(s));
    const headerless = [...sighted].filter(([, s]) => !s.headerFirst).map(([slot]) => slot);
    if (rootExisted) {
      record(CHECKS[0], "FAIL", `the scratch cwd already had a discussions/ directory, so nothing was created from nothing`);
    } else if (missing.length > 0) {
      record(CHECKS[0], "FAIL", `no session file appeared for: ${missing.join(", ")}`);
    } else if (headerless.length > 0) {
      record(CHECKS[0], "FAIL", `session file exists but does not open with a session header for: ${headerless.join(", ")}`);
    } else {
      record(
        CHECKS[0],
        "PASS",
        "SessionManager.open() created both sessions/<slot>.jsonl from a path that did not exist, each opening with its own session header",
        [
          ...[...sighted].map(
            ([slot, s]) => `${slot}.jsonl: ${s.lines} entries, on disk ${s.atMs - roundStartedAtMs}ms after the round-0 dispatch`,
          ),
          "the file materialises on the slot's first assistant message, not at open(): SessionManager defers the write, so a round that never produces assistant output leaves no transcript behind",
        ],
      );
    }

    const openResponse = await client.awaitResponse(openId, "/pd", ROUND_MS);
    if (!openResponse.success) throw new Error(`/pd was rejected: ${openResponse.error}`);
    await client.waitFrom(openCursor, "round 0 status cleared", statusCleared, 60_000);

    const meta0 = readMetaYaml(discussionDir);
    const round0 = meta0.rounds.find((r) => r.round === 0);
    const outcomes0 = (round0?.slots ?? []).map((s) => `${s.name}=${s.outcome}`).join(" ");
    const answered0 = (round0?.slots ?? []).filter((s) => s.outcome === "answered").map((s) => s.name);
    const artifacts0 = SLOTS.filter((s) => existsSync(join(discussionDir, "round-0", `${s}.md`)));
    if (round0 === undefined) {
      record(CHECKS[4], "FAIL", "round 0 never reached meta.yaml");
    } else if (answered0.length !== SLOTS.length) {
      record(CHECKS[4], "FAIL", `not every slot answered round 0: ${outcomes0}`, [
        ...(round0.slots.filter((s) => s.error !== undefined).map((s) => `${s.name}: ${s.error}`)),
      ]);
    } else {
      record(
        CHECKS[4],
        "PASS",
        `both providers answered the same independent round on one shared ModelRuntime (${outcomes0})`,
        [
          `slots: ${meta0.panel.map((p) => `${p.name}=${p.model}`).join(", ")}`,
          `round-0 artifacts on disk: ${artifacts0.join(", ")}`,
          `round-0 cost: $${round0.slots.reduce((sum, s) => sum + s.cost, 0).toFixed(4)}`,
        ],
      );
    }

    const paths = slotSessionPaths(discussionDir);

    /* ── check 4: /pd-abort mid-round ── */
    const abortCursor = client.mark();
    const before1 = sizeSnapshot(paths);
    const entriesBeforeAsk0 = await getEntries(client);
    const debateId = client.notify({ type: "prompt", message: "/pd-debate 1" });
    await client.waitFrom(abortCursor, "round 1 start status", roundStarted(1), BOOT_MS);
    const grown1 = await waitForGrowth(paths, before1, 60_000);
    await sleep(DWELL_MS);
    // Extension commands bypass the streaming queue and are handled on their own
    // input line, so this lands while /pd-debate's handler is still awaiting (rpc.md).
    const abortId = client.notify({ type: "prompt", message: "/pd-abort" });
    const debateResponse = await client.awaitResponse(debateId, "/pd-debate 1", ROUND_MS);
    await client.awaitResponse(abortId, "/pd-abort", ROUND_MS).catch(() => undefined);
    await client.waitFrom(abortCursor, "round 1 status cleared", statusCleared, 120_000);

    const meta1 = readMetaYaml(discussionDir);
    const round1 = meta1.rounds.find((r) => r.round === 1);
    const outcomes1 = (round1?.slots ?? []).map((s) => `${s.name}=${s.outcome}`).join(" ");
    const artifacts1 = SLOTS.filter((s) => existsSync(join(discussionDir, "round-1", `${s}.md`)));

    // "No orphaned turn" is only observable by using the slot again: a session
    // whose aborted turn never settled rejects the next prompt outright.
    const askCursor = client.mark();
    const askId = client.notify({ type: "prompt", message: "/pd-ask deepseek Reply with the single word: alive" });
    const askResponse = await client.awaitResponse(askId, "/pd-ask (orphan probe)", ROUND_MS);
    await client.waitFrom(askCursor, "ask status cleared", statusCleared, 120_000);
    const entriesAfterAsk0 = await getEntries(client);
    const knownIds = new Set(entriesBeforeAsk0.map((e) => e.id));
    const probeEntry = panelEntries(entriesAfterAsk0)
      .filter((e) => !knownIds.has(e.id))
      .filter((e) => e.data?.["slot"] === "deepseek")
      .pop();
    const probeOutcome = String(probeEntry?.data?.["outcome"] ?? "(no entry)");

    const abortProblems: string[] = [];
    if (!debateResponse.success) abortProblems.push(`/pd-debate returned an error: ${debateResponse.error}`);
    if (round1 === undefined) abortProblems.push("round 1 never reached meta.yaml");
    if (round1 !== undefined && round1.slots.length !== SLOTS.length) {
      abortProblems.push(`round 1 recorded ${round1.slots.length} slots, expected ${SLOTS.length}`);
    }
    if (round1 !== undefined && !round1.slots.some((s) => s.outcome === "timed-out")) {
      abortProblems.push(`no slot recorded timed-out (${outcomes1}); the abort landed after the round finished`);
    }
    if (artifacts1.length !== SLOTS.length) abortProblems.push(`round-1 artifacts missing for some slots (${artifacts1.join(", ") || "none"})`);
    if (probeOutcome !== "answered") abortProblems.push(`the post-abort /pd-ask on deepseek came back ${probeOutcome}, not answered — the aborted turn may be orphaned`);
    record(
      CHECKS[3],
      abortProblems.length === 0 ? "PASS" : "FAIL",
      abortProblems.length === 0
        ? `abort tripped the signal, every slot recorded an outcome (${outcomes1}), and the slot took a fresh turn afterwards`
        : abortProblems.join("; "),
      [
        `both slot transcripts grew before the abort: ${grown1.join(", ")} (proof the child turns were in flight)`,
        `round-1 artifacts: ${artifacts1.join(", ") || "none"}`,
        `post-abort /pd-ask outcome: ${probeOutcome}`,
        "panelists are in-process children, so their streaming never reaches the host RPC event stream (§2.1); transcript growth is the streaming evidence",
      ],
    );

    /* ── checks 6 and 3: new_session mid-round, then reload the old session ── */
    // pi defers creating the session file until the session holds an assistant
    // message (SessionManager._persist), and a pi-discuss host session takes no
    // turn of its own — appendEntry alone never flushes it. Without one cheap
    // moderator turn the file does not exist, switch_session loads an empty
    // session, and both checks below would measure nothing.
    const flushCursor = client.mark();
    await client.request({ type: "prompt", message: "Reply with exactly: OK. Use no tools." }, 60_000);
    await client.waitFrom(flushCursor, "moderator turn to settle", (m) => m.type === "agent_settled", ROUND_MS);
    const stateResponse = await client.request({ type: "get_state" }, 30_000);
    const oldSessionFile = String(stateResponse.data?.["sessionFile"] ?? "");
    if (!existsSync(oldSessionFile)) {
      throw new Error(`the host session file was still not on disk after a moderator turn: ${oldSessionFile}`);
    }
    const entriesBeforeReload = await getEntries(client);
    const panelBeforeReload = panelEntries(entriesBeforeReload);

    const newCursor = client.mark();
    const before2 = sizeSnapshot(paths);
    const debate2Id = client.notify({ type: "prompt", message: "/pd-debate 1" });
    await client.waitFrom(newCursor, "round 2 start status", roundStarted(2), BOOT_MS);
    const grown2 = await waitForGrowth(paths, before2, 60_000);
    await sleep(DWELL_MS);
    const newSession = await client.request({ type: "new_session" }, ROUND_MS);
    await client.awaitResponse(debate2Id, "/pd-debate 1 (interrupted)", 60_000).catch(() => undefined);
    await sleep(SETTLE_MS);

    const meta2 = readMetaYaml(discussionDir);
    const round2 = meta2.rounds.find((r) => r.round === 2);
    const outcomes2 = (round2?.slots ?? []).map((s) => `${s.name}=${s.outcome}`).join(" ");
    const artifacts2 = SLOTS.filter((s) => existsSync(join(discussionDir, "round-2", `${s}.md`)));

    const switchResponse = await client.request({ type: "switch_session", sessionPath: oldSessionFile }, 120_000);
    const entriesAfterReload = await getEntries(client);
    const panelAfterReload = panelEntries(entriesAfterReload);
    const reloadErrors = extensionErrors(client, newCursor);

    const shutdownProblems: string[] = [];
    if (!newSession.success) shutdownProblems.push(`new_session failed: ${newSession.error}`);
    if (newSession.data?.["cancelled"] === true) shutdownProblems.push("new_session was cancelled by a handler");
    if (round2 === undefined) shutdownProblems.push("round 2 was not flushed to meta.yaml — the latch swallowed the artifact writes");
    if (artifacts2.length !== SLOTS.length) shutdownProblems.push(`round-2 artifacts missing (${artifacts2.join(", ") || "none"})`);
    // §12: the latch gates rendering, not the writes. A round-2 panelist entry in
    // the old session would mean rendering continued past the replacement.
    const leaked = panelAfterReload.filter((e) => Number(e.data?.["round"] ?? -1) === 2);
    // Without earlier rounds' entries coming back, "no round-2 entries" would be
    // true of an empty session and would prove nothing about the latch.
    if (panelAfterReload.length === 0) shutdownProblems.push("the reloaded session held no panelist entries at all, so the render-leak assertion would be vacuous");
    if (leaked.length > 0) shutdownProblems.push(`${leaked.length} round-2 panelist entries were rendered into the replaced session; the disposed latch did not stop the loop`);
    if (reloadErrors.length > 0) shutdownProblems.push(`${reloadErrors.length} extension_error event(s) during the replacement`);
    if (client.hasExited) shutdownProblems.push("the pi process died during the replacement");
    record(
      CHECKS[5],
      shutdownProblems.length === 0 ? "PASS" : "FAIL",
      shutdownProblems.length === 0
        ? `new_session mid-round tore the panel down, the paid-for round still reached disk (${outcomes2}), and nothing rendered into the replaced session`
        : shutdownProblems.join("; "),
      [
        `both slot transcripts grew before the replacement: ${grown2.join(", ")}`,
        `round-2 artifacts: ${artifacts2.join(", ") || "none"}`,
        `round-2 panelist entries rendered into the old session: ${leaked.length} (expected 0)`,
        `extension_error events during shutdown + reload: ${reloadErrors.length}`,
      ],
    );

    const reloadProblems: string[] = [];
    if (!switchResponse.success) reloadProblems.push(`switch_session failed: ${switchResponse.error}`);
    if (switchResponse.data?.["cancelled"] === true) reloadProblems.push("switch_session was cancelled by a handler");
    const beforeById = new Map(panelBeforeReload.map((e) => [e.id, JSON.stringify(e.data)]));
    const lost = [...beforeById.keys()].filter((id) => !panelAfterReload.some((e) => e.id === id));
    const changed = panelAfterReload.filter((e) => beforeById.has(e.id) && beforeById.get(e.id) !== JSON.stringify(e.data));
    if (panelBeforeReload.length === 0) reloadProblems.push("no pi-discuss.panelist entries existed before the reload, so nothing was tested");
    if (lost.length > 0) reloadProblems.push(`${lost.length} panelist entries did not survive the reload`);
    if (changed.length > 0) reloadProblems.push(`${changed.length} panelist entries came back with different data`);
    if (reloadErrors.length > 0) reloadProblems.push(`${reloadErrors.length} extension_error event(s) around the reload — renderer re-registration is the suspect`);
    record(
      CHECKS[2],
      reloadProblems.length === 0 ? "PASS" : "FAIL",
      reloadProblems.length === 0
        ? `all ${panelBeforeReload.length} appended panelist entries round-tripped byte-identically through new_session + switch_session, with no extension_error`
        : reloadProblems.join("; "),
      [
        `${panelBeforeReload.length} panelist entries before the reload, ${panelAfterReload.length} after`,
        "renderers re-register on every session bind; an extension_error here would be the duplicate-registration failure",
        "the host session only reaches disk once it holds an assistant message, so this check first spends one cheap moderator turn to flush it",
        "the visual half — that the re-registered renderer still paints the block — is covered by `smoke:tui` (planned, not this script)",
      ],
    );

    return { discussionDir, panel };
  } finally {
    await client.close();
  }
}

async function phase2(scratch: Scratch, phase1Result: Phase1Outcome): Promise<void> {
  const { discussionDir, panel } = phase1Result;
  const client = new RpcClient({ args: piArgs(scratch), cwd: scratch.workDir, log });
  try {
    await client.request({ type: "set_model", provider: "anthropic", modelId: panel.anthropic.id }, 30_000);

    /* ── check 2: resume restores a slot transcript ── */
    const slotFile = join(discussionDir, "sessions", "deepseek.jsonl");
    const beforeEntries = readJsonl(slotFile);
    const beforeUserMessages = beforeEntries.filter(
      (e) => (e["message"] as Record<string, unknown> | undefined)?.["role"] === "user",
    ).length;

    const resumeCursor = client.mark();
    const resumeId = client.notify({ type: "prompt", message: `/pd-resume ${basename(discussionDir)}` });
    const resumeResponse = await client.awaitResponse(resumeId, "/pd-resume", 120_000);
    const afterResume = await getEntries(client);
    const resumedNotice = noticeTitles(afterResume).some((t) => t.startsWith("pi-discuss: resumed"));

    const recallCursor = client.mark();
    const recallId = client.notify({ type: "prompt", message: `/pd-ask deepseek ${RECALL_QUESTION}` });
    const recallResponse = await client.awaitResponse(recallId, "/pd-ask (recall)", ROUND_MS);
    await client.waitFrom(recallCursor, "recall status cleared", statusCleared, 120_000);
    const afterRecall = await getEntries(client);
    const known = new Set(afterResume.map((e) => e.id));
    const recallEntry = panelEntries(afterRecall)
      .filter((e) => !known.has(e.id))
      .pop();
    const recallText = String(recallEntry?.data?.["text"] ?? "");
    const recallOutcome = String(recallEntry?.data?.["outcome"] ?? "(no entry)");

    const afterEntries = readJsonl(slotFile);
    const afterUserMessages = afterEntries.filter(
      (e) => (e["message"] as Record<string, unknown> | undefined)?.["role"] === "user",
    ).length;

    const resumeProblems: string[] = [];
    if (!resumeResponse.success) resumeProblems.push(`/pd-resume was rejected: ${resumeResponse.error}`);
    if (!resumedNotice) resumeProblems.push("no `resumed` notice was appended; the panel-drift or ledger guard refused");
    if (!recallResponse.success) resumeProblems.push(`/pd-ask was rejected: ${recallResponse.error}`);
    if (recallOutcome !== "answered") resumeProblems.push(`the recall ask came back ${recallOutcome}, not answered`);
    if (afterEntries.length <= beforeEntries.length) {
      resumeProblems.push(`the slot transcript did not grow (${beforeEntries.length} → ${afterEntries.length} entries); the resumed session did not append to it`);
    }
    if (afterUserMessages !== beforeUserMessages + 1) {
      resumeProblems.push(`user messages went ${beforeUserMessages} → ${afterUserMessages}; a restored transcript should gain exactly one`);
    }
    if (!recallText.toUpperCase().includes(NONCE)) {
      resumeProblems.push(`the panelist could not recall the round-0 codename, so its context did not come back: ${JSON.stringify(recallText.slice(0, 200))}`);
    }
    record(
      CHECKS[1],
      resumeProblems.length === 0 ? "PASS" : "FAIL",
      resumeProblems.length === 0
        ? `a fresh pi process restored sessions/deepseek.jsonl intact: the slot recalled the round-0 codename ${NONCE} and appended to the existing transcript`
        : resumeProblems.join("; "),
      [
        `transcript entries ${beforeEntries.length} → ${afterEntries.length}, user messages ${beforeUserMessages} → ${afterUserMessages}`,
        `recall answer: ${JSON.stringify(recallText.slice(0, 120))}`,
      ],
    );

    /* ── check 7: a real Exa call and a panelist that actually invokes the tool ── */
    const keyPresent = resolveExaKey() !== undefined;
    let searchCost = -1;
    let fetchCost = -1;
    let probeError: string | undefined;
    if (keyPresent) {
      try {
        const backend = createExaBackend();
        const search = await backend.search({ query: "Bun JavaScript runtime latest release", numResults: 2, maxCharacters: 600 });
        searchCost = search.costUsd;
        const first = search.hits.find((h) => h.url.length > 0);
        if (first !== undefined) {
          const fetched = await backend.fetch({ urls: [first.url], maxCharacters: 600 });
          fetchCost = fetched.costUsd;
        }
      } catch (err) {
        probeError = err instanceof Error ? err.message : String(err);
      }
    }

    let researchDir: string | undefined;
    let researchCost: number | undefined;
    let toolSightings: Array<[string, ToolSighting]> = [];
    let researchOutcomes = "";
    let researchError: string | undefined;
    if (keyPresent) {
      const closeId = client.notify({ type: "prompt", message: "/pd-close" });
      await client.awaitResponse(closeId, "/pd-close", 60_000);
      const known2 = new Set(discussionDirs(scratch.workDir));
      const openCursor = client.mark();
      const openId = client.notify({ type: "prompt", message: `/pd --research ${RESEARCH_TOPIC}` });
      try {
        researchDir = await waitForDiscussionDir(scratch.workDir, known2, BOOT_MS);
        const response = await client.awaitResponse(openId, "/pd --research", ROUND_MS);
        if (!response.success) researchError = `/pd --research was rejected: ${response.error}`;
        await client.waitFrom(openCursor, "research round 0 status cleared", statusCleared, 120_000);
        const meta = readMetaYaml(researchDir);
        const round = meta.rounds.find((r) => r.round === 0);
        researchCost = round?.researchCost;
        researchOutcomes = (round?.slots ?? []).map((s) => `${s.name}=${s.outcome}`).join(" ");
        const dir = researchDir;
        toolSightings = SLOTS.map((slot): [string, ToolSighting] => [
          slot,
          findResearchToolCalls(join(dir, "sessions", `${slot}.jsonl`)),
        ]);
      } catch (err) {
        researchError = describe(err);
      }
    }

    const invoked = toolSightings.filter(([, s]) => s.structured.length > 0);
    const researchProblems: string[] = [];
    if (!keyPresent) {
      record(CHECKS[6], "SKIP", 'readStoredCredential("exa") found no key and EXA_API_KEY is unset, so no live Exa call was possible');
    } else {
      if (probeError !== undefined) researchProblems.push(`the direct Exa probe threw: ${probeError}`);
      if (!(searchCost > 0)) researchProblems.push(`/search returned costDollars.total = ${searchCost}; §8.5 meters the real charge, not an estimate`);
      if (!(fetchCost > 0)) researchProblems.push(`/contents returned costDollars.total = ${fetchCost}`);
      if (researchError !== undefined) researchProblems.push(researchError);
      if (invoked.length === 0) {
        const mentions = toolSightings.map(([slot, s]) => `${slot}:${s.rawMentions}`).join(" ");
        researchProblems.push(`no panelist emitted a web_search/fetch_url toolCall (raw mentions per transcript: ${mentions || "n/a"}); naming the custom tool in \`tools\` may not have made it callable`);
      }
      if (!(typeof researchCost === "number" && researchCost > 0)) {
        researchProblems.push(`meta.yaml recorded research_cost = ${String(researchCost)}; the ledger did not fold the search charge into the round`);
      }
      record(
        CHECKS[6],
        researchProblems.length === 0 ? "PASS" : "FAIL",
        researchProblems.length === 0
          ? `readStoredCredential("exa") resolved a key, both Exa endpoints reported costDollars.total, and a panelist called the wrapped tool for real`
          : researchProblems.join("; "),
        [
          `direct probe: /search $${searchCost.toFixed(6)}, /contents $${fetchCost.toFixed(6)}`,
          `panelist tool calls: ${toolSightings.map(([slot, s]) => `${slot}=${s.structured.join("+") || "none"}`).join(", ")}`,
          `round research_cost in meta.yaml: ${researchCost === undefined ? "absent" : `$${researchCost.toFixed(6)}`}`,
          `research round outcomes: ${researchOutcomes || "n/a"}`,
        ],
      );
    }
  } finally {
    await client.close();
  }
}

/* ──────────────────────────────── driver ──────────────────────────────── */

async function main(): Promise<number> {
  const probe = Bun.spawnSync(["pi", "--version"]);
  if (!probe.success) {
    process.stderr.write("pi is not on PATH (or `pi --version` failed). Install pi before running smoke:rpc.\n");
    return 2;
  }
  log(`pi ${probe.stdout.toString().trim()}`);

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const scratch = createScratch(runId);
  log(`scratch: ${scratch.root}`);

  let failed = false;
  let phase1Result: Phase1Outcome | undefined;
  try {
    phase1Result = await phase1(scratch);
  } catch (err) {
    log(`\n!! phase 1 aborted: ${describe(err)}`);
    failed = true;
  }
  if (phase1Result !== undefined) {
    try {
      await phase2(scratch, phase1Result);
    } catch (err) {
      log(`\n!! phase 2 aborted: ${describe(err)}`);
      failed = true;
    }
  }

  for (const name of CHECKS) {
    record(name, "SKIP", failed ? "the run aborted before this check could execute" : "not reached");
  }

  const spend = totalSpend(scratch.workDir);
  const rows = CHECKS.map((name) => results.get(name)!);
  log("\n────────────────────────────────────────────────────────────────────");
  for (const row of rows) log(`  ${row.status.padEnd(4)}  ${row.name}`);
  log("────────────────────────────────────────────────────────────────────");
  log(
    `  spend (meta.yaml ledger): models $${spend.model.toFixed(4)} + search $${spend.research.toFixed(4)} = $${spend.total.toFixed(4)}`,
  );
  log("  /pd-ask turns write no round artifact (§4), so their tokens are outside this ledger.");

  const anyFail = rows.some((r) => r.status === "FAIL") || failed;
  if (anyFail || process.env["SMOKE_KEEP"] === "1") {
    log(`  scratch kept for inspection: ${scratch.root}`);
  } else {
    removeScratch(scratch.root);
    log("  scratch removed.");
  }
  return anyFail ? 1 : 0;
}

process.exit(await main());
