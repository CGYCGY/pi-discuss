import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { DiscussionMeta, RoundRecord, SlotAnswer } from "./types.ts";

export class ArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactError";
  }
}

export const DISCUSSIONS_DIRNAME = "discussions";

export function slugify(topic: string): string {
  const slug = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  if (slug.length > 0) return slug;
  // An all-non-ASCII topic reduces to nothing, and a fixed fallback would make
  // every such topic on a given day collide on the same directory (§8.3), which
  // reads as a refusal to open a second discussion rather than as a naming
  // problem. A content hash keeps distinct topics distinct.
  return `discussion-${createHash("sha256").update(topic).digest("hex").slice(0, 8)}`;
}

export function discussionDirName(at: Date, slug: string): string {
  const y = at.getFullYear();
  const m = String(at.getMonth() + 1).padStart(2, "0");
  const d = String(at.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}-${slug}`;
}

/**
 * §8.3: refuse an existing directory rather than appending into it. Two mkdirs
 * instead of one recursive mkdir so the final component fails with EEXIST
 * atomically — a `discussions/` that already exists is fine, a
 * `discussions/<date>-<slug>/` that does is not.
 */
export function createDiscussionDir(cwd: string, name: string): string {
  const root = join(cwd, DISCUSSIONS_DIRNAME);
  mkdirSync(root, { recursive: true });
  const dir = join(root, name);
  try {
    mkdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ArtifactError(
        `discussion directory already exists: ${dir}\n` +
          "Refusing to write a second discussion into it — rename the topic or move the old directory aside.",
      );
    }
    throw err;
  }
  mkdirSync(join(dir, "sessions"), { recursive: true });
  return dir;
}

export function sessionPath(dir: string, slot: string): string {
  return join(dir, "sessions", `${slot}.jsonl`);
}

export function listDiscussionDirs(cwd: string): string[] {
  const root = join(cwd, DISCUSSIONS_DIRNAME);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .reverse();
}

export function writeTopic(dir: string, topic: string, at: Date): void {
  const body = ["# Topic", "", `_opened ${at.toISOString()}_`, "", topic, ""].join("\n");
  writeFileSync(join(dir, "topic.md"), body, "utf8");
}

/** Steering is part of the record: the topic file shows what each round was told. */
export function appendSteer(dir: string, text: string, round: number, at: Date): void {
  const path = join(dir, "topic.md");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const block = ["", `## Steering before round ${round}`, "", `_${at.toISOString()}_`, "", text, ""].join("\n");
  writeFileSync(path, existing + block, "utf8");
}

export function writeRoundAnswer(
  dir: string,
  round: number,
  answer: SlotAnswer,
  modelLabel: string,
): string {
  const roundDir = join(dir, `round-${round}`);
  mkdirSync(roundDir, { recursive: true });
  // YAML front matter rather than a prose header: the reader has to find where
  // the model's own text starts, and an answer may itself open with a heading or
  // a bullet list.
  const front = stringifyYaml({
    slot: answer.slot,
    round,
    model: modelLabel,
    outcome: answer.outcome,
    tokens: answer.tokens,
    cost: answer.cost,
    ...(answer.error === undefined ? {} : { error: answer.error }),
  }).trimEnd();
  const path = join(roundDir, `${answer.slot}.md`);
  const body = ["---", front, "---", "", `# ${answer.slot} — round ${round}`, "", answer.text, ""].join("\n");
  writeFileSync(path, body, "utf8");
  return path;
}

