import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createResearchTools } from "../src/modules/research-tools.ts";
import {
  clampMaxCharacters,
  clampNumResults,
  createExaBackend,
  DEFAULT_MAX_CHARACTERS,
  DEFAULT_NUM_RESULTS,
  EXA_ENV_VAR,
  formatHits,
  MAX_CHARACTERS_CEILING,
  MAX_FETCH_URLS,
  MAX_NUM_RESULTS,
  type ResearchBackend,
  ResearchError,
  ResearchLedger,
  resolveExaKey,
} from "../src/modules/research.ts";

let dir: string;
let authPath: string;
const savedEnv = { ...process.env };

function writeAuth(entries: Record<string, unknown>): void {
  writeFileSync(authPath, JSON.stringify(entries), "utf8");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-discuss-research-"));
  authPath = join(dir, "auth.json");
  delete process.env[EXA_ENV_VAR];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env = { ...savedEnv };
});

describe("resolveExaKey (§5: the key lives in auth.json, never in the repo)", () => {
  test("reads a literal stored key", () => {
    writeAuth({ exa: { type: "api_key", key: "literal-key" } });
    expect(resolveExaKey(authPath)).toBe("literal-key");
  });

  test("the environment variable wins over the stored key", () => {
    writeAuth({ exa: { type: "api_key", key: "stored" } });
    process.env[EXA_ENV_VAR] = "from-env";
    expect(resolveExaKey(authPath)).toBe("from-env");
  });

  test("a stored value naming an env var resolves through it", () => {
    writeAuth({ exa: { type: "api_key", key: "MY_EXA_HOME" } });
    process.env["MY_EXA_HOME"] = "indirect-key";
    expect(resolveExaKey(authPath)).toBe("indirect-key");
  });

  test("a !command ref reads as absent rather than as a literal key", () => {
    writeAuth({ exa: { type: "api_key", key: "!op read op://vault/exa" } });
    expect(resolveExaKey(authPath)).toBeUndefined();
  });

  test("an oauth entry is not an api key", () => {
    writeAuth({ exa: { type: "oauth", access: "a", refresh: "b", expires: 1 } });
    expect(resolveExaKey(authPath)).toBeUndefined();
  });

  test("no entry, an empty key, and an unreadable file are all simply absent", () => {
    writeAuth({ anthropic: { type: "api_key", key: "other" } });
    expect(resolveExaKey(authPath)).toBeUndefined();
    writeAuth({ exa: { type: "api_key" } });
    expect(resolveExaKey(authPath)).toBeUndefined();
    expect(resolveExaKey(join(dir, "does-not-exist.json"))).toBeUndefined();
  });
});

describe("clamping (§5: a panelist cannot ask for a context-burying page count)", () => {
  test("num_results falls back and clamps to both ends", () => {
    expect(clampNumResults(undefined)).toBe(DEFAULT_NUM_RESULTS);
    expect(clampNumResults(Number.NaN)).toBe(DEFAULT_NUM_RESULTS);
    expect(clampNumResults(0)).toBe(1);
    expect(clampNumResults(999)).toBe(MAX_NUM_RESULTS);
    expect(clampNumResults(3.7)).toBe(3);
  });

  test("max_characters stays inside Exa's own ceiling", () => {
    expect(clampMaxCharacters(undefined)).toBe(DEFAULT_MAX_CHARACTERS);
    expect(clampMaxCharacters(50)).toBe(200);
    expect(clampMaxCharacters(99_999)).toBe(MAX_CHARACTERS_CEILING);
  });
});

describe("formatHits", () => {
  test("numbers results and carries url, date, and text", () => {
    const text = formatHits("Results:", [
      { title: "T", url: "https://a", publishedDate: "2026-01-01", text: "BODY" },
    ]);
    expect(text).toContain("[1] T");
    expect(text).toContain("URL: https://a");
    expect(text).toContain("Published: 2026-01-01");
    expect(text).toContain("BODY");
  });

  test("an empty result set says so rather than returning a bare header", () => {
    expect(formatHits("Results:", [])).toContain("No results.");
  });

  test("an unreachable page is labelled, not omitted", () => {
    expect(formatHits("Fetched:", [{ title: "Not retrieved", url: "https://x", error: "HTTP 404" }])).toContain(
      "Unavailable: HTTP 404",
    );
  });
});

