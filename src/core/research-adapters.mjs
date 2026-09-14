import { ResearchToolError } from "./research-tools.mjs";

export class DirectFetchAdapter {
  constructor({ fetchImpl = globalThis.fetch, headers = {}, maxChars = 1_000_000 } = {}) {
    this.fetchImpl = fetchImpl;
    this.headers = headers;
    this.maxChars = maxChars;
  }

  async fetch({ url } = {}) {
    if (!this.fetchImpl) {
      throw new ResearchToolError("missing_fetch_impl", "A fetch implementation is required.");
    }
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: {
        "user-agent": "WWritingNovelAgent/0.1",
        accept: "text/html, text/plain;q=0.9, */*;q=0.8",
        ...this.headers
      }
    });
    const text = await response.text();
    if (!response.ok) {
      throw new ResearchToolError("fetch_http_error", `Fetch returned HTTP ${response.status}.`);
    }
    return {
      url,
      title: response.headers?.get?.("x-wwriting-title") ?? null,
      html: text.slice(0, this.maxChars),
      status: response.status,
      content_type: response.headers?.get?.("content-type") ?? null
    };
  }
}

export class JsonSearchApiAdapter {
  constructor({
    endpoint,
    apiKey,
    apiKeyEnv,
    fetchImpl = globalThis.fetch,
    queryParam = "q",
    limitParam = "limit",
    resultsPath = "results",
    headers = {},
    resultMap = {}
  } = {}) {
    this.endpoint = endpoint;
    this.apiKey = apiKey;
    this.apiKeyEnv = apiKeyEnv;
    this.fetchImpl = fetchImpl;
    this.queryParam = queryParam;
    this.limitParam = limitParam;
    this.resultsPath = resultsPath;
    this.headers = headers;
    this.resultMap = {
      title: "title",
      url: "url",
      snippet: "snippet",
      ...resultMap
    };
  }

  async search({ query, limit = 5 } = {}) {
    if (!this.endpoint) {
      throw new ResearchToolError("missing_search_endpoint", "Search adapter requires an endpoint.");
    }
    if (!this.fetchImpl) {
      throw new ResearchToolError("missing_fetch_impl", "A fetch implementation is required.");
    }
    const url = new URL(this.endpoint);
    url.searchParams.set(this.queryParam, query);
    url.searchParams.set(this.limitParam, String(limit));
    const apiKey = resolveApiKey(this.apiKey, this.apiKeyEnv);
    const response = await this.fetchImpl(url.toString(), {
      method: "GET",
      headers: {
        accept: "application/json",
        ...this.headers,
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
      }
    });
    const text = await response.text();
    if (!response.ok) {
      throw new ResearchToolError("search_http_error", `Search returned HTTP ${response.status}.`);
    }
    const raw = text ? JSON.parse(text) : {};
    const results = selectPath(raw, this.resultsPath);
    return (Array.isArray(results) ? results : [])
      .slice(0, limit)
      .map((item) => ({
        title: String(selectPath(item, this.resultMap.title) ?? "Untitled"),
        url: String(selectPath(item, this.resultMap.url) ?? ""),
        snippet: String(selectPath(item, this.resultMap.snippet) ?? "")
      }));
  }
}

export function createResearchAdapter(config = {}, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const directFetch = new DirectFetchAdapter({
    fetchImpl,
    headers: config.fetch_headers ?? {},
    maxChars: config.max_fetch_chars ?? 1_000_000
  });
  const search =
    config.search_endpoint || config.search?.endpoint
      ? new JsonSearchApiAdapter({
          endpoint: config.search_endpoint ?? config.search.endpoint,
          apiKey: config.search_api_key ?? config.search?.api_key,
          apiKeyEnv: config.search_api_key_env ?? config.search?.api_key_env,
          fetchImpl,
          queryParam: config.search_query_param ?? config.search?.query_param ?? "q",
          limitParam: config.search_limit_param ?? config.search?.limit_param ?? "limit",
          resultsPath: config.search_results_path ?? config.search?.results_path ?? "results",
          resultMap: config.search_result_map ?? config.search?.result_map ?? {},
          headers: config.search_headers ?? config.search?.headers ?? {}
        })
      : null;
  return {
    fetch: directFetch.fetch.bind(directFetch),
    ...(search ? { search: search.search.bind(search) } : {})
  };
}

function resolveApiKey(apiKey, apiKeyEnv) {
  if (apiKey) {
    return apiKey;
  }
  if (!apiKeyEnv) {
    return null;
  }
  const value = process.env[apiKeyEnv];
  if (!value) {
    throw new ResearchToolError("missing_search_api_key", `Missing search API key environment variable: ${apiKeyEnv}`);
  }
  return value;
}

function selectPath(value, path) {
  if (Array.isArray(value) && path === "") {
    return value;
  }
  if (!path) {
    return value;
  }
  let current = value;
  for (const part of String(path).split(".")) {
    if (current == null) {
      return undefined;
    }
    current = current[part];
  }
  return Array.isArray(current) ? current : current === undefined ? [] : current;
}
