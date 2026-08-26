import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  createAgentSession,
  type CreateAgentSessionOptions,
  DefaultResourceLoader,
  getAgentDir,
  type ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { SlotConfig } from "./config.ts";
import type { SlotStats } from "./cost.ts";
import { buildPanelistSystem } from "./prompts/panelist-system.ts";
import { buildPersonaAppend } from "./prompts/persona.ts";
import { createResearchTools } from "./research-tools.ts";
import { FETCH_TOOL_NAME, type ResearchBackend, type ResearchLedger, SEARCH_TOOL_NAME } from "./research.ts";

export type PanelistModel = NonNullable<CreateAgentSessionOptions["model"]>;

/**
 * The slice of AgentSession the round loop drives. Declared structurally so tests
 * can supply a fake without a model runtime, a network, or auth (§15).
 */
export interface PanelistSession {
  prompt(text: string, options?: { expandPromptTemplates?: boolean }): Promise<void>;
  getLastAssistantText(): string | undefined;
  waitForIdle(): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  getSessionStats(): SlotStats;
}

export interface Panelist {
  slot: SlotConfig;
  session: PanelistSession;
}

/**
 * §5: read-only is enforced here, not in the prompt. The allowlist mechanically
 * excludes write/edit/bash/powershell.
 */
export const PANELIST_TOOLS = ["read", "grep", "find", "ls"] as const;

/**
 * Passing `tools` makes it the whole allowlist, and custom tools are *not*
 * auto-included by one — registering the research tools without naming them here
 * would hand every panelist a tool it is then forbidden to call.
 */
export const RESEARCH_TOOLS = [SEARCH_TOOL_NAME, FETCH_TOOL_NAME] as const;

export interface CreatePanelistOptions {
  slot: SlotConfig;
  model: PanelistModel;
  modelRuntime: ModelRuntime;
  cwd: string;
  /** Absolute path to `<discussion>/sessions/<slot>.jsonl`. */
  sessionFile: string;
  repoAccess: boolean;
  /** Omitted when the discussion runs without web research (§20). */
  research?: { backend: ResearchBackend; ledger: ResearchLedger };
  agentDir?: string;
}

/**
 * One `DefaultResourceLoader` per slot, because each carries a different persona.
 *
 * `noExtensions: true` is load-bearing: a default loader discovers
 * `.pi/extensions/` and would recursively re-instantiate pi-discuss inside every
 * panelist — a panel that convenes a panel. Precedent: createWarmJudge in
 * pi-4b-tester/hub/verdict.ts.
 *
 * `SessionManager.open()` rather than `.create()`: create() always names the file
 * `timestamp_uuid` and cannot be told to name it by slot, while open() accepts a
 * path that does not exist yet — which makes this one code path for both a fresh
 * discussion and a resume (§10).
 */
export async function createPanelist(opts: CreatePanelistOptions): Promise<Panelist> {
  const { slot, cwd, sessionFile, repoAccess, research } = opts;
  const agentDir = opts.agentDir ?? getAgentDir();
  const persona = buildPersonaAppend(slot.persona);
  const researchTools =
    research === undefined
      ? []
      : createResearchTools({ slot: slot.name, backend: research.backend, ledger: research.ledger });

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    systemPrompt: buildPanelistSystem({ research: research !== undefined }),
    ...(persona === undefined ? {} : { appendSystemPrompt: [persona] }),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: !repoAccess,
  });
  await resourceLoader.reload();

  mkdirSync(dirname(sessionFile), { recursive: true });

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: opts.model,
    thinkingLevel: slot.thinking,
    modelRuntime: opts.modelRuntime,
    resourceLoader,
    // Third argument is the cwd override: without it a newly created session
    // header records process.cwd(), which is the pi process's directory rather
    // than the discussion's.
    sessionManager: SessionManager.open(sessionFile, undefined, cwd),
    tools: [...PANELIST_TOOLS, ...(researchTools.length > 0 ? RESEARCH_TOOLS : [])],
    customTools: researchTools,
  });

  // createAgentSession reports modelFallbackMessage only when it had to pick a
  // model itself, and we always pass one explicitly. Resolvability is guaranteed
  // ahead of this call by the startup readiness guard, and a slot silently
  // pointing at a different model is caught by the drift guard (§8.1, §8.4).
  return { slot, session };
}

/**
 * dispose() removes listeners but does not abort an in-flight turn, so abort comes
 * first, always (§12). Both halves are best-effort: teardown runs on the shutdown
 * path, where a throw has nowhere to go.
 */
export async function disposePanelists(panelists: Panelist[]): Promise<void> {
  await Promise.allSettled(panelists.map((p) => p.session.abort()));
  for (const p of panelists) {
    try {
      p.session.dispose();
    } catch {
      /* best-effort */
    }
  }
}