describe("createExaBackend (§15: the HTTP seam, exercised without a network)", () => {
  function stubFetch(body: unknown, init: { status?: number; text?: string } = {}) {
    const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
    const impl = (async (url: string, opts: any) => {
      calls.push({ url, body: JSON.parse(opts.body), headers: opts.headers });
      const status = init.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => init.text ?? "",
      } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;
    return { impl, calls };
  }

  test("search sends the query with inline contents and reports Exa's own cost", async () => {
    writeAuth({ exa: { type: "api_key", key: "k" } });
    const { impl, calls } = stubFetch({
      results: [{ title: "T", url: "https://a", publishedDate: "2026-02-02", text: "BODY" }],
      costDollars: { total: 0.007 },
    });
    const backend = createExaBackend({ fetchImpl: impl, authPath, baseUrl: "https://exa.test" });

    const outcome = await backend.search({ query: "q", numResults: 3, maxCharacters: 900 });

    expect(calls[0]!.url).toBe("https://exa.test/search");
    expect(calls[0]!.headers["x-api-key"]).toBe("k");
    expect(calls[0]!.body).toEqual({ query: "q", numResults: 3, contents: { text: { maxCharacters: 900 } } });
    expect(outcome.costUsd).toBeCloseTo(0.007, 6);
    expect(outcome.hits).toEqual([
      { title: "T", url: "https://a", publishedDate: "2026-02-02", text: "BODY" },
    ]);
  });

  test("a result without a url is dropped and a missing title is named", async () => {
    writeAuth({ exa: { type: "api_key", key: "k" } });
    const { impl } = stubFetch({ results: [{ title: "no url" }, { url: "https://b" }] });
    const backend = createExaBackend({ fetchImpl: impl, authPath });

    const outcome = await backend.search({ query: "q", numResults: 5, maxCharacters: 500 });
    expect(outcome.hits).toEqual([{ title: "Untitled", url: "https://b" }]);
    // A response with no costDollars is free, not unknown.
    expect(outcome.costUsd).toBe(0);
  });

  test("fetch reports a per-URL failure from statuses instead of silently returning fewer pages", async () => {
    writeAuth({ exa: { type: "api_key", key: "k" } });
    const { impl, calls } = stubFetch({
      results: [{ title: "Good", url: "https://good", text: "OK" }],
      statuses: [
        { id: "https://good", status: "success" },
        { id: "https://bad", status: "error", error: { tag: "CRAWL_NOT_FOUND", httpStatusCode: 404 } },
      ],
      costDollars: { total: 0.002 },
    });
    const backend = createExaBackend({ fetchImpl: impl, authPath });

    const outcome = await backend.fetch({ urls: ["https://good", "https://bad"], maxCharacters: 400 });

    expect(calls[0]!.body).toEqual({ urls: ["https://good", "https://bad"], text: { maxCharacters: 400 } });
    expect(outcome.hits).toHaveLength(2);
    expect(outcome.hits[1]).toEqual({
      title: "Not retrieved",
      url: "https://bad",
      error: "CRAWL_NOT_FOUND, HTTP 404",
    });
  });

  test("a URL absent from both results and statuses is still reported", async () => {
    writeAuth({ exa: { type: "api_key", key: "k" } });
    const { impl } = stubFetch({ results: [] });
    const backend = createExaBackend({ fetchImpl: impl, authPath });

    const outcome = await backend.fetch({ urls: ["https://ghost"], maxCharacters: 400 });
    expect(outcome.hits).toEqual([
      { title: "Not retrieved", url: "https://ghost", error: "no result returned" },
    ]);
  });

  test("a missing key fails before the request is made", async () => {
    writeAuth({});
    let called = false;
    const impl = (async () => {
      called = true;
      return {} as Response;
    }) as unknown as typeof globalThis.fetch;
    const backend = createExaBackend({ fetchImpl: impl, authPath });

    await expect(backend.search({ query: "q", numResults: 1, maxCharacters: 200 })).rejects.toThrow(ResearchError);
    expect(called).toBe(false);
  });

  test("an HTTP error carries the status and a bounded slice of the body", async () => {
    writeAuth({ exa: { type: "api_key", key: "k" } });
    const { impl } = stubFetch({}, { status: 401, text: "unauthorized" });
    const backend = createExaBackend({ fetchImpl: impl, authPath });

    await expect(backend.search({ query: "q", numResults: 1, maxCharacters: 200 })).rejects.toThrow(
      /Exa returned 401: unauthorized/,
    );
  });

  test("unreadable JSON is a research error, not a raw parse throw", async () => {
    writeAuth({ exa: { type: "api_key", key: "k" } });
    const impl = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("Unexpected token");
        },
      }) as unknown as Response) as unknown as typeof globalThis.fetch;
    const backend = createExaBackend({ fetchImpl: impl, authPath });

    await expect(backend.search({ query: "q", numResults: 1, maxCharacters: 200 })).rejects.toThrow(
      /unreadable JSON/,
    );
  });

  test("a caller abort propagates rather than being reported as a search failure (§12)", async () => {
    writeAuth({ exa: { type: "api_key", key: "k" } });
    const controller = new AbortController();
    const impl = (async () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    }) as unknown as typeof globalThis.fetch;
    const backend = createExaBackend({ fetchImpl: impl, authPath });

    await expect(
      backend.search({ query: "q", numResults: 1, maxCharacters: 200 }, controller.signal),
    ).rejects.toThrow(/aborted/);
  });
});

