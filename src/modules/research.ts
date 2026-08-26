import { readStoredCredential } from "@earendil-works/pi-coding-agent";

/**
 * auth.json provider id for the search key. Not a model provider — pi's credential
 * store is keyed by arbitrary id, so the key lives beside the model credentials in
 * `~/.pi/agent/auth.json` and never enters this repo (§5, §21).
 */
export const EXA_PROVIDER_ID = "exa";

/** Env override, checked before the stored credential. Mirrors prime-agent's SERPER_API_KEY precedence. */
export const EXA_ENV_VAR = "EXA_API_KEY";

export const SEARCH_TOOL_NAME = "web_search";
export const FETCH_TOOL_NAME = "fetch_url";

/** Exa's own ceiling on `text.maxCharacters`; asking for more is a 400. */
export const MAX_CHARACTERS_CEILING = 10_000;

export const DEFAULT_NUM_RESULTS = 5;
export const DEFAULT_MAX_CHARACTERS = 3_000;

/** Guards against a panelist asking for 100 full pages and burying its own context. */
export const MAX_NUM_RESULTS = 10;
export const MAX_FETCH_URLS = 5;

export interface ResearchHit {
  title: string;
  url: string;
  publishedDate?: string;
  text?: string;
  /** Present only on fetches, where Exa reports per-URL retrieval failures out-of-band. */
  error?: string;
}

export interface ResearchOutcome {
  hits: ResearchHit[];
  /** Exa reports what it charged in the response body; §8.5 meters the real number, never an estimate. */
  costUsd: number;
}

export interface SearchRequest {
  query: string;
  numResults: number;
  maxCharacters: number;
}

export interface FetchRequest {
  urls: string[];
  maxCharacters: number;
}

/**
 * The seam tests stub. Keeping the HTTP call behind an interface is what lets the
 * tool's formatting, clamping, metering, and error paths run with zero paid calls (§15).
 */
export interface ResearchBackend {
  search(req: SearchRequest, signal?: AbortSignal): Promise<ResearchOutcome>;
  fetch(req: FetchRequest, signal?: AbortSignal): Promise<ResearchOutcome>;
}

export class ResearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResearchError";
  }
}

/**
 * A stored key may be a literal or the *name* of an env var holding it. `!command`
 * refs are resolved by pi at login time and cannot be safely run from here, so they
 * read as absent rather than as a broken key.
 */
function resolveConfiguredValue(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.startsWith("!")) return undefined;
  const fromEnv = process.env[trimmed]?.trim();
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : trimmed;
}

/**
 * Read on every call rather than cached at boot, so a key added mid-session with
 * pi's `/login` works without restarting the panel — prime-agent's rationale, and it
 * costs one small synchronous read per search.
 *
 * `readStoredCredential` is the one-off reader and deliberately does *not* resolve
 * configured key values, which is why resolveConfiguredValue exists here.
 */
export function resolveExaKey(authPath?: string): string | undefined {
  const fromEnv = process.env[EXA_ENV_VAR]?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;

  let credential: ReturnType<typeof readStoredCredential>;
  try {
    credential = readStoredCredential(EXA_PROVIDER_ID, authPath);
  } catch {
    return undefined;
  }
  // `key` is optional on ApiKeyCredential: an entry can carry only provider-scoped
  // `env` values, which is an absent key for our purposes.
  if (credential === undefined || credential.type !== "api_key" || credential.key === undefined) return undefined;
  return resolveConfiguredValue(credential.key);
}

/** The message a panelist sees when research is on but no key is reachable. */
export const NO_KEY_MESSAGE = [
  "Web research is not available: no Exa API key is configured.",
  `Answer from what you already know and from the repo, and say plainly that you could not verify online.`,
  "",
  "For the operator, not for you to act on: get a key at https://exa.ai, then store it in pi under the",
  `provider id "${EXA_PROVIDER_ID}" (or export ${EXA_ENV_VAR}).`,
].join("\n");

interface ExaResult {
  title?: string | null;
  url?: string | null;
  publishedDate?: string | null;
  text?: string | null;
}

interface ExaStatus {
  id?: string | null;
  status?: string | null;
  error?: { tag?: string | null; httpStatusCode?: number | null } | null;
}

interface ExaResponse {
  results?: ExaResult[] | null;
  statuses?: ExaStatus[] | null;
  costDollars?: { total?: number | null } | null;
}

function toHits(body: ExaResponse): ResearchHit[] {
  const hits: ResearchHit[] = [];
  for (const raw of body.results ?? []) {
    const url = (raw.url ?? "").trim();
    if (url.length === 0) continue;
    const title = (raw.title ?? "").trim();
    const published = (raw.publishedDate ?? "").trim();
    const text = (raw.text ?? "").trim();
    hits.push({
      title: title.length > 0 ? title : "Untitled",
      url,
      ...(published.length > 0 ? { publishedDate: published } : {}),
      ...(text.length > 0 ? { text } : {}),
    });
  }
  return hits;
}

/**
 * A fetch that fails for one URL still returns 200 with the failure in `statuses`.
 * Surfacing it as a hit keeps §7's "never silently drop" rule at the tool layer:
 * the panelist is told the page was unreachable rather than left to infer it.
 */
