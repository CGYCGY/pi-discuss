import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Kept inside the repo (gitignored) so the copied extension resolves the repo's node_modules. */
export const SCRATCH_ROOT = join(REPO_ROOT, ".smoke");

export interface Scratch {
  root: string;
  /** The extension as pi sees it: `<ext>/src/index.ts` beside a generated `<ext>/panel.yaml`. */
  extEntry: string;
  panelPath: string;
  /** pi's cwd, and therefore where `discussions/` lands. */
  workDir: string;
  sessionDir: string;
}

/**
 * panel.yaml is resolved from the extension's own directory via `import.meta.url`
 * with no cwd override (DESIGN §16), so pinning a scratch panel means copying the
 * extension source next to a generated one. Copying also exercises the real
 * installed layout rather than a symlink pi would resolve back to the repo.
 */
export function createScratch(runId: string): Scratch {
  const root = join(SCRATCH_ROOT, runId);
  const extDir = join(root, "ext");
  const workDir = join(root, "work");
  const sessionDir = join(root, "pi-sessions");
  mkdirSync(workDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(extDir, { recursive: true });
  cpSync(join(REPO_ROOT, "src"), join(extDir, "src"), { recursive: true });
  return { root, extEntry: join(extDir, "src", "index.ts"), panelPath: join(extDir, "panel.yaml"), workDir, sessionDir };
}

export function removeScratch(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

export interface ModelCost {
  input?: number | null;
  output?: number | null;
}

export interface AvailableModel {
  id: string;
  name?: string;
  provider: string;
  cost?: ModelCost | null;
}

export function modelPrice(model: AvailableModel): number {
  return (model.cost?.input ?? 0) + (model.cost?.output ?? 0);
}

/**
 * Cheapest by input+output price. Ties break on the shorter id, which picks the
 * undated `latest` alias over its pinned twin — the two are the same model at the
 * same price, and the alias is what a human would have written.
 */
export function cheapestModel(models: AvailableModel[], provider: string): AvailableModel | undefined {
  const candidates = models.filter((m) => m.provider === provider && typeof m.cost?.input === "number");
  if (candidates.length === 0) return undefined;
  return candidates.sort((a, b) => {
    const priceA = modelPrice(a);
    const priceB = modelPrice(b);
    if (priceA !== priceB) return priceA - priceB;
    if (a.id.length !== b.id.length) return a.id.length - b.id.length;
    return a.id.localeCompare(b.id);
  })[0];
}

export interface PanelSlotSpec {
  name: string;
  model: string;
  thinking: string;
  color: string;
}

export function writePanelYaml(path: string, slots: PanelSlotSpec[], defaults: Record<string, unknown>): string {
  const text = stringifyYaml({ panel: slots, defaults });
  writeFileSync(path, text, "utf8");
  return text;
}

/* ───────────────────────── artifact readers ─────────────────────────
   Parsed here rather than through src/modules/artifacts.ts on purpose: a bug in
   the reader would otherwise cancel out the same bug in the writer. */

export interface MetaSlot {
  name: string;
  outcome: string;
  tokens: number;
  cost: number;
  error?: string;
}

export interface MetaRound {
  round: number;
  steer?: string;
  researchCost?: number;
  slots: MetaSlot[];
}

export interface Meta {
  topic: string;
  research: boolean;
  panel: Array<{ name: string; model: string; thinking: string }>;
  rounds: MetaRound[];
}

export function readMetaYaml(discussionDir: string): Meta {
  const raw = parseYaml(readFileSync(join(discussionDir, "meta.yaml"), "utf8")) as Record<string, unknown>;
  const rounds = (Array.isArray(raw["rounds"]) ? raw["rounds"] : []) as Array<Record<string, unknown>>;
  return {
    topic: String(raw["topic"] ?? ""),
    research: raw["research"] === true,
    panel: (Array.isArray(raw["panel"]) ? raw["panel"] : []).map((p: Record<string, unknown>) => ({
      name: String(p["name"] ?? ""),
      model: String(p["model"] ?? ""),
      thinking: String(p["thinking"] ?? ""),
    })),
    rounds: rounds.map((r) => ({
      round: Number(r["round"] ?? 0),
      ...(typeof r["steer"] === "string" ? { steer: r["steer"] } : {}),
      ...(typeof r["research_cost"] === "number" ? { researchCost: r["research_cost"] } : {}),
      slots: (Array.isArray(r["slots"]) ? r["slots"] : []).map((s: Record<string, unknown>) => ({
        name: String(s["name"] ?? ""),
        outcome: String(s["outcome"] ?? ""),
        tokens: Number(s["tokens"] ?? 0),
        cost: Number(s["cost"] ?? 0),
        ...(typeof s["error"] === "string" ? { error: s["error"] } : {}),
      })),
    })),
  };
}

export function discussionDirs(workDir: string): string[] {
  const root = join(workDir, "discussions");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(root, e.name))
    .sort();
}

export function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
}

/** Parsed JSONL entries of a pi session file, skipping unreadable trailing writes. */
export function readJsonl(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      /* a line still being written is not a failure to read the ones before it */
    }
  }
  return out;
}

export interface Spend {
  model: number;
  research: number;
  total: number;
}

/** meta.yaml is the durable ledger (DESIGN §13), so the bill is summed from it. */
export function totalSpend(workDir: string): Spend {
  let model = 0;
  let research = 0;
  for (const dir of discussionDirs(workDir)) {
    let meta: Meta;
    try {
      meta = readMetaYaml(dir);
    } catch {
      continue;
    }
    for (const round of meta.rounds) {
      research += round.researchCost ?? 0;
      for (const slot of round.slots) model += slot.cost;
    }
  }
  return { model, research, total: model + research };
}
