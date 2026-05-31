import assert from "node:assert/strict";
import test from "node:test";
import { createResearchAdapter, DirectFetchAdapter, JsonSearchApiAdapter } from "../src/core/research-adapters.mjs";
import { ResearchToolError } from "../src/core/research-tools.mjs";

test("DirectFetchAdapter fetches HTML through injected fetch implementation", async () => {
  let requestedUrl = null;
  const adapter = new DirectFetchAdapter({
    fetchImpl: async (url, init) => {
      requestedUrl = { url, init };
      return {
        ok: true,
        status: 200,
        headers: new Map([["content-type", "text/html"]]),
        async text() {
          return "<html><title>Source</title><p>Useful text.</p></html>";
        }
      };
    }
  });
  const result = await adapter.fetch({ url: "https://example.test/source" });
  assert.equal(requestedUrl.url, "https://example.test/source");
  assert.equal(requestedUrl.init.headers.accept.includes("text/html"), true);
  assert.ok(result.html.includes("Useful text."));
  assert.equal(result.status, 200);
});

test("JsonSearchApiAdapter maps configurable JSON result paths", async () => {
  let requestedUrl = null;
  const adapter = new JsonSearchApiAdapter({
    endpoint: "https://search.example.test/api",
    queryParam: "query",
    limitParam: "count",
    resultsPath: "data.items",
    resultMap: {
      title: "headline",
      url: "link",
      snippet: "summary.text"
    },
    fetchImpl: async (url) => {
      requestedUrl = new URL(url);
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            data: {
              items: [{ headline: "One", link: "https://example.test/one", summary: { text: "First result" } }]
            }
          });
        }
      };
    }
  });
  const results = await adapter.search({ query: "novel agent", limit: 3 });
  assert.equal(requestedUrl.searchParams.get("query"), "novel agent");
  assert.equal(requestedUrl.searchParams.get("count"), "3");
  assert.deepEqual(results, [{ title: "One", url: "https://example.test/one", snippet: "First result" }]);
});

test("JsonSearchApiAdapter returns an empty list when results path is not an array", async () => {
  const adapter = new JsonSearchApiAdapter({
    endpoint: "https://search.example.test/api",
    resultsPath: "data",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ data: { title: "not a list" } });
      }
    })
  });
  assert.deepEqual(await adapter.search({ query: "novel agent", limit: 3 }), []);
});

test("JsonSearchApiAdapter fails before network when configured key env is missing", async () => {
  const adapter = new JsonSearchApiAdapter({
    endpoint: "https://search.example.test/api",
    apiKeyEnv: "WWRITING_MISSING_SEARCH_KEY",
    fetchImpl: async () => {
      throw new Error("fetch should not run");
    }
  });
  await assert.rejects(
    () => adapter.search({ query: "x" }),
    (error) => error instanceof ResearchToolError && error.code === "missing_search_api_key"
  );
});

test("createResearchAdapter composes direct fetch and optional search adapter", async () => {
  const adapter = createResearchAdapter(
    {
      search_endpoint: "https://search.example.test/api",
      search_results_path: "results"
    },
    {
      fetchImpl: async (url) => ({
        ok: true,
        status: 200,
        headers: new Map(),
        async text() {
          if (String(url).includes("search.example")) {
            return JSON.stringify({ results: [{ title: "Hit", url: "https://example.test", snippet: "Snippet" }] });
          }
          return "<p>Fetched</p>";
        }
      })
    }
  );
  assert.equal(typeof adapter.fetch, "function");
  assert.equal(typeof adapter.search, "function");
  assert.equal((await adapter.search({ query: "q", limit: 1 }))[0].title, "Hit");
  assert.ok((await adapter.fetch({ url: "https://example.test" })).html.includes("Fetched"));
});
