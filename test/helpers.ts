import type { SlotConfig } from "../src/modules/config.ts";
import type { Panelist, PanelistSession } from "../src/modules/panelists.ts";

export function slot(name: string, overrides: Partial<SlotConfig> = {}): SlotConfig {
  return {
    name,
    model: `prov/${name}-1`,
    provider: "prov",
    modelId: `${name}-1`,
    thinking: "medium",
    color: "accent",
    persona: "",
    ...overrides,
  };
}

export interface FakeSessionOptions {
  reply?: string;
  error?: string;
  /** Never resolve prompt() until abort(), so the round budget or /pd-abort decides. */
  hang?: boolean;
  /**
   * A previous round's answer, already in the transcript before this prompt. The
   * real getLastAssistantText() falls back to it when an aborted turn produced
   * nothing, so it must be distinguishable from text this turn produced.
   */
  priorText?: string;
  /** Text this turn produces before it is aborted — genuine partial output. */
  partial?: string;
  costPerPrompt?: number;
  tokensPerPrompt?: number;
}

export class FakeSession implements PanelistSession {
  readonly prompts: Array<{ text: string; options?: { expandPromptTemplates?: boolean } }> = [];
  /** Ordered teardown log, so abort-before-dispose is observable. */
  readonly calls: string[] = [];
  aborts = 0;
  disposes = 0;
  idleWaits = 0;

  private last: string | undefined;
  private cost = 0;
  private tokens = 0;
  private release: (() => void) | undefined;

  constructor(private readonly opts: FakeSessionOptions = {}) {
    if (opts.priorText !== undefined) this.last = opts.priorText;
  }

  async prompt(text: string, options?: { expandPromptTemplates?: boolean }): Promise<void> {
    this.prompts.push({ text, ...(options === undefined ? {} : { options }) });
    this.cost += this.opts.costPerPrompt ?? 0.01;
    this.tokens += this.opts.tokensPerPrompt ?? 100;
    if (this.opts.partial !== undefined) this.last = this.opts.partial;
    if (this.opts.hang === true) {
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
      return;
    }
    if (this.opts.error !== undefined) throw new Error(this.opts.error);
    this.last = this.opts.reply ?? "";
  }

  getLastAssistantText(): string | undefined {
    return this.last;
  }

  async waitForIdle(): Promise<void> {
    this.idleWaits++;
  }

  async abort(): Promise<void> {
    this.aborts++;
    this.calls.push("abort");
    this.release?.();
    this.release = undefined;
  }

  dispose(): void {
    this.disposes++;
    this.calls.push("dispose");
  }

  getSessionStats(): { cost: number; tokens: { total: number } } {
    return { cost: this.cost, tokens: { total: this.tokens } };
  }
}

export function panelist(name: string, opts: FakeSessionOptions = {}, slotOverrides: Partial<SlotConfig> = {}): Panelist & {
  session: FakeSession;
} {
  return { slot: slot(name, slotOverrides), session: new FakeSession(opts) };
}
