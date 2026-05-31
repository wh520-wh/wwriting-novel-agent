import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createProject } from "../src/core/project-store.mjs";
import { createResearchAdapter } from "../src/core/research-adapters.mjs";
import { fetchWebPage, searchWeb } from "../src/core/research-tools.mjs";

const fetchUrl = process.env.WWRITING_RESEARCH_FETCH_URL ?? "https://example.com";
const searchEndpoint = process.env.WWRITING_SEARCH_ENDPOINT;
const searchApiKeyEnv = process.env.WWRITING_SEARCH_API_KEY_ENV;
const searchQuery = process.env.WWRITING_SEARCH_QUERY ?? "long form writing agent";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-research-online-"));
const { projectRoot, project } = await createProject(root, {
  slug: "research-online",
  network_allowed: true
});
const adapter = createResearchAdapter({
  search_endpoint: searchEndpoint,
  search_api_key_env: searchApiKeyEnv,
  search_query_param: process.env.WWRITING_SEARCH_QUERY_PARAM ?? "q",
  search_limit_param: process.env.WWRITING_SEARCH_LIMIT_PARAM ?? "limit",
  search_results_path: process.env.WWRITING_SEARCH_RESULTS_PATH ?? "results",
  search_result_map: {
    title: process.env.WWRITING_SEARCH_TITLE_PATH ?? "title",
    url: process.env.WWRITING_SEARCH_URL_PATH ?? "url",
    snippet: process.env.WWRITING_SEARCH_SNIPPET_PATH ?? "snippet"
  }
});

const fetched = await fetchWebPage(projectRoot, project, { url: fetchUrl, stage: "online-research" }, { adapter });
assert.equal(fetched.ok, true);
assert.ok(fetched.text.length > 0);

let search = null;
if (searchEndpoint) {
  search = await searchWeb(projectRoot, project, { query: searchQuery, limit: 3, stage: "online-research" }, { adapter });
  assert.equal(search.ok, true);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      projectRoot,
      fetchUrl,
      fetchedChars: fetched.text.length,
      searchEndpointConfigured: Boolean(searchEndpoint),
      searchResults: search?.results?.length ?? null
    },
    null,
    2
  )
);
