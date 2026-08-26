/**
 * The terminal half of DESIGN §15 check 3, which `smoke:rpc` cannot reach.
 *
 * RPC proves the *durable* half — appended entries round-trip through a reload
 * and no `extension_error` fires. It cannot prove the entries still *paint*,
 * because pi drops a custom entry whose customType has no registered renderer
 * **silently** (`addCustomEntryToChat` returns early), so a renderer that failed
 * to re-register on reload would leave `get_entries` intact and the transcript
 * blank. Only a real terminal tells those two apart.
 *
 * Opt-in, wired as `bun run smoke:tui`, never reachable from `bun run test`.
 * Free: the whole discussion is a fixture written straight to disk, and the one
 * live dependency is model *resolution* (no turn is ever taken).
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createDiscussionDir, sessionPath, writeMeta, writeRoundAnswer, writeTopic } from "../src/modules/artifacts.ts";
import type { DiscussionMeta } from "../src/modules/types.ts";
import { type NoticeEntryData, NOTICE_ENTRY_TYPE, type PanelistEntryData, PANELIST_ENTRY_TYPE } from "../src/modules/ui.ts";
import { clientVersion, findHerdr, Pane, serverRunning, shellQuote } from "./herdr.ts";
import { RpcClient } from "./rpc-client.ts";
import { type AvailableModel, cheapestModel, createScratch, modelPrice, removeScratch, type Scratch, writePanelYaml } from "./scratch.ts";

const BOOT_MS = 120_000;
/** `/pd-resume` opens the model runtime and boots one child session per slot. */
const RESUME_MS = 180_000;
const READ_LINES = 600;
/** Long enough for pi's TUI to redraw after a keystroke, short enough not to pad the run. */
const PAINT_MS = 1_500;
/** How long the first Enter is given to have submitted before a second is sent. */
const POPUP_MS = 6_000;

/** Rare enough that a match in the pane is the fixture and nothing else. */
const N_ALPHA = "PDTUI-ALPHA-9F3";
const N_BETA = "PDTUI-BETA-9F3";
const N_NOTICE = "PDTUI-NOTICE-9F3";
/** Sits past ui.ts's COLLAPSED_LINES, so seeing it means the collapse never ran. */
const N_BURIED = "PDTUI-BURIED-9F3";
const TOPIC = `Fixture topic ${N_ALPHA}`;

const ALPHA_TOKENS = 1234;
const ALPHA_COST = 0.0123;
const BETA_TOKENS = 77;
const BETA_COST = 0.0007;

type Status = "PASS" | "FAIL" | "SKIP";

const CHECKS = [
  "1 §15/3 rendered panelist blocks reappear after a session reload",
  "2 §14 replayed slot colours and the non-answered badge still resolve",
  "3 §15/3 /pd-resume paints into the reloaded session",
  "4 §14 the belowEditor footer widget carries live slot state",
] as const;

interface StepResult {
  status: Status;
  reason: string;
  notes: string[];
}

const results = new Map<string, StepResult>();

function log(line: string): void {
  process.stdout.write(`${line}\n`);
}

