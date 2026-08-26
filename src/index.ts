import { existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import {
  appendSteer,
  ArtifactError,
  createDiscussionDir,
  DISCUSSIONS_DIRNAME,
  discussionDirName,
  listDiscussionDirs,
  readMeta,
  sessionPath,
  slugify,
  writeMeta,
  writeRoundAnswer,
  writeSynthesis,
  writeTopic,
} from "./modules/artifacts.ts";
import {
  checkPanelReadiness,
  ConfigError,
  loadPanelConfig,
  type PanelConfig,
  type SlotConfig,
} from "./modules/config.ts";
import { aggregateCost, checkCostGuard } from "./modules/cost.ts";
import {
  checkPanelDrift,
  debateLoop,
  type Discussion,
  hydratedRounds,
  newDiscussion,
  nextRoundNumber,
  previousAnswers,
} from "./modules/discussion.ts";
import { createPanelist, disposePanelists, type Panelist, type PanelistModel } from "./modules/panelists.ts";
import { buildSynthesisPrompt } from "./modules/prompts/synthesis.ts";
import { askPanelist, finishRound, runRound, type RoundSpec } from "./modules/rounds.ts";
import { type DiscussionMeta, type RoundRecord, type SlotAnswer, snapshotPanel } from "./modules/types.ts";
import {
  hideFooter,
  notice,
  notify,
  PANELIST_ENTRY_TYPE,
  type PanelistEntryData,
  registerNoticeRenderer,
  registerPanelistRenderer,
  setRoundStatus,
  showFooter,
} from "./modules/ui.ts";

/** panel.yaml sits beside the extension source (§16); it holds no secrets, so it is tracked. */
const PANEL_CONFIG_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "panel.yaml");

const SYNTHESIS_MESSAGE_TYPE = "pi-discuss.synthesis-request";
const TURN_START_GRACE_MS = 10_000;

type SlotState = "waiting" | "running" | "done" | "failed";

