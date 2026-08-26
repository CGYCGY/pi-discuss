import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { CreateAgentSessionOptions, ThemeColor } from "@earendil-works/pi-coding-agent";

/** pi-coding-agent does not re-export ThinkingLevel; derive it from the option it types. */
export type ThinkingLevel = NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;

export interface SlotConfig {
  name: string;
  /** The configured `provider/id` string, kept verbatim for the meta.yaml panel snapshot. */
  model: string;
  provider: string;
  modelId: string;
  thinking: ThinkingLevel;
  color: ThemeColor;
  persona: string;
}

export interface PanelDefaults {
  rounds: number;
  repoAccess: boolean;
  /** Off by default: it spends money outside the model ledger and needs a key pi may not hold (§20). */
  research: boolean;
  /** Unset makes the cost guard a soft cap; set makes it a hard refusal (§8.5). */
  maxCost?: number;
}

export interface PanelConfig {
  slots: SlotConfig[];
  defaults: PanelDefaults;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export const MIN_SLOTS = 2;
export const MAX_SLOTS = 5;

const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ThinkingLevel[];

/**
 * Mirror of the ThemeColor union, which is closed in the SDK and has no runtime
 * export. A token pi adds later is rejected here until this list catches up —
 * failing closed on an unknown token beats rendering an unstyled label.
 */
const THEME_COLORS = [
  "accent", "border", "borderAccent", "borderMuted", "success", "error", "warning",
  "muted", "dim", "text", "thinkingText", "searchMatchText", "userMessageText",
  "customMessageText", "customMessageLabel", "toolTitle", "toolOutput", "mdHeading",
  "mdLink", "mdLinkUrl", "mdCode", "mdCodeBlock", "mdCodeBlockBorder", "mdQuote",
  "mdQuoteBorder", "mdHr", "mdListBullet", "toolDiffAdded", "toolDiffRemoved",
  "toolDiffContext", "syntaxComment", "syntaxKeyword", "syntaxFunction",
  "syntaxVariable", "syntaxString", "syntaxNumber", "syntaxType", "syntaxOperator",
  "syntaxPunctuation", "thinkingOff", "thinkingMinimal", "thinkingLow",
  "thinkingMedium", "thinkingHigh", "thinkingXhigh", "thinkingMax", "bashMode",
] as const satisfies readonly ThemeColor[];

const THINKING_SET = new Set<string>(THINKING_LEVELS);
const COLOR_SET = new Set<string>(THEME_COLORS);

export function isThemeColor(value: unknown): value is ThemeColor {
  return typeof value === "string" && COLOR_SET.has(value);
}

/** A slot name is a directory-and-file component in the discussion artifact tree. */
const SLOT_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseSlot(raw: unknown, index: number): SlotConfig {
  const where = `panel[${index}]`;
  if (!isRecord(raw)) throw new ConfigError(`${where} must be a mapping`);

  const name = raw["name"];
  if (typeof name !== "string" || !SLOT_NAME_RE.test(name)) {
    throw new ConfigError(
      `${where}.name must be a lowercase slug matching ${SLOT_NAME_RE.source} (got ${JSON.stringify(name)})`,
    );
  }

  const model = raw["model"];
  if (typeof model !== "string" || model.length === 0) {
    throw new ConfigError(`${where}.model must be a "provider/id" string`);
  }
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) {
    throw new ConfigError(`${where}.model must be "provider/id" (got ${JSON.stringify(model)})`);
  }
  const provider = model.slice(0, slash);
  const modelId = model.slice(slash + 1);

  const rawThinking = raw["thinking"] ?? "medium";
  if (typeof rawThinking !== "string" || !THINKING_SET.has(rawThinking)) {
    throw new ConfigError(
      `${where}.thinking must be one of ${THINKING_LEVELS.join("|")} (got ${JSON.stringify(rawThinking)})`,
    );
  }

  const rawColor = raw["color"];
  if (typeof rawColor !== "string" || !COLOR_SET.has(rawColor)) {
    throw new ConfigError(
      `${where}.color must be a named ThemeColor token, not a hex value (got ${JSON.stringify(rawColor)})`,
    );
  }

  const rawPersona = raw["persona"] ?? "";
  if (typeof rawPersona !== "string") {
    throw new ConfigError(`${where}.persona must be a string`);
  }