function statusFailures(body: ExaResponse, hits: ResearchHit[], requested: string[]): ResearchHit[] {
  const returned = new Set(hits.map((h) => h.url));
  const failures: ResearchHit[] = [];
  for (const status of body.statuses ?? []) {
    const id = (status.id ?? "").trim();
    if (id.length === 0 || returned.has(id)) continue;
    if ((status.status ?? "").toLowerCase() === "success") continue;
    const tag = (status.error?.tag ?? "").trim();
    const code = status.error?.httpStatusCode;
    const detail = [tag.length > 0 ? tag : undefined, code === null || code === undefined ? undefined : `HTTP ${code}`]
      .filter((part) => part !== undefined)
      .join(", ");
    failures.push({ title: "Not retrieved", url: id, error: detail.length > 0 ? detail : "unavailable" });
  }
  // A requested URL that came back in neither list is still a non-answer, not a silence.
  for (const url of requested) {
    if (!returned.has(url) && !failures.some((f) => f.url === url)) {
      failures.push({ title: "Not retrieved", url, error: "no result returned" });
    }
  }
  return failures;
}

export interface ExaBackendOptions {
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof globalThis.fetch;
  /** Overridden in tests only. */
  baseUrl?: string;
  timeoutMs?: number;
  authPath?: string;
}

export const DEFAULT_TIMEOUT_MS = 30_000;

export function createExaBackend(opts: ExaBackendOptions = {}): ResearchBackend {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const baseUrl = opts.baseUrl ?? "https://api.exa.ai";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function post(path: string, body: unknown, signal?: AbortSignal): Promise<ExaResponse> {
    const key = resolveExaKey(opts.authPath);
    if (key === undefined) throw new ResearchError(NO_KEY_MESSAGE);

    // The panelist's own abort must win, but an unresponsive Exa must not hold a
    // round open past its budget either, so both signals arm the same request.
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);

    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "x-api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: combined,
      });
    } catch (err) {
      if (signal?.aborted === true) throw err;
      throw new ResearchError(`Exa request failed: ${(err as Error).message}`);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new ResearchError(
        `Exa returned ${response.status}${detail.length > 0 ? `: ${detail.slice(0, 400)}` : ""}`,
      );
    }
    try {
      return (await response.json()) as ExaResponse;
    } catch (err) {
      throw new ResearchError(`Exa returned unreadable JSON: ${(err as Error).message}`);
    }
  }

  return {
    async search(req, signal) {
      const body = await post(
        "/search",
        {
          query: req.query,
          numResults: req.numResults,
          contents: { text: { maxCharacters: req.maxCharacters } },
        },
        signal,
      );
      return { hits: toHits(body), costUsd: body.costDollars?.total ?? 0 };
    },

    async fetch(req, signal) {
      const body = await post("/contents", { urls: req.urls, text: { maxCharacters: req.maxCharacters } }, signal);
      const hits = toHits(body);
      return {
        hits: [...hits, ...statusFailures(body, hits, req.urls)],
        costUsd: body.costDollars?.total ?? 0,
      };
    },
  };
}

export interface ResearchSpend {
  calls: number;
  costUsd: number;
}

/**
 * Search spend is billed by Exa, not by the model provider, so `getSessionStats()`
 * cannot see it. Without this ledger a panel could sail past `max_cost` on search
 * charges the guard never counted (§8.5).
 */
export class ResearchLedger {
  private readonly perSlot = new Map<string, ResearchSpend>();
  /** Spend from rounds this process did not run, read back from meta.yaml on resume. */
  private carried = 0;

  /** Seeds the guard with prior rounds' search spend so a resume cannot reset the cap. */
  carry(costUsd: number): void {
    this.carried += costUsd;
  }

  record(slot: string, costUsd: number): void {
    const current = this.perSlot.get(slot) ?? { calls: 0, costUsd: 0 };
    this.perSlot.set(slot, { calls: current.calls + 1, costUsd: current.costUsd + costUsd });
  }

  forSlot(slot: string): ResearchSpend {
    return this.perSlot.get(slot) ?? { calls: 0, costUsd: 0 };
  }

  total(): ResearchSpend {
    let calls = 0;
    let costUsd = this.carried;
    for (const spend of this.perSlot.values()) {
      calls += spend.calls;
      costUsd += spend.costUsd;
    }
    return { calls, costUsd };
  }

  snapshot(): Map<string, ResearchSpend> {
    return new Map(this.perSlot);
  }
}

export function clampNumResults(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_NUM_RESULTS;
  return Math.max(1, Math.min(MAX_NUM_RESULTS, Math.trunc(requested)));
}

export function clampMaxCharacters(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_MAX_CHARACTERS;
  return Math.max(200, Math.min(MAX_CHARACTERS_CEILING, Math.trunc(requested)));
}

export function formatHits(header: string, hits: ResearchHit[]): string {
  if (hits.length === 0) return `${header}\n\nNo results.`;
  const blocks = hits.map((hit, index) => {
    const lines = [`[${index + 1}] ${hit.title}`, `URL: ${hit.url}`];
    if (hit.publishedDate !== undefined) lines.push(`Published: ${hit.publishedDate}`);
    if (hit.error !== undefined) lines.push(`Unavailable: ${hit.error}`);
    if (hit.text !== undefined) lines.push("", hit.text);
    return lines.join("\n");
  });
  return `${header}\n\n${blocks.join("\n\n---\n\n")}`;
}