interface SynthesisCapture {
  phase: "awaiting-start" | "capturing";
  text: string;
  onStart?: () => void;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Structural, so the host-reply capture needs no type from the transitive agent-core package. */
function lastAssistantText(messages: readonly { role: string; content?: unknown }[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message === undefined || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const text = message.content
      .map((part) =>
        typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text"
          ? String((part as { text?: unknown }).text ?? "")
          : "",
      )
      .join("")
      .trim();
    if (text.length > 0) return text;
  }
  return "";
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/**
 * `--no-repo` only counts as its own whole token. A prefix match would read
 * `/pd --no-repository access tradeoffs` as the flag plus a mangled topic, and
 * silently drop the panel's repo access along the way.
 */
export function parseOpenArgs(args: string): { noRepo: boolean; topic: string } {
  const trimmed = args.trim();
  const flag = /^--no-repo(?=\s|$)\s*/.exec(trimmed);
  if (flag === null) return { noRepo: false, topic: trimmed };
  return { noRepo: true, topic: trimmed.slice(flag[0].length).trim() };
}

export default function piDiscuss(pi: ExtensionAPI): void {
  let disposed = false;
  let lastCtx: ExtensionContext | undefined;
  let active: Discussion | undefined;
  let runtime: ModelRuntime | undefined;
  const slotState = new Map<string, SlotState>();
  let currentRound: number | undefined;
  // Synchronous, so a second submission cannot slip past the `active` check
  // during the many awaits before `active` is assigned. Command handlers do
  // genuinely re-enter: the interactive mode does not await onSubmit.
  let booting = false;

  // Armed only across a single /pd-synthesize send. Scoped to the turn that send
  // triggers: without that, an unrelated turn's reply would be captured and
  // written to synthesis.md.
  let synthesisCapture: SynthesisCapture | undefined;

  registerPanelistRenderer(pi);
  registerNoticeRenderer(pi);

  /* ─────────────────────────── lifecycle ─────────────────────────── */

  pi.on("session_start", (_event, ctx) => {
    lastCtx = ctx;
    disposed = false;
  });

  pi.on("session_shutdown", async () => {
    // Latch FIRST, so an in-flight step observes it before the teardown cascade.
    // This fires on `/new` and `/resume` too, not just quit, so a session
    // replacement mid-discussion must tear the panel down exactly like a quit.
    disposed = true;
    const discussion = active;
    active = undefined;
    if (discussion !== undefined) {
      discussion.controller.abort();
      // Give the in-flight round a bounded window to write what it has: aborting
      // resolves every slot as timed-out, and those artifacts are still the record.
      if (discussion.inFlight !== undefined) {
        await Promise.race([discussion.inFlight, delay(15_000)]);
      }
      await disposePanelists(discussion.panelists);
    }
    hideFooter(lastCtx);
    setRoundStatus(lastCtx, undefined);
    lastCtx = undefined;
  });

  pi.on("agent_start", () => {
    // /pd-synthesize only sends while the moderator is idle, so the first turn to
    // start after the send is ours.
    if (synthesisCapture?.phase !== "awaiting-start") return;
    synthesisCapture.phase = "capturing";
    synthesisCapture.onStart?.();
  });

  pi.on("agent_end", (event) => {
    // Retries fire agent_end more than once; the last one before idle wins.
    if (synthesisCapture?.phase !== "capturing") return;
    const text = lastAssistantText(event.messages);
    if (text.length > 0) synthesisCapture.text = text;
  });

  /* ──────────────────────────── helpers ──────────────────────────── */

  function refuse(ctx: ExtensionCommandContext, title: string, body = ""): void {
    notice(pi, title, body, "error");
    notify(ctx, title, "error");
  }

  function readPanel(ctx: ExtensionCommandContext): PanelConfig | undefined {
    try {
      return loadPanelConfig(PANEL_CONFIG_PATH);
    } catch (err) {
      const message = err instanceof ConfigError ? err.message : String(err);
      refuse(ctx, "pi-discuss: panel.yaml is not usable", `${message}\n\nConfig: \`${PANEL_CONFIG_PATH}\``);
      return undefined;
    }
  }

  async function getRuntime(): Promise<ModelRuntime> {
    runtime ??= await ModelRuntime.create();
    return runtime;
  }

  /** §8.1: resolve every model and its auth before a discussion opens. */
  async function guardedModels(
    ctx: ExtensionCommandContext,
    panel: PanelConfig,
  ): Promise<{ runtime: ModelRuntime; models: Map<string, PanelistModel> } | undefined> {
    let mr: ModelRuntime;
    try {
      mr = await getRuntime();
    } catch (err) {
      refuse(ctx, "pi-discuss: cannot open the model runtime", String(err));
      return undefined;
    }
    const readiness = checkPanelReadiness<PanelistModel>(panel.slots, mr);
    if (!readiness.ok) {
      refuse(
        ctx,
        "pi-discuss: the panel cannot be convened",
        readiness.problems.map((p) => `- ${p}`).join("\n"),
      );
      return undefined;
    }
    return { runtime: mr, models: readiness.models };
  }

  async function bootPanelists(args: {
    panel: PanelConfig;
    models: Map<string, PanelistModel>;
    runtime: ModelRuntime;
    cwd: string;
    dir: string;
    repoAccess: boolean;
  }): Promise<Panelist[]> {
    const panelists: Panelist[] = [];
    try {
      for (const slot of args.panel.slots) {
        panelists.push(
          await createPanelist({
            slot,
            model: args.models.get(slot.name)!,
            modelRuntime: args.runtime,
            cwd: args.cwd,
            sessionFile: sessionPath(args.dir, slot.name),
            repoAccess: args.repoAccess,
          }),
        );
      }
    } catch (err) {
      await disposePanelists(panelists);
      throw err;
    }
    return panelists;
  }

  function footerLines(discussion: Discussion): string[] {
    const snapshot = aggregateCost(discussion.panelists.map((p) => ({ name: p.slot.name, session: p.session })));
    const states = discussion.slots
      .map((s) => `${s.name}:${slotState.get(s.name) ?? "waiting"}`)
      .join(" ");
    const round = currentRound === undefined ? "idle" : `r${currentRound}`;
    return [
      `pd ${discussion.dir.split("/").pop()} · ${round} · ${states} · ` +
        `${formatTokens(snapshot.totalTokens)} tok · $${snapshot.totalCost.toFixed(3)}`,
    ];
  }

  function renderAnswer(round: number, answer: SlotAnswer, slot: SlotConfig): void {
    try {
      pi.appendEntry<PanelistEntryData>(PANELIST_ENTRY_TYPE, {
        slot: slot.name,
        color: slot.color,
        model: slot.model,
        round,
        outcome: answer.outcome,
        tokens: answer.tokens,
        cost: answer.cost,
        text: answer.text,
      });
    } catch {
      // The host session may already have been replaced; the artifact is on disk.
    }
  }

  async function runAndFinish(
    ctx: ExtensionCommandContext,
    discussion: Discussion,
    spec: Omit<RoundSpec, "panelists" | "signal" | "onSlotStart" | "onSlotSettled">,
  ): Promise<RoundRecord | undefined> {
    if (discussion.running) {
      refuse(ctx, "pi-discuss: a round is already running", "Wait for it, or cancel it with `/pd-abort`.");
      return undefined;
    }

    discussion.running = true;
    // A tripped controller stays tripped: a round that follows an abort needs a
    // fresh one, or every slot would fail instantly on the stale signal.
    if (discussion.controller.signal.aborted) discussion.controller = new AbortController();
    currentRound = spec.round;
    for (const slot of discussion.slots) slotState.set(slot.name, "waiting");
    setRoundStatus(ctx, `pi-discuss: round ${spec.round} across ${discussion.slots.length} models`);

    const work = (async (): Promise<RoundRecord> => {
      const record = await runRound({
        ...spec,
        panelists: discussion.panelists,
        signal: discussion.controller.signal,
        onSlotStart: (slot) => slotState.set(slot.name, "running"),
        onSlotSettled: (answer) => slotState.set(answer.slot, answer.outcome === "answered" ? "done" : "failed"),
      });
      discussion.meta.rounds.push(record);
      await finishRound({
        record,
        slots: discussion.slots,
        isDisposed: () => disposed,
        writeAnswer: (answer, slot) => {
          writeRoundAnswer(discussion.dir, record.round, answer, slot.model);
        },
        writeLedger: () => writeMeta(discussion.dir, discussion.meta),
        render: (answer, slot) => renderAnswer(record.round, answer, slot),
      });
      return record;
    })();

    discussion.inFlight = work.then(
      () => undefined,
      () => undefined,
    );

    try {
      return await work;
    } catch (err) {
      refuse(ctx, `pi-discuss: round ${spec.round} failed`, String(err));
      return undefined;
    } finally {
      discussion.running = false;
      discussion.inFlight = undefined;
      currentRound = undefined;
      setRoundStatus(ctx, undefined);
    }
  }

  function requireActive(ctx: ExtensionCommandContext, what: string): Discussion | undefined {
    if (active === undefined) {
      refuse(ctx, `pi-discuss: no open discussion`, `Start one with \`/pd <topic>\` before running ${what}.`);
      return undefined;
    }
    return active;
  }

  /** §8.5, consulted at a round boundary only. Returns false when the round must not start. */
  function costGate(ctx: ExtensionCommandContext, discussion: Discussion): boolean {
    const snapshot = aggregateCost(discussion.panelists.map((p) => ({ name: p.slot.name, session: p.session })));
    const ruling = checkCostGuard(snapshot.totalCost, discussion.maxCost);
    if (ruling.action === "refuse") {
      refuse(ctx, "pi-discuss: cost limit reached", ruling.message);
      return false;
    }
    if (ruling.action === "warn") notice(pi, "pi-discuss: cost warning", ruling.message, "warning");
    return true;
  }

  /**
   * Read through a call, not off `active` directly: other command handlers mutate
   * both across awaits, and narrowing from an earlier check would otherwise make
   * a re-check look statically impossible.
   */
  function isRoundRunning(): boolean {
    return active?.running === true;
  }

  async function closeActive(): Promise<void> {
    const discussion = active;
    active = undefined;
    if (discussion === undefined) return;
    discussion.controller.abort();
    await disposePanelists(discussion.panelists);
  }

  /* ──────────────────────────── commands ─────────────────────────── */

  pi.registerCommand("pd", {
    description: "Open a discussion: boot the panel and run round 0 (independent answers)",
    handler: async (args, ctx) => {
      if (booting) {
        refuse(ctx, "pi-discuss: a panel is already booting", "Wait for it to finish.");
        return;
      }
      if (active !== undefined) {
        refuse(
          ctx,
          "pi-discuss: a discussion is already open",
          `\`${active.dir}\` is open. Close it with \`/pd-close\` when you are done with it.`,
        );
        return;
      }

      const parsed = parseOpenArgs(args);
      if (parsed.topic.length === 0) {
        refuse(ctx, "pi-discuss: usage", "`/pd [--no-repo] <topic>`");
        return;
      }
      const topic = parsed.topic;

      booting = true;
      let opened: Discussion | undefined;
      try {
        const panel = readPanel(ctx);
        if (panel === undefined) return;
        const resolved = await guardedModels(ctx, panel);
        if (resolved === undefined) return;

        const now = new Date();
        const useRepo = parsed.noRepo ? false : panel.defaults.repoAccess;
        let dir: string;
        try {
          dir = createDiscussionDir(ctx.cwd, discussionDirName(now, slugify(topic)));
        } catch (err) {
          refuse(
            ctx,
            "pi-discuss: cannot open the discussion directory",
            err instanceof ArtifactError ? err.message : String(err),
          );
          return;
        }

        writeTopic(dir, topic, now);

        let panelists: Panelist[];
        try {
          panelists = await bootPanelists({
            panel,
            models: resolved.models,
            runtime: resolved.runtime,
            cwd: ctx.cwd,
            dir,
            repoAccess: useRepo,
          });
        } catch (err) {
          // Nothing but topic.md exists yet; removing it keeps the same topic
          // retryable instead of tripping the collision guard on the next attempt.
          rmSync(dir, { recursive: true, force: true });
          refuse(ctx, "pi-discuss: could not boot the panel", String(err));
          return;
        }

        const meta: DiscussionMeta = {
          topic,
          createdAt: now.toISOString(),
          repoAccess: useRepo,
          panel: snapshotPanel(panel.slots),
          rounds: [],
        };
        writeMeta(dir, meta);

        const discussion = newDiscussion({ dir, meta, panel, panelists });
        active = discussion;
        opened = discussion;
        slotState.clear();

        notice(
          pi,
          `pi-discuss: ${panel.slots.length}-model panel convened`,
          [
            `Topic: ${topic}`,
            "",
            ...panel.slots.map((s) => `- **${s.name}** — ${s.model} (thinking: ${s.thinking})`),
            "",
            `Repo access: ${useRepo ? "on" : "off"} · Artifacts: \`${dir}\``,
          ].join("\n"),
        );

        showFooter(ctx, () => footerLines(discussion), () => discussion.running);
      } finally {
        booting = false;
      }

      if (opened === undefined) return;
      await runAndFinish(ctx, opened, { round: 0, topic: opened.meta.topic, peers: [] });
    },
  });

  pi.registerCommand("pd-debate", {
    description: "Run n debate rounds; each panelist sees the others' labeled positions",
    handler: async (args, ctx) => {
      const discussion = requireActive(ctx, "`/pd-debate`");
      if (discussion === undefined) return;

      const raw = args.trim();
      let count = discussion.defaultRounds;
      if (raw.length > 0) {
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed < 1) {
          refuse(ctx, "pi-discuss: usage", "`/pd-debate [n]` — n must be a positive integer");
          return;
        }
        count = parsed;
      }

      await debateLoop({
        rounds: count,
        discussion,
        canStart: () => !disposed && active === discussion && costGate(ctx, discussion),
        runRound: async (round, steer) => {
          const record = await runAndFinish(ctx, discussion, {
            round,
            topic: discussion.meta.topic,
            peers: previousAnswers(discussion),
            ...(steer === undefined ? {} : { steer }),
          });
          return record !== undefined;
        },
        recordSteer: (text, round) => appendSteer(discussion.dir, text, round, new Date()),
      });
    },
  });

  pi.registerCommand("pd-steer", {
    description: "Inject verbatim steering into every panelist's next round",
    handler: async (args, ctx) => {
      const discussion = requireActive(ctx, "`/pd-steer`");
      if (discussion === undefined) return;
      // The only edit to the user's text: the separator the command syntax adds.
      // From here it reaches every slot byte-for-byte identically (§9).
      const text = args.trim();
      if (text.length === 0) {
        refuse(ctx, "pi-discuss: usage", "`/pd-steer <text>`");
        return;
      }
      discussion.pendingSteer = text;
      notice(pi, "pi-discuss: steering queued for the next round", text);
    },
  });

  pi.registerCommand("pd-ask", {
    description: "Press one panelist directly, with its session context intact",
    getArgumentCompletions: (prefix) => {
      const slots = active?.slots ?? [];
      return slots
        .filter((s) => s.name.startsWith(prefix))
        .map((s) => ({ value: s.name, label: s.name, description: s.model }));
    },
    handler: async (args, ctx) => {
      const discussion = requireActive(ctx, "`/pd-ask`");
      if (discussion === undefined) return;

      const trimmed = args.trim();
      const space = trimmed.indexOf(" ");
      const name = space < 0 ? trimmed : trimmed.slice(0, space);
      const question = space < 0 ? "" : trimmed.slice(space + 1).trim();
      const panelist = discussion.panelists.find((p) => p.slot.name === name);

      if (panelist === undefined || question.length === 0) {
        refuse(
          ctx,
          "pi-discuss: usage",
          `\`/pd-ask <slot> <question>\` — slots: ${discussion.slots.map((s) => s.name).join(", ")}`,
        );
        return;
      }
      if (discussion.running) {
        refuse(ctx, "pi-discuss: a round is running", "Wait for it, or cancel it with `/pd-abort`.");
        return;
      }
      // An ask spends real tokens, so a hard max_cost has to gate it too —
      // otherwise the limit is bypassable by asking each slot in turn.
      if (!costGate(ctx, discussion)) return;

      // Not a round: no peer set, no round artifact. The exchange persists in the
      // slot's own sessions/<slot>.jsonl, which is what keeps its context intact.
      discussion.running = true;
      if (discussion.controller.signal.aborted) discussion.controller = new AbortController();
      setRoundStatus(ctx, `pi-discuss: asking ${name}`);
      slotState.set(name, "running");
      try {
        const answer = await askPanelist(panelist, question, discussion.controller.signal);
        slotState.set(name, answer.outcome === "answered" ? "done" : "failed");
        // The ask belongs to the last round that ran; before round 0 there is none,
        // and rendering "round -1" would read as a real round on the record.
        renderAnswer(Math.max(0, nextRoundNumber(discussion.meta) - 1), answer, panelist.slot);
      } finally {
        discussion.running = false;
        setRoundStatus(ctx, undefined);
      }
    },
  });

  pi.registerCommand("pd-synthesize", {
    description: "Feed the collected rounds to the moderator and write synthesis.md",
    handler: async (args, ctx) => {
      void args;
      const discussion = requireActive(ctx, "`/pd-synthesize`");
      if (discussion === undefined) return;
      if (discussion.meta.rounds.length === 0) {
        refuse(ctx, "pi-discuss: nothing to synthesize", "No rounds have run yet.");
        return;
      }
      if (discussion.running) {
        refuse(ctx, "pi-discuss: a round is running", "Wait for it, or cancel it with `/pd-abort`.");
        return;
      }
      // sendMessage into a streaming moderator STEERS the running turn instead of
      // opening its own, which would both derail that turn and leave the capture
      // reading someone else's reply.
      if (!ctx.isIdle()) {
        refuse(
          ctx,
          "pi-discuss: the moderator is busy",
          "Wait for the current turn to finish, then run `/pd-synthesize` again.",
        );
        return;
      }
      if (synthesisCapture !== undefined) {
        refuse(ctx, "pi-discuss: a synthesis is already running", "Wait for it to finish.");
        return;
      }

      const prompt = buildSynthesisPrompt({
        topic: discussion.meta.topic,
        panel: discussion.slots.map((s) => `${s.name} (${s.model})`),
        rounds: hydratedRounds(discussion),
      });

      const capture: SynthesisCapture = { phase: "awaiting-start", text: "" };
      const started = new Promise<void>((resolveStarted) => {
        capture.onStart = resolveStarted;
      });
      synthesisCapture = capture;
      try {
        // The one deliberate context injection (§14): appendEntry renders without
        // entering the moderator's window, so the rounds have to arrive this way
        // for the moderator to be able to read them at all.
        pi.sendMessage(
          { customType: SYNTHESIS_MESSAGE_TYPE, content: prompt, display: true },
          { triggerTurn: true },
        );
        await Promise.race([started, delay(TURN_START_GRACE_MS)]);
        if (capture.phase === "capturing") await ctx.waitForIdle();
      } finally {
        synthesisCapture = undefined;
      }

      if (capture.text.length === 0) {
        const why =
          capture.phase === "awaiting-start"
            ? `The moderator's turn did not start within ${TURN_START_GRACE_MS / 1000}s.`
            : "The moderator's turn produced no text.";
        refuse(
          ctx,
          "pi-discuss: synthesis was NOT written",
          [
            why,
            "",
            "If a synthesis appears in the transcript above, it was still paid for but did not reach disk —",
            "`synthesis.md` is unchanged. The rounds are intact, so re-running `/pd-synthesize` once the",
            "moderator is idle costs one more moderator turn and writes the file.",
          ].join("\n"),
        );
        return;
      }

      writeSynthesis(discussion.dir, capture.text, new Date());
      notice(pi, "pi-discuss: synthesis written", `\`${join(discussion.dir, "synthesis.md")}\``);
    },
  });

  pi.registerCommand("pd-abort", {
    description: "Cancel the in-flight round",
    handler: async (args, ctx) => {
      void args;
      const discussion = requireActive(ctx, "`/pd-abort`");
      if (discussion === undefined) return;
      if (!discussion.running) {
        notice(pi, "pi-discuss: nothing to abort", "No round is in flight.", "warning");
        return;
      }
      // ctx.signal is undefined in idle-fired command handlers, so a multi-minute
      // round cannot see Escape or Ctrl+C — cancellation is extension-owned (§12).
      discussion.controller.abort();
      notice(pi, "pi-discuss: aborting the round", "Slots are being aborted; partial artifacts will still be written.", "warning");
      if (discussion.inFlight !== undefined) await discussion.inFlight;
    },
  });

  pi.registerCommand("pd-status", {
    description: "Show slots, models, per-slot tokens and cost, and the current round",
    handler: async (args, ctx) => {
      void args;
      if (active === undefined) {
        const dirs = listDiscussionDirs(ctx.cwd);
        notice(
          pi,
          "pi-discuss: no open discussion",
          dirs.length === 0
            ? "Start one with `/pd <topic>`."
            : [`Past discussions in \`${DISCUSSIONS_DIRNAME}/\`:`, "", ...dirs.slice(0, 10).map((d) => `- ${d}`)].join("\n"),
        );
        return;
      }

      const discussion = active;
      const snapshot = aggregateCost(discussion.panelists.map((p) => ({ name: p.slot.name, session: p.session })));
      const rows = discussion.slots.map((slot) => {
        const stats = snapshot.perSlot.get(slot.name);
        const state = slotState.get(slot.name) ?? "waiting";
        const tokens = stats === undefined ? "—" : formatTokens(stats.tokens.total);
        const cost = stats === undefined ? "—" : `$${stats.cost.toFixed(4)}`;
        return `| ${slot.name} | ${slot.model} | ${slot.thinking} | ${state} | ${tokens} | ${cost} |`;
      });

      notice(
        pi,
        `pi-discuss: ${discussion.dir.split("/").pop()}`,
        [
          `Topic: ${discussion.meta.topic}`,
          `Rounds run: ${discussion.meta.rounds.length}` +
            (currentRound === undefined ? "" : ` · in flight: round ${currentRound}`) +
            (discussion.pendingSteer === undefined ? "" : " · steering queued"),
          "",
          "| slot | model | thinking | state | tokens | cost |",
          "|---|---|---|---|---|---|",
          ...rows,
          "",
          `Total: ${formatTokens(snapshot.totalTokens)} tokens · $${snapshot.totalCost.toFixed(4)}`,
        ].join("\n"),
      );
    },
  });

  pi.registerCommand("pd-resume", {
    description: "Reopen a past discussion, restoring the per-slot sessions",
    getArgumentCompletions: (prefix) => {
      const cwd = (() => {
        try {
          return lastCtx?.cwd ?? process.cwd();
        } catch {
          return process.cwd();
        }
      })();
      return listDiscussionDirs(cwd)
        .filter((name) => name.startsWith(prefix))
        .map((name) => ({ value: name, label: name }));
    },
    handler: async (args, ctx) => {
      if (booting) {
        refuse(ctx, "pi-discuss: a panel is already booting", "Wait for it to finish.");
        return;
      }
      if (isRoundRunning()) {
        refuse(
          ctx,
          "pi-discuss: a round is running",
          "Resuming would tear the panel down mid-round. Wait for it, or cancel it with `/pd-abort`.",
        );
        return;
      }

      // Set synchronously with the guards above: the first await below yields a
      // microtask, enough for a second queued /pd-resume to slip past the check.
      booting = true;
      try {
        const name = args.trim();
        if (name.length === 0) {
          refuse(ctx, "pi-discuss: usage", "`/pd-resume <dir>` — a directory name under `discussions/`");
          return;
        }

        const dir = name.includes("/") ? resolve(ctx.cwd, name) : join(ctx.cwd, DISCUSSIONS_DIRNAME, name);
        if (!existsSync(dir)) {
          refuse(ctx, "pi-discuss: no such discussion", `\`${dir}\` does not exist.`);
          return;
        }

        let meta: DiscussionMeta;
        try {
          meta = readMeta(dir);
        } catch (err) {
          refuse(ctx, "pi-discuss: cannot read the discussion ledger", err instanceof ArtifactError ? err.message : String(err));
          return;
        }

        const panel = readPanel(ctx);
        if (panel === undefined) return;

        const drift = checkPanelDrift(meta, panel.slots);
        if (drift.length > 0) {
          refuse(
            ctx,
            "pi-discuss: panel.yaml has drifted from this discussion",
            [
              ...drift.map((d) => `- ${d}`),
              "",
              "Resuming would restore a slot's transcript under a different model, producing one record in two models' voices.",
            ].join("\n"),
          );
          return;
        }

        const resolved = await guardedModels(ctx, panel);
        if (resolved === undefined) return;

        // Boot the replacement BEFORE tearing down the incumbent: a failed boot
        // must leave whatever discussion is already open untouched, not destroy it
        // on the way to not opening a new one.
        let panelists: Panelist[];
        try {
          panelists = await bootPanelists({
            panel,
            models: resolved.models,
            runtime: resolved.runtime,
            cwd: ctx.cwd,
            dir,
            repoAccess: meta.repoAccess,
          });
        } catch (err) {
          refuse(ctx, "pi-discuss: could not restore the panel", String(err));
          return;
        }

        // Re-check: the entry guard was several awaits ago, and /pd-debate could
        // have started a round in the meantime. Tearing that down here would
        // orphan a paid-for round mid-flight.
        if (isRoundRunning()) {
          await disposePanelists(panelists);
          refuse(ctx, "pi-discuss: a round started while the panel was restoring", "Try `/pd-resume` again once it finishes.");
          return;
        }
        await closeActive();

        const discussion = newDiscussion({ dir, meta, panel, panelists });
        active = discussion;
        slotState.clear();

        showFooter(ctx, () => footerLines(discussion), () => discussion.running);
        notice(
          pi,
          `pi-discuss: resumed ${name}`,
          [
            `Topic: ${meta.topic}`,
            `Rounds on the record: ${meta.rounds.length}`,
            "",
            ...panel.slots.map((s) => `- **${s.name}** — ${s.model} (thinking: ${s.thinking})`),
          ].join("\n"),
        );
      } finally {
        booting = false;
      }
    },
  });

  pi.registerCommand("pd-close", {
    description: "Close the open discussion without ending the session; it stays resumable",
    handler: async (args, ctx) => {
      void args;
      const discussion = requireActive(ctx, "`/pd-close`");
      if (discussion === undefined) return;
      if (discussion.running) {
        refuse(
          ctx,
          "pi-discuss: a round is running",
          "Closing now would cut it off. Wait for it, or cancel it with `/pd-abort` first.",
        );
        return;
      }

      // Teardown only: every artifact stays on disk and every slot session file is
      // intact, so `/pd-resume` reopens this exact discussion.
      const dir = discussion.dir;
      active = undefined;
      await disposePanelists(discussion.panelists);
      slotState.clear();
      hideFooter(ctx);
      setRoundStatus(ctx, undefined);

      notice(
        pi,
        "pi-discuss: discussion closed",
        [
          `\`${dir}\` is closed and fully on disk.`,
          "",
          `Reopen it with \`/pd-resume ${dir.split("/").pop()}\`, or start a new one with \`/pd <topic>\`.`,
        ].join("\n"),
      );
    },
  });
}
