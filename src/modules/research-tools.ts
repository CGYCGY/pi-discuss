import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  clampMaxCharacters,
  clampNumResults,
  FETCH_TOOL_NAME,
  formatHits,
  MAX_FETCH_URLS,
  MAX_NUM_RESULTS,
  type ResearchBackend,
  ResearchError,
  type ResearchLedger,
  SEARCH_TOOL_NAME,
} from "./research.ts";

export interface ResearchToolDetails {
  kind: "search" | "fetch";
  costUsd: number;
  hits: number;
}

export interface CreateResearchToolsOptions {
  /** Slot the tools belong to; the ledger attributes spend per panelist. */
  slot: string;
  backend: ResearchBackend;
  ledger: ResearchLedger;
}

/**
 * §7's "a non-answer is recorded, never dropped" applied to tools: a failed search
 * returns explanatory text instead of throwing, so a panelist loses one source
 * rather than the whole turn. A caller-driven abort is the one exception — it must
 * propagate so `/pd-abort` still ends the turn (§12).
 */
function isAbort(err: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (err instanceof Error && err.name === "AbortError");
}

/**
 * One pair of tools per slot, not one shared pair: `execute` receives no slot
 * identity, so per-slot attribution has to be closed over at construction.
 *
 * `promptSnippet` / `promptGuidelines` append to pi's *default* system prompt, which
 * panelists replace wholesale (§5). They are set anyway in case that changes, but the
 * guidance a panelist actually reads lives in buildPanelistSystem.
 */
export function createResearchTools(opts: CreateResearchToolsOptions): ToolDefinition[] {
  const { slot, backend, ledger } = opts;

  const search = defineTool({
    name: SEARCH_TOOL_NAME,
    label: "Web search",
    description:
      "Search the web and get the text of the matching pages back in one call. Use it to check a fact, " +
      "find current information, or gather evidence for a position. Cite the URLs you rely on.",
    promptSnippet: "Search the web and read the matching pages",
    promptGuidelines: [
      "Search when a claim turns on something you cannot verify from memory or the repo — a current version, a benchmark, a recent change.",
      "Cite the URL for any claim you take from a search result, and say so when a result contradicts your prior position.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "The search query." }),
      num_results: Type.Optional(
        Type.Integer({ description: `How many results to return (1-${MAX_NUM_RESULTS}).` }),
      ),
      max_characters: Type.Optional(
        Type.Integer({ description: "Characters of page text per result." }),
      ),
    }),

    async execute(_toolCallId, params, signal) {
      const query = params.query.trim();
      if (query.length === 0) {
        return { content: [{ type: "text", text: "Provide a non-empty query." }], details: undefined };
      }
      try {
        const outcome = await backend.search(
          {
            query,
            numResults: clampNumResults(params.num_results),
            maxCharacters: clampMaxCharacters(params.max_characters),
          },
          signal,
        );
        ledger.record(slot, outcome.costUsd);
        return {
          content: [{ type: "text", text: formatHits(`Results for "${query}":`, outcome.hits) }],
          details: { kind: "search", costUsd: outcome.costUsd, hits: outcome.hits.length } satisfies ResearchToolDetails,
        };
      } catch (err) {
        if (isAbort(err, signal)) throw err;
        const reason = err instanceof ResearchError ? err.message : `Search failed: ${(err as Error).message}`;
        return { content: [{ type: "text", text: reason }], details: undefined };
      }
    },
  });

  const fetchUrl = defineTool({
    name: FETCH_TOOL_NAME,
    label: "Fetch URL",
    description:
      "Retrieve the text of specific web pages by URL. Use it when you already know where the answer lives " +
      "— documentation, a changelog, a spec — rather than searching for it.",
    promptSnippet: "Read specific web pages by URL",
    promptGuidelines: [
      "Prefer fetch_url over web_search when you already know the page that settles the question.",
    ],
    parameters: Type.Object({
      urls: Type.Array(Type.String(), {
        description: `Absolute URLs to retrieve (1-${MAX_FETCH_URLS}).`,
      }),
      max_characters: Type.Optional(
        Type.Integer({ description: "Characters of page text per URL." }),
      ),
    }),

    async execute(_toolCallId, params, signal) {
      const urls = params.urls.map((u) => u.trim()).filter((u) => u.length > 0);
      if (urls.length === 0) {
        return { content: [{ type: "text", text: "Provide at least one URL." }], details: undefined };
      }
      // Truncating rather than refusing keeps a panelist's over-broad batch useful;
      // the dropped tail is named so it does not read as "these pages had nothing".
      const requested = urls.slice(0, MAX_FETCH_URLS);
      const dropped = urls.slice(MAX_FETCH_URLS);
      try {
        const outcome = await backend.fetch(
          { urls: requested, maxCharacters: clampMaxCharacters(params.max_characters) },
          signal,
        );
        ledger.record(slot, outcome.costUsd);
        const header =
          dropped.length === 0
            ? "Fetched:"
            : `Fetched the first ${MAX_FETCH_URLS} of ${urls.length} URLs (not fetched: ${dropped.join(", ")}):`;
        return {
          content: [{ type: "text", text: formatHits(header, outcome.hits) }],
          details: { kind: "fetch", costUsd: outcome.costUsd, hits: outcome.hits.length } satisfies ResearchToolDetails,
        };
      } catch (err) {
        if (isAbort(err, signal)) throw err;
        const reason = err instanceof ResearchError ? err.message : `Fetch failed: ${(err as Error).message}`;
        return { content: [{ type: "text", text: reason }], details: undefined };
      }
    },
  });

  return [search, fetchUrl];
}