function record(name: string, status: Status, reason: string, notes: string[] = []): void {
  if (results.has(name)) return;
  results.set(name, { status, reason, notes });
  log(`\n[${status}] ${name}\n       ${reason}`);
  for (const note of notes) log(`       · ${note}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/* ─────────────────────────── screen assertions ─────────────────────────── */

/** The meta line ui.ts builds, so a drifted format fails the check rather than the grep. */
function metaLine(slot: string, model: string, round: number, tokens: number, cost: number): string {
  return `${slot} · ${model} · round ${round} · ${tokens} tok · $${cost.toFixed(4)}`;
}

/* pi's TUI repaints in place, and every repaint that scrolls leaves its partial
   copy behind in the host scrollback — so the *last* match is the only one
   guaranteed to come from a complete frame. */

function lastIndexWith(lines: string[], needle: string): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.includes(needle)) return i;
  }
  return -1;
}

function lastLineWith(screen: string, needle: string): string | undefined {
  const lines = screen.split("\n");
  const idx = lastIndexWith(lines, needle);
  return idx < 0 ? undefined : lines[idx];
}

/** The SGR sequence in force where `token` starts, as evidence that theme.fg() coloured it. */
function colorAt(ansiLine: string, token: string): string | undefined {
  const idx = ansiLine.indexOf(token);
  if (idx < 0) return undefined;
  const codes = [...ansiLine.slice(0, idx).matchAll(/\[([0-9;]*)m/g)].map((m) => m[1]);
  // A reset immediately precedes each coloured run, so the colour is the last
  // non-reset code — taking the literal last one would always read "0".
  for (let i = codes.length - 1; i >= 0; i--) {
    const code = codes[i];
    if (code !== undefined && code !== "0" && code !== "") return code;
  }
  return undefined;
}

const EXTENSION_ERROR_MARKERS = ['" error:', "Failed to load extension"];

function extensionErrorLines(screen: string): string[] {
  return screen.split("\n").filter((l) => EXTENSION_ERROR_MARKERS.some((m) => l.includes(m)));
}

/* ───────────────────────────── the fixture ───────────────────────────── */

interface SlotPick {
  name: string;
  model: string;
  color: "accent" | "warning";
}

/**
 * A whole discussion written straight to disk: `/pd-resume` reads meta.yaml, the
 * drift guard compares it against panel.yaml, and `createPanelist` reopens each
 * `sessions/<slot>.jsonl`. Written through the product's own writers so the
 * fixture is valid by construction rather than by a hand-copied YAML shape.
 */
function buildDiscussion(scratch: Scratch, slots: SlotPick[]): string {
  const at = new Date();
  const dirName = `2026-08-27-pd-tui-smoke-${at.getTime()}`;
  const dir = createDiscussionDir(scratch.workDir, dirName);
  writeTopic(dir, TOPIC, at);

  const meta: DiscussionMeta = {
    topic: TOPIC,
    createdAt: at.toISOString(),
    repoAccess: false,
    research: false,
    panel: slots.map((s) => ({ name: s.name, model: s.model, thinking: "low" as const })),
    rounds: [
      {
        round: 0,
        startedAt: at.toISOString(),
        answers: slots.map((s, i) => ({
          slot: s.name,
          outcome: i === 0 ? ("answered" as const) : ("timed-out" as const),
          text: `${s.name} fixture answer`,
          tokens: i === 0 ? ALPHA_TOKENS : BETA_TOKENS,
          cost: i === 0 ? ALPHA_COST : BETA_COST,
        })),
      },
    ],
  };
  writeMeta(dir, meta);
  for (const [i, slot] of slots.entries()) {
    writeRoundAnswer(dir, 0, meta.rounds[0]!.answers[i]!, slot.model);
    writeSlotSession(sessionPath(dir, slot.name), scratch.workDir, slot);
  }
  return dirName;
}

/**
 * SessionManager withholds the file until the session holds an assistant message
 * (DESIGN §15's live-run note) — a slot transcript of user turns alone never
 * reaches disk, and `/pd-resume` would then restore nothing.
 */
function writeSlotSession(path: string, cwd: string, slot: SlotPick): void {
  // open() rather than create(): it takes a path that does not exist yet, which
  // is how panelists.ts names a transcript by slot rather than by timestamp.
  const sm = SessionManager.open(path, undefined, cwd);
  sm.appendMessage({ role: "user", content: TOPIC, timestamp: Date.now() });
  sm.appendMessage(assistantMessage(slot.model, `${slot.name} fixture answer`));
}

type SessionMessage = Parameters<SessionManager["appendMessage"]>[0];

function assistantMessage(model: string, text: string): SessionMessage {
  const slash = model.indexOf("/");
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    // Never replayed to a provider — the fixture exists to be rendered and to
    // carry usage into the footer, so `api` only has to be present.
    api: "fixture",
    provider: model.slice(0, slash),
    model: model.slice(slash + 1),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

/** Longer than ui.ts's COLLAPSED_LINES, so the unexpanded render must cut it. */
function longAnswer(): string {
  const filler = Array.from({ length: 20 }, (_, i) => `- point ${i + 1}`);
  return [`# ${N_ALPHA}`, "", ...filler, "", N_BURIED].join("\n");
}

/**
 * The host session as pi would have left it: one moderator turn (without which
 * nothing is on disk at all) followed by the entries `appendEntry` recorded.
 */
function buildHostSession(scratch: Scratch, slots: SlotPick[]): string {
  const sm = SessionManager.create(scratch.workDir, scratch.sessionDir);
  sm.appendMessage({ role: "user", content: `seed ${N_NOTICE}`, timestamp: Date.now() });
  sm.appendMessage(assistantMessage(slots[0]!.model, "OK."));

  const entries: PanelistEntryData[] = [
    {
      slot: slots[0]!.name,
      color: slots[0]!.color,
      model: slots[0]!.model,
      round: 0,
      outcome: "answered",
      tokens: ALPHA_TOKENS,
      cost: ALPHA_COST,
      text: longAnswer(),
    },
    {
      slot: slots[1]!.name,
      color: slots[1]!.color,
      model: slots[1]!.model,
      round: 0,
      outcome: "timed-out",
      tokens: BETA_TOKENS,
      cost: BETA_COST,
      text: `${N_BETA} did not finish in time.`,
    },
  ];
  for (const entry of entries) sm.appendCustomEntry(PANELIST_ENTRY_TYPE, entry);
  sm.appendCustomEntry(NOTICE_ENTRY_TYPE, {
    title: "pi-discuss: fixture notice",
    body: `Notice body ${N_NOTICE}`,
    tone: "info",
  } satisfies NoticeEntryData);

  const file = sm.getSessionFile();
  if (file === undefined) throw new Error("the fixture host session was never given a file");
  return file;
}

/* ──────────────────────────── model resolution ──────────────────────────── */

/**
 * Two slots pi can actually resolve. `available` is already filtered to providers
 * with configured auth, so anything here passes checkPanelReadiness — and nothing
 * below ever prompts one of them, so the pick only has to exist, not be cheap.
 * It is cheapest-first anyway, in case a future check does spend a turn.
 */
async function pickSlots(scratch: Scratch): Promise<SlotPick[] | undefined> {
  const client = new RpcClient({
    args: ["--mode", "rpc", "-ne", "-na", "--session-dir", scratch.sessionDir],
    cwd: scratch.workDir,
    log: () => undefined,
  });
  try {
    const response = await client.request({ type: "get_available_models" }, 90_000);
    if (!response.success) return undefined;
    const models = (response.data?.["models"] ?? []) as AvailableModel[];
    const providers = [...new Set(models.map((m) => m.provider))];
    const perProvider = providers
      .flatMap((p) => cheapestModel(models, p) ?? [])
      .sort((a, b) => modelPrice(a) - modelPrice(b));
    if (perProvider.length === 0) return undefined;
    const first = perProvider[0]!;
    const second = perProvider[1] ?? first;
    return [
      { name: "alpha", model: `${first.provider}/${first.id}`, color: "accent" },
      { name: "beta", model: `${second.provider}/${second.id}`, color: "warning" },
    ];
  } catch {
    return undefined;
  } finally {
    await client.close();
  }
}

/* ──────────────────────────────── checks ──────────────────────────────── */

function checkReload(screen: string, slots: SlotPick[]): void {
  const alpha = metaLine(slots[0]!.name, slots[0]!.model, 0, ALPHA_TOKENS, ALPHA_COST);
  const beta = metaLine(slots[1]!.name, slots[1]!.model, 0, BETA_TOKENS, BETA_COST);
  const problems: string[] = [];

  if (!screen.includes(alpha)) problems.push(`no rendered header for slot "${slots[0]!.name}" (expected "${alpha}")`);
  if (!screen.includes(beta)) problems.push(`no rendered header for slot "${slots[1]!.name}" (expected "${beta}")`);
  if (!screen.includes(N_ALPHA)) problems.push(`slot "${slots[0]!.name}" rendered no answer body`);
  if (!screen.includes(N_BETA)) problems.push(`slot "${slots[1]!.name}" rendered no answer body`);
  if (!screen.includes("pi-discuss: fixture notice")) problems.push("the notice entry rendered no title — its renderer registered second and may not have survived");
  if (!screen.includes(N_NOTICE)) problems.push("the notice entry rendered no body");
  if (!screen.includes("truncated; expand to read the rest")) problems.push("the long answer was not collapsed");
  if (screen.includes(N_BURIED)) problems.push("text past COLLAPSED_LINES was painted, so collapse() never ran");
  // The failure mode this check exists for is silence, not noise: an unrendered
  // custom entry is dropped without a trace, so an entry-shaped string on screen
  // would mean pi fell back to dumping the record instead.
  if (screen.includes(PANELIST_ENTRY_TYPE)) problems.push(`the raw customType "${PANELIST_ENTRY_TYPE}" is on screen — the renderer did not claim the entry`);
  const errors = extensionErrorLines(screen);
  if (errors.length > 0) problems.push(`extension error on screen: ${errors[0]!.trim().slice(0, 160)}`);

  record(
    CHECKS[0],
    problems.length === 0 ? "PASS" : "FAIL",
    problems.length === 0
      ? "both panelist blocks and the notice repainted from the reloaded JSONL, collapsed, with no raw entry text and no extension error"
      : problems.join("; "),
    [
      `slot headers found verbatim: "${alpha}" and "${beta}"`,
      "pi drops a custom entry with no registered renderer silently, so a missing block — not an error — is what a failed re-registration looks like",
      `extension error lines on screen: ${errors.length}`,
    ],
  );
}

function checkColors(ansi: string, slots: SlotPick[]): void {
  const alphaLine = lastLineWith(ansi, `${ALPHA_TOKENS} tok`);
  const betaLine = lastLineWith(ansi, `${BETA_TOKENS} tok`);
  const problems: string[] = [];

  if (alphaLine === undefined || betaLine === undefined) {
    record(CHECKS[1], "FAIL", "could not find both slot header lines in the ansi read, so no colour could be sampled");
    return;
  }

  const alphaColor = colorAt(alphaLine, slots[0]!.name);
  const betaColor = colorAt(betaLine, slots[1]!.name);
  const badgeColor = colorAt(betaLine, "[timed-out]");

  if (alphaColor === undefined) problems.push(`slot "${slots[0]!.name}" was painted with no SGR colour at all`);
  if (betaColor === undefined) problems.push(`slot "${slots[1]!.name}" was painted with no SGR colour at all`);
  // The two slots are configured `accent` and `warning`. Identical colours mean
  // isThemeColor() rejected the replayed strings and both fell back to "text" —
  // exactly the JSONL round-trip hazard ui.ts guards against.
  if (alphaColor !== undefined && alphaColor === betaColor) {
    problems.push(`both slots painted in the same colour (${alphaColor}); the replayed colour tokens did not resolve`);
  }
  if (!betaLine.includes("[timed-out]")) problems.push("the timed-out slot rendered no outcome badge");
  if (badgeColor === undefined) problems.push("the outcome badge was painted with no SGR colour");
  if (badgeColor !== undefined && badgeColor === betaColor) {
    problems.push(`the badge reused the slot colour (${badgeColor}) instead of the error colour`);
  }

  record(
    CHECKS[1],
    problems.length === 0 ? "PASS" : "FAIL",
    problems.length === 0
      ? "each slot label came back in its own configured colour and the non-answered badge in the error colour"
      : problems.join("; "),
    [
      `${slots[0]!.name} (accent) → SGR ${alphaColor ?? "none"}`,
      `${slots[1]!.name} (warning) → SGR ${betaColor ?? "none"}`,
      `[timed-out] badge → SGR ${badgeColor ?? "none"}`,
      "colour reaches the renderer as a bare JSONL string; isThemeColor() failing would make every slot fall back to the same token",
    ],
  );
}

function checkResume(screen: string, dirName: string, slots: SlotPick[]): void {
  const problems: string[] = [];
  if (!screen.includes(`pi-discuss: resumed ${dirName}`)) {
    problems.push("the resume notice never appeared, so nothing was appended or nothing painted it");
  }
  if (!screen.includes(`Topic: ${TOPIC}`)) problems.push("the resume notice rendered no topic line from meta.yaml");
  if (!screen.includes("Rounds on the record: 1")) problems.push("the resume notice did not report the fixture's one round");
  for (const slot of slots) {
    if (!screen.includes(`${slot.name} — ${slot.model}`)) problems.push(`the resume notice omitted slot "${slot.name}"`);
  }
  const errors = extensionErrorLines(screen);
  if (errors.length > 0) problems.push(`extension error on screen: ${errors[0]!.trim().slice(0, 160)}`);

  record(
    CHECKS[2],
    problems.length === 0 ? "PASS" : "FAIL",
    problems.length === 0
      ? `/pd-resume restored the fixture discussion and its notice painted through the renderer registered before the reload`
      : problems.join("; "),
    [
      `discussion: ${dirName}`,
      "the entry is appended *after* the session reload, so this covers the live half that a replay of the JSONL cannot",
      `extension error lines on screen: ${errors.length}`,
    ],
  );
}

/**
 * The footer is `ctx.ui.setWidget(..., { placement: "belowEditor" })` behind
 * ui.ts's `ctx.mode === "tui"` gate — it does not exist in RPC mode at all, so
 * this is the one place its content and its placement can be checked.
 */
function checkFooter(screen: string, dirName: string, slots: SlotPick[]): void {
  const lines = screen.split("\n");
  const expected = `pd ${dirName} · idle · ${slots.map((s) => `${s.name}:waiting`).join(" ")} · `;
  const footerIdx = lastIndexWith(lines, expected);
  const problems: string[] = [];

  if (footerIdx < 0) {
    record(
      CHECKS[3],
      "FAIL",
      `no footer line matching "${expected}…" — setWidget never painted, or footerLines() drifted`,
    );
    return;
  }
  const footer = lines[footerIdx]!;
  const tokens = Number(/· (\d+) tok · /.exec(footer)?.[1] ?? "0");
  if (tokens <= 0) {
    problems.push(`the footer reported ${tokens} tokens; the restored slot transcripts carried no usage into aggregateCost()`);
  }
  if (!/· \$\d+\.\d{3}(?: |$)/.test(footer)) problems.push("the footer printed no 3-decimal cost field");
  // The editor's bottom border is the last box rule on screen, so a footer after
  // it is a footer below the editor — which is what the placement option claims.
  const borderIdx = lastIndexWith(lines, "───");
  if (borderIdx > footerIdx) problems.push("the footer painted above the editor's bottom border, not belowEditor");

  record(
    CHECKS[3],
    problems.length === 0 ? "PASS" : "FAIL",
    problems.length === 0
      ? `the footer painted below the editor with the discussion name, both slots' state, and ${tokens} tokens read back from the restored transcripts`
      : problems.join("; "),
    [`footer: ${footer.trim()}`, "RPC mode never builds this widget, so smoke:rpc cannot see it at all"],
  );
}

/* ──────────────────────────────── driver ──────────────────────────────── */

function skipAll(reason: string): void {
  for (const name of CHECKS) record(name, "SKIP", reason);
}

async function main(): Promise<number> {
  const herdr = findHerdr();
  if (herdr === undefined) {
    log("SKIP: no `herdr` binary on PATH or at ~/.local/bin/herdr — smoke:tui needs a real PTY to read a rendered screen from.");
    return 0;
  }
  if (!serverRunning(herdr)) {
    log("SKIP: the herdr server is not running (`herdr status` reports no server). Start herdr, then re-run.");
    return 0;
  }
  const piProbe = Bun.spawnSync(["pi", "--version"]);
  if (!piProbe.success) {
    log("SKIP: pi is not on PATH (or `pi --version` failed).");
    return 0;
  }
  log(`pi ${piProbe.stdout.toString().trim()} · herdr ${clientVersion(herdr)}`);

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const scratch = createScratch(runId);
  mkdirSync(join(scratch.workDir, "discussions"), { recursive: true });
  log(`scratch: ${scratch.root}`);

  let pane: Pane | undefined;
  let aborted = false;
  try {
    const slots = await pickSlots(scratch);
    if (slots === undefined) {
      skipAll("pi resolved no models with configured auth, so no panel could be pinned");
      return 0;
    }
    log(`  slots: ${slots.map((s) => `${s.name}=${s.model}`).join(", ")}`);

    writePanelYaml(
      scratch.panelPath,
      slots.map((s) => ({ name: s.name, model: s.model, thinking: "low", color: s.color })),
      { rounds: 1, repo_access: false, research: false, max_cost: 0.5 },
    );
    const dirName = buildDiscussion(scratch, slots);
    const hostSession = buildHostSession(scratch, slots);
    log(`  fixture discussion: ${dirName}`);
    log(`  fixture host session: ${hostSession}`);

    pane = Pane.open(herdr, { cwd: scratch.workDir, label: `pd-tui-${runId}` });
    log(`  pane: ${pane.paneId}`);

    // -ne keeps the user's own extensions out; -na declines project-local config
    // so no trust dialog can block the boot. --session reloads the fixture, which
    // is the reload this check is about.
    pane.run(
      shellQuote(["pi", "-ne", "-na", "-e", scratch.extEntry, "--session-dir", scratch.sessionDir, "--session", hostSession]),
    );

    const painted = pane.waitFor(metaLine(slots[0]!.name, slots[0]!.model, 0, ALPHA_TOKENS, ALPHA_COST), BOOT_MS, READ_LINES);
    if (!painted) {
      log(`\n  pane after the boot timeout:\n${pane.read({ lines: READ_LINES })}`);
    }
    await sleep(PAINT_MS);

    const screen = pane.read({ lines: READ_LINES });
    checkReload(screen, slots);
    checkColors(pane.read({ lines: READ_LINES, ansi: true }), slots);

    // Typed rather than passed on the command line: the point is a command
    // dispatched into an already-reloaded session, not a startup argument.
    pane.sendText(`/pd-resume ${dirName}`);
    await sleep(PAINT_MS);
    const marker = `pi-discuss: resumed ${dirName}`;
    pane.sendKeys("enter");
    // /pd-resume offers argument completions, and the popup that opens consumes
    // the first Enter to accept the highlighted directory instead of submitting.
    // A second Enter submits; if the first already did, this one lands on an
    // empty prompt, which pi ignores.
    if (!pane.waitFor(marker, POPUP_MS, READ_LINES)) pane.sendKeys("enter");
    const resumed = pane.waitFor(marker, RESUME_MS, READ_LINES);
    await sleep(PAINT_MS);
    const afterResume = pane.read({ lines: READ_LINES });
    if (!resumed) log(`\n  pane after the resume timeout:\n${afterResume}`);
    checkResume(afterResume, dirName, slots);
    checkFooter(afterResume, dirName, slots);
  } catch (err) {
    log(`\n!! run aborted: ${err instanceof Error ? err.message : String(err)}`);
    aborted = true;
  } finally {
    pane?.close();
    // The pane close takes the process group with it; this is the backstop for a
    // pi that outlived it. The run id makes the pattern unique to this run.
    Bun.spawnSync(["pkill", "-f", scratch.root]);
  }

  skipAll(aborted ? "the run aborted before this check could execute" : "not reached");

  const rows = [...CHECKS].map((name) => ({ name, ...results.get(name)! }));
  log("\n────────────────────────────────────────────────────────────────────");
  for (const row of rows) log(`  ${row.status.padEnd(4)}  ${row.name}`);
  log("────────────────────────────────────────────────────────────────────");
  log("  cost: $0.00 — the discussion is a disk fixture and no slot is ever prompted.");

  const anyFail = rows.some((r) => r.status === "FAIL") || aborted;
  if (anyFail || process.env["SMOKE_KEEP"] === "1") {
    log(`  scratch kept for inspection: ${scratch.root}`);
  } else {
    removeScratch(scratch.root);
    log("  scratch removed.");
  }
  return anyFail ? 1 : 0;
}

process.exit(await main());