describe("ResearchLedger (§8.5: search spend the model ledger cannot see)", () => {
  test("accumulates calls and cost per slot", () => {
    const ledger = new ResearchLedger();
    ledger.record("claude", 0.01);
    ledger.record("claude", 0.02);
    ledger.record("gpt", 0.005);

    expect(ledger.forSlot("claude")).toEqual({ calls: 2, costUsd: 0.03 });
    expect(ledger.forSlot("nobody")).toEqual({ calls: 0, costUsd: 0 });
    expect(ledger.total().calls).toBe(3);
    expect(ledger.total().costUsd).toBeCloseTo(0.035, 6);
  });

  test("carried spend counts toward the total so a resume cannot reset the cap", () => {
    const ledger = new ResearchLedger();
    ledger.carry(0.4);
    ledger.record("claude", 0.1);
    expect(ledger.total().costUsd).toBeCloseTo(0.5, 6);
    // Carried spend belongs to no slot: it came from rounds this process never ran.
    expect(ledger.forSlot("claude")).toEqual({ calls: 1, costUsd: 0.1 });
  });
});

describe("research tools (§7: a dead tool costs a source, not the turn)", () => {
  const ctx = undefined as never;

  function tools(backend: Partial<ResearchBackend>, ledger = new ResearchLedger()) {
    const full: ResearchBackend = {
      search: async () => ({ hits: [], costUsd: 0 }),
      fetch: async () => ({ hits: [], costUsd: 0 }),
      ...backend,
    };
    const [search, fetchUrl] = createResearchTools({ slot: "claude", backend: full, ledger });
    return { search: search!, fetchUrl: fetchUrl!, ledger };
  }

  test("a search records its cost against the calling slot", async () => {
    const { search, ledger } = tools({
      search: async () => ({ hits: [{ title: "T", url: "https://a", text: "BODY" }], costUsd: 0.007 }),
    });

    const result = await search.execute("id", { query: "  q  " }, undefined, undefined, ctx);

    expect((result.content[0] as { text: string }).text).toContain("BODY");
    expect(ledger.forSlot("claude")).toEqual({ calls: 1, costUsd: 0.007 });
  });

  test("clamps are applied before the backend sees the request", async () => {
    let seen: unknown;
    const { search } = tools({
      search: async (req) => {
        seen = req;
        return { hits: [], costUsd: 0 };
      },
    });

    await search.execute("id", { query: "q", num_results: 500, max_characters: 1 }, undefined, undefined, ctx);
    expect(seen).toEqual({ query: "q", numResults: MAX_NUM_RESULTS, maxCharacters: 200 });
  });

  test("an empty query is refused without spending", async () => {
    const { search, ledger } = tools({
      search: async () => {
        throw new Error("should not be called");
      },
    });

    const result = await search.execute("id", { query: "   " }, undefined, undefined, ctx);
    expect((result.content[0] as { text: string }).text).toContain("non-empty query");
    expect(ledger.total().calls).toBe(0);
  });

  test("a backend failure comes back as text, so the panelist loses a source and not the turn", async () => {
    const { search, ledger } = tools({
      search: async () => {
        throw new ResearchError("Exa returned 429: slow down");
      },
    });

    const result = await search.execute("id", { query: "q" }, undefined, undefined, ctx);
    expect((result.content[0] as { text: string }).text).toContain("429");
    expect(ledger.total().calls).toBe(0);
  });

  test("an abort still ends the turn (§12)", async () => {
    const controller = new AbortController();
    const { search } = tools({
      search: async () => {
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      },
    });

    await expect(
      search.execute("id", { query: "q" }, controller.signal, undefined, ctx),
    ).rejects.toThrow(/aborted/);
  });

  test("fetch truncates an over-long batch and names what it dropped", async () => {
    let seen: string[] = [];
    const { fetchUrl } = tools({
      fetch: async (req) => {
        seen = req.urls;
        return { hits: [], costUsd: 0.001 };
      },
    });
    const urls = Array.from({ length: MAX_FETCH_URLS + 2 }, (_, i) => `https://p${i}`);

    const result = await fetchUrl.execute("id", { urls }, undefined, undefined, ctx);

    expect(seen).toHaveLength(MAX_FETCH_URLS);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain(`first ${MAX_FETCH_URLS} of ${urls.length}`);
    expect(text).toContain(`https://p${MAX_FETCH_URLS}`);
  });

  test("fetch refuses an empty URL list without spending", async () => {
    const { fetchUrl, ledger } = tools({});
    const result = await fetchUrl.execute("id", { urls: ["  "] }, undefined, undefined, ctx);
    expect((result.content[0] as { text: string }).text).toContain("at least one URL");
    expect(ledger.total().calls).toBe(0);
  });
});
