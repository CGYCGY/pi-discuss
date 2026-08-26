import { describe, expect, test } from "bun:test";
import { parse as parseYaml } from "yaml";
import {
  checkPanelReadiness,
  ConfigError,
  loadPanelConfig,
  type ModelResolver,
  parsePanelConfig,
} from "../src/modules/config.ts";
import { slot } from "./helpers.ts";

function panelYaml(slots: string, defaults = ""): unknown {
  return parseYaml(`panel:\n${slots}${defaults === "" ? "" : `\ndefaults:\n${defaults}`}`);
}

const TWO_SLOTS = [
  "  - name: claude",
  "    model: anthropic/claude-fable-5",
  "    thinking: high",
  "    color: accent",
  "  - name: gpt",
  "    model: openai/gpt-5.2",
  "    color: success",
].join("\n");

describe("parsePanelConfig", () => {
  test("accepts a minimal two-slot panel and applies defaults", () => {
    const config = parsePanelConfig(panelYaml(TWO_SLOTS));
    expect(config.slots).toHaveLength(2);
    expect(config.slots[0]).toMatchObject({
      name: "claude",
      model: "anthropic/claude-fable-5",
      provider: "anthropic",
      modelId: "claude-fable-5",
      thinking: "high",
      color: "accent",
      persona: "",
    });
    expect(config.slots[1]!.thinking).toBe("medium");
    expect(config.defaults).toEqual({ rounds: 2, repoAccess: true });
  });

  test("refuses a panel of one", () => {
    const one = ["  - name: claude", "    model: anthropic/claude-fable-5", "    color: accent"].join("\n");
    expect(() => parsePanelConfig(panelYaml(one))).toThrow(ConfigError);
    expect(() => parsePanelConfig(panelYaml(one))).toThrow(/2-5 slots/);
  });

  test("refuses a panel of six", () => {
    const six = Array.from({ length: 6 }, (_, i) =>
      [`  - name: m${i}`, `    model: prov/m${i}`, "    color: accent"].join("\n"),
    ).join("\n");
    expect(() => parsePanelConfig(panelYaml(six))).toThrow(/2-5 slots/);
  });

  test("refuses duplicate slot names, which are artifact filenames", () => {
    const dup = [
      "  - name: claude",
      "    model: anthropic/a",
      "    color: accent",
      "  - name: claude",
      "    model: openai/b",
      "    color: success",
    ].join("\n");
    expect(() => parsePanelConfig(panelYaml(dup))).toThrow(/duplicate slot name "claude"/);
  });

  test("refuses a hex color, which does not typecheck against ThemeColor", () => {
    const hex = TWO_SLOTS.replace("color: accent", 'color: "#ff8800"');
    expect(() => parsePanelConfig(panelYaml(hex))).toThrow(/named ThemeColor token, not a hex value/);
  });

  test("refuses an unknown thinking level", () => {
    const bad = TWO_SLOTS.replace("thinking: high", "thinking: extreme");
    expect(() => parsePanelConfig(panelYaml(bad))).toThrow(/thinking must be one of/);
  });

  test("refuses a model without a provider prefix", () => {
    const bad = TWO_SLOTS.replace("model: openai/gpt-5.2", "model: gpt-5.2");
    expect(() => parsePanelConfig(panelYaml(bad))).toThrow(/must be "provider\/id"/);
  });

  test("refuses a slot name that is not a filename-safe slug", () => {
    const bad = TWO_SLOTS.replace("name: gpt", 'name: "GPT 5"');
    expect(() => parsePanelConfig(panelYaml(bad))).toThrow(/lowercase slug/);
  });

  test("reads defaults, including an explicit max_cost", () => {
    const config = parsePanelConfig(
      panelYaml(TWO_SLOTS, ["  rounds: 3", "  repo_access: false", "  max_cost: 2.5"].join("\n")),
    );
    expect(config.defaults).toEqual({ rounds: 3, repoAccess: false, maxCost: 2.5 });
  });

  test("leaves max_cost unset when the key is present but empty", () => {
    const config = parsePanelConfig(panelYaml(TWO_SLOTS, "  max_cost:"));
    expect(config.defaults.maxCost).toBeUndefined();
  });

  test("refuses a non-positive max_cost", () => {
    expect(() => parsePanelConfig(panelYaml(TWO_SLOTS, "  max_cost: 0"))).toThrow(/max_cost must be a positive number/);
  });

  test("the shipped panel.yaml parses", () => {
    const config = loadPanelConfig(new URL("../panel.yaml", import.meta.url).pathname);
    expect(config.slots.map((s) => s.name)).toEqual(["claude", "gpt", "deepseek"]);
    expect(config.defaults.maxCost).toBeUndefined();
  });
});

describe("checkPanelReadiness", () => {
  const slots = [slot("claude", { provider: "anthropic" }), slot("gpt", { provider: "openai" })];

  function resolver(overrides: Partial<ModelResolver<string>> = {}): ModelResolver<string> {
    return {
      getModel: (p, id) => `${p}/${id}`,
      hasConfiguredAuth: () => true,
      ...overrides,
    };
  }

  test("passes when every model resolves and every provider has auth", () => {
    const readiness = checkPanelReadiness(slots, resolver());
    expect(readiness.ok).toBe(true);
    expect(readiness.problems).toEqual([]);
    expect([...readiness.models.keys()]).toEqual(["claude", "gpt"]);
  });

  test("refuses before any tokens are spent when one model is unknown", () => {
    const readiness = checkPanelReadiness(
      slots,
      resolver({ getModel: (p, id) => (p === "openai" ? undefined : `${p}/${id}`) }),
    );
    expect(readiness.ok).toBe(false);
    expect(readiness.problems).toEqual(['slot "gpt": model prov/gpt-1 is not in the model registry']);
    expect(readiness.models.has("gpt")).toBe(false);
  });

  test("refuses when a provider has no configured auth", () => {
    const readiness = checkPanelReadiness(slots, resolver({ hasConfiguredAuth: (p) => p !== "openai" }));
    expect(readiness.ok).toBe(false);
    expect(readiness.problems).toEqual(['slot "gpt": provider "openai" has no configured auth']);
  });

  test("reports every failing slot, not just the first", () => {
    const readiness = checkPanelReadiness(slots, resolver({ hasConfiguredAuth: () => false }));
    expect(readiness.problems).toHaveLength(2);
  });
});
