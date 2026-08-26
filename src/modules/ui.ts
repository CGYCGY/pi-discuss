import type { ExtensionAPI, ExtensionContext, ThemeColor } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Markdown, Text, type TUI } from "@earendil-works/pi-tui";
import { isThemeColor } from "./config.ts";
import type { SlotOutcome } from "./types.ts";

export const PANELIST_ENTRY_TYPE = "pi-discuss.panelist";
export const NOTICE_ENTRY_TYPE = "pi-discuss.notice";
export const FOOTER_KEY = "pi-discuss.footer";
export const STATUS_KEY = "pi-discuss.round";

/** Fast enough to show a slot stalling; only used while a round is in flight. */
const FOOTER_BUSY_TICK_MS = 1000;
/** Between rounds nothing moves, so the widget all but stops. */
const FOOTER_IDLE_TICK_MS = 15_000;
const COLLAPSED_LINES = 14;

export interface PanelistEntryData {
  slot: string;
  color: ThemeColor;
  model: string;
  round: number;
  outcome: SlotOutcome;
  tokens: number;
  cost: number;
  text: string;
}

/**
 * A stale ctx throws on ANY access, including `ctx.hasUI` — `ctx?.hasUI` guards
 * null, not staleness (lifecycle guide, Rule 1). Every out-of-turn ctx touch goes
 * through here or an equivalent try/catch.
 */
export function uiActive(ctx: ExtensionContext | undefined): boolean {
  try {
    return !!ctx?.hasUI;
  } catch {
    return false;
  }
}

function isTui(ctx: ExtensionContext | undefined): boolean {
  try {
    return ctx?.mode === "tui";
  } catch {
    return false;
  }
}

export function notify(ctx: ExtensionContext | undefined, message: string, type?: "info" | "warning" | "error"): void {
  try {
    if (uiActive(ctx)) ctx!.ui.notify(message, type);
  } catch {
    /* stale ctx */
  }
}

export function setRoundStatus(ctx: ExtensionContext | undefined, text: string | undefined): void {
  try {
    if (uiActive(ctx)) ctx!.ui.setStatus(STATUS_KEY, text);
  } catch {
    /* stale ctx */
  }
}

function collapse(text: string): string {
  const lines = text.split("\n");
  if (lines.length <= COLLAPSED_LINES) return text;
  return [...lines.slice(0, COLLAPSED_LINES), "", "_…truncated; expand to read the rest._"].join("\n");
}

/**
 * The appendEntry + registerEntryRenderer path renders the block and persists it
 * in the host session's JSONL *without* entering the moderator's LLM context —
 * the property that makes a five-model panel affordable, since fifteen full
 * answers would otherwise flood the moderator's window before synthesis runs.
 */
export function registerPanelistRenderer(pi: ExtensionAPI): void {
  pi.registerEntryRenderer<PanelistEntryData>(PANELIST_ENTRY_TYPE, (entry, { expanded }, theme) => {
    const data = entry.data;
    if (data === undefined) return undefined;

    // Entry data is replayed from JSONL, where the color is just a string; an
    // unknown token would throw inside theme.fg().
    const color: ThemeColor = isThemeColor(data.color) ? data.color : "text";

    const box = new Box(1, 0);
    const meta = `· ${data.model} · round ${data.round} · ${data.tokens} tok · $${data.cost.toFixed(4)}`;
    const badge = data.outcome === "answered" ? "" : ` ${theme.fg("error", `[${data.outcome}]`)}`;
    box.addChild(new Text(`${theme.fg(color, data.slot)} ${theme.fg("dim", meta)}${badge}`, 0, 0));
    box.addChild(new Markdown(expanded ? data.text : collapse(data.text), 0, 0, getMarkdownTheme()));
    return box;
  });
}

export interface NoticeEntryData {
  title: string;
  body: string;
  tone: "info" | "warning" | "error";
}

const TONE_COLOR: Record<NoticeEntryData["tone"], ThemeColor> = {
  info: "accent",
  warning: "warning",
  error: "error",
};

export function registerNoticeRenderer(pi: ExtensionAPI): void {
  pi.registerEntryRenderer<NoticeEntryData>(NOTICE_ENTRY_TYPE, (entry, _options, theme) => {
    const data = entry.data;
    if (data === undefined) return undefined;
    const box = new Box(1, 0);
    box.addChild(new Text(theme.fg(TONE_COLOR[data.tone] ?? "accent", data.title), 0, 0));
    if (data.body.length > 0) box.addChild(new Markdown(data.body, 0, 0, getMarkdownTheme()));
    return box;
  });
}

/** Extension-authored output that must persist and render but never reach the moderator's context. */
export function notice(pi: ExtensionAPI, title: string, body = "", tone: NoticeEntryData["tone"] = "info"): void {
  try {
    pi.appendEntry<NoticeEntryData>(NOTICE_ENTRY_TYPE, { title, body, tone });
  } catch {
    // appendEntry binds to the runner's session, which a replacement may have
    // already torn down; nothing here is the record, so losing it is fine.
  }
}

/**
 * Owns its own tick so the refresh never touches a captured ctx: the component
 * holds the TUI handle and a pure data getter, and pi disposes it when the widget
 * is cleared or the session is replaced.
 */
class FooterWidget implements Component {
  private readonly text: Text;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(
    private readonly tui: TUI,
    private readonly getLines: () => string[],
    private readonly isBusy: () => boolean,
  ) {
    this.text = new Text(getLines().join("\n"), 0, 0);
    this.arm();
  }

  // A self-rearming timeout rather than a fixed interval: a discussion sits idle
  // between rounds for as long as the user takes to read it, and a 1 Hz repaint
  // through all of that buys nothing.
  private arm(): void {
    if (this.stopped) return;
    let busy = false;
    try {
      busy = this.isBusy();
    } catch {
      /* treat an unreadable state as idle */
    }
    this.timer = setTimeout(() => {
      try {
        this.text.setText(this.getLines().join("\n"));
        this.tui.requestRender();
      } catch {
        /* a wedged stats read must not crash the paint loop */
      }
      this.arm();
    }, busy ? FOOTER_BUSY_TICK_MS : FOOTER_IDLE_TICK_MS);
    this.timer.unref?.();
  }

  render(width: number): string[] {
    return this.text.render(width);
  }

  invalidate(): void {
    this.text.invalidate();
  }

  dispose(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
}

/** §13: the footer is what makes a stalled slot distinguishable from a slow one. */
export function showFooter(
  ctx: ExtensionContext | undefined,
  getLines: () => string[],
  isBusy: () => boolean,
): void {
  if (!isTui(ctx)) return;
  try {
    ctx!.ui.setWidget(FOOTER_KEY, (tui) => new FooterWidget(tui, getLines, isBusy), {
      placement: "belowEditor",
    });
  } catch {
    /* stale ctx */
  }
}

export function hideFooter(ctx: ExtensionContext | undefined): void {
  try {
    if (uiActive(ctx)) ctx!.ui.setWidget(FOOTER_KEY, undefined);
  } catch {
    /* stale ctx */
  }
}