  return {
    name,
    model,
    provider,
    modelId,
    thinking: rawThinking as ThinkingLevel,
    color: rawColor as ThemeColor,
    persona: rawPersona.trim(),
  };
}

function parseDefaults(raw: unknown): PanelDefaults {
  if (raw === undefined || raw === null) return { rounds: 2, repoAccess: true, research: false };
  if (!isRecord(raw)) throw new ConfigError("defaults must be a mapping");

  const rawRounds = raw["rounds"] ?? 2;
  if (typeof rawRounds !== "number" || !Number.isInteger(rawRounds) || rawRounds < 1) {
    throw new ConfigError(`defaults.rounds must be a positive integer (got ${JSON.stringify(rawRounds)})`);
  }

  const rawRepo = raw["repo_access"] ?? true;
  if (typeof rawRepo !== "boolean") {
    throw new ConfigError(`defaults.repo_access must be a boolean (got ${JSON.stringify(rawRepo)})`);
  }

  const rawResearch = raw["research"] ?? false;
  if (typeof rawResearch !== "boolean") {
    throw new ConfigError(`defaults.research must be a boolean (got ${JSON.stringify(rawResearch)})`);
  }

  const rawMax = raw["max_cost"];
  let maxCost: number | undefined;
  if (rawMax !== undefined && rawMax !== null) {
    if (typeof rawMax !== "number" || !(rawMax > 0)) {
      throw new ConfigError(`defaults.max_cost must be a positive number when set (got ${JSON.stringify(rawMax)})`);
    }
    maxCost = rawMax;
  }

  return {
    rounds: rawRounds,
    repoAccess: rawRepo,
    research: rawResearch,
    ...(maxCost === undefined ? {} : { maxCost }),
  };
}

export function parsePanelConfig(raw: unknown): PanelConfig {
  if (!isRecord(raw)) throw new ConfigError("panel.yaml must be a mapping with a `panel:` key");

  const rawPanel = raw["panel"];
  if (!Array.isArray(rawPanel)) throw new ConfigError("panel.yaml must have a `panel:` list");
  if (rawPanel.length < MIN_SLOTS || rawPanel.length > MAX_SLOTS) {
    throw new ConfigError(
      `panel must hold ${MIN_SLOTS}-${MAX_SLOTS} slots (got ${rawPanel.length}); a panel of one is not a panel`,
    );
  }

  const slots = rawPanel.map(parseSlot);
  const seen = new Set<string>();
  for (const slot of slots) {
    if (seen.has(slot.name)) {
      throw new ConfigError(
        `duplicate slot name "${slot.name}"; names are artifact filenames and must be unique`,
      );
    }
    seen.add(slot.name);
  }

  return { slots, defaults: parseDefaults(raw["defaults"]) };
}

export function loadPanelConfig(path: string): PanelConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new ConfigError(
      `cannot read panel config at ${path}: ${(err as Error).message}\n` +
        "panel.yaml is personal and untracked — copy panel.yaml.example next to it and edit the slots.",
    );
  }
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new ConfigError(`panel.yaml is not valid YAML: ${(err as Error).message}`);
  }
  return parsePanelConfig(raw);
}

/**
 * Structural subset of ModelRuntime, so the startup guard is testable without a
 * runtime (and without auth).
 */
export interface ModelResolver<M = unknown> {
  getModel(providerId: string, modelId: string): M | undefined;
  hasConfiguredAuth(providerId: string): boolean;
}

export interface PanelReadiness<M> {
  ok: boolean;
  problems: string[];
  models: Map<string, M>;
}

/**
 * §8.1: resolve every slot's model and auth up front. Checked before a discussion
 * opens so a five-slot round cannot burn four models' tokens and then die on the
 * fifth's missing key.
 */
export function checkPanelReadiness<M>(slots: SlotConfig[], runtime: ModelResolver<M>): PanelReadiness<M> {
  const problems: string[] = [];
  const models = new Map<string, M>();

  for (const slot of slots) {
    const model = runtime.getModel(slot.provider, slot.modelId);
    if (model === undefined) {
      problems.push(`slot "${slot.name}": model ${slot.model} is not in the model registry`);
      continue;
    }
    if (!runtime.hasConfiguredAuth(slot.provider)) {
      problems.push(`slot "${slot.name}": provider "${slot.provider}" has no configured auth`);
      continue;
    }
    models.set(slot.name, model);
  }

  return { ok: problems.length === 0, problems, models };
}