export function writeMeta(dir: string, meta: DiscussionMeta): void {
  const doc = {
    topic: meta.topic,
    created: meta.createdAt,
    repo_access: meta.repoAccess,
    research: meta.research,
    panel: meta.panel.map((s) => ({ name: s.name, model: s.model, thinking: s.thinking })),
    rounds: meta.rounds.map((r) => ({
      round: r.round,
      started: r.startedAt,
      ...(r.steer === undefined ? {} : { steer: r.steer }),
      ...(r.researchCost === undefined ? {} : { research_cost: r.researchCost }),
      slots: r.answers.map((a) => ({
        name: a.slot,
        outcome: a.outcome,
        tokens: a.tokens,
        cost: a.cost,
        ...(a.error === undefined ? {} : { error: a.error }),
      })),
    })),
  };
  // Write-then-rename: meta.yaml is rewritten after every round, and a crash
  // partway through a bare overwrite would leave an unparseable ledger, which
  // makes the discussion permanently unresumable (§8.4 reads this file first).
  const path = join(dir, "meta.yaml");
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, stringifyYaml(doc), "utf8");
  renameSync(tmp, path);
}

function asRecord(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new ArtifactError(`meta.yaml: ${what} must be a mapping`);
  }
  return v as Record<string, unknown>;
}

export function readMeta(dir: string): DiscussionMeta {
  const path = join(dir, "meta.yaml");
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, "utf8"));
  } catch (err) {
    throw new ArtifactError(`cannot read ${path}: ${(err as Error).message}`);
  }
  const doc = asRecord(raw, "root");

  const panelRaw = doc["panel"];
  if (!Array.isArray(panelRaw)) throw new ArtifactError("meta.yaml: missing `panel` snapshot");
  const panel = panelRaw.map((entry, i) => {
    const s = asRecord(entry, `panel[${i}]`);
    return {
      name: String(s["name"] ?? ""),
      model: String(s["model"] ?? ""),
      thinking: String(s["thinking"] ?? "medium") as DiscussionMeta["panel"][number]["thinking"],
    };
  });

  const roundsRaw = Array.isArray(doc["rounds"]) ? doc["rounds"] : [];
  const rounds: RoundRecord[] = roundsRaw.map((entry, i) => {
    const r = asRecord(entry, `rounds[${i}]`);
    const slotsRaw = Array.isArray(r["slots"]) ? r["slots"] : [];
    const steer = r["steer"];
    const researchCost = r["research_cost"];
    return {
      round: Number(r["round"] ?? i),
      startedAt: String(r["started"] ?? ""),
      ...(typeof steer === "string" ? { steer } : {}),
      ...(typeof researchCost === "number" ? { researchCost } : {}),
      answers: slotsRaw.map((slotEntry, j) => {
        const a = asRecord(slotEntry, `rounds[${i}].slots[${j}]`);
        const error = a["error"];
        return {
          slot: String(a["name"] ?? ""),
          outcome: String(a["outcome"] ?? "errored") as SlotAnswer["outcome"],
          text: "",
          ...(typeof error === "string" ? { error } : {}),
          tokens: Number(a["tokens"] ?? 0),
          cost: Number(a["cost"] ?? 0),
        };
      }),
    };
  });

  return {
    topic: String(doc["topic"] ?? ""),
    createdAt: String(doc["created"] ?? ""),
    repoAccess: doc["repo_access"] !== false,
    // Absent in a pre-research meta.yaml, where the discussion by definition had none.
    research: doc["research"] === true,
    panel,
    rounds,
  };
}

/**
 * The ledger records outcomes, not prose; round answer text lives in the
 * round-k/*.md files. Resume reads it back from there so synthesis after a
 * restart sees the same material a same-session synthesis would.
 */
export function readRoundAnswerText(dir: string, round: number, slot: string): string {
  const path = join(dir, `round-${round}`, `${slot}.md`);
  if (!existsSync(path)) return "";
  const body = readFileSync(path, "utf8");
  const close = body.startsWith("---\n") ? body.indexOf("\n---\n", 4) : -1;
  const rest = close < 0 ? body : body.slice(close + "\n---\n".length);
  return rest.replace(/^\s*#[^\n]*\n/, "").trim();
}

export function writeSynthesis(dir: string, text: string, at: Date): void {
  const body = ["# Synthesis", "", `_${at.toISOString()}_`, "", text, ""].join("\n");
  writeFileSync(join(dir, "synthesis.md"), body, "utf8");
}
