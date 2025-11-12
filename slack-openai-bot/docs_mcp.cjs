// docs_mcp.cjs
// Minimal client for Tiger Docs MCP over JSON-RPC (CommonJS)
// Uses DOCS_MCP_URL (default http://tiger_docs_mcp:7000)

const DOCS_MCP_URL = process.env.DOCS_MCP_URL || "http://tiger_docs_mcp:7000";

/**
 * Call Docs MCP semantic search and return normalized hits.
 * @param {string} prompt
 * @param {number} limit
 * @param {Function} [fetchImpl] optional fetch for tests
 * @returns {Promise<Array<{rank:number, content:string, url:string|null, distance:number|null, section:string|null, metadata:Object}>>}
 */
async function semanticSearch(prompt, limit = 5, fetchImpl) {
  const fetchFn = fetchImpl || fetch;

  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "semantic_search_tiger_docs",
      arguments: { prompt, limit }
    }
  };

  // Server requires Accept: json + event-stream
  const res = await fetchFn(`${DOCS_MCP_URL}/mcp/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream"
    },
    body: JSON.stringify(body),
    signal: (AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined)
  });

  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`Docs MCP HTTP ${res.status}: ${raw.slice(0, 200)}`);
  }

  // Prefer JSON; if SSE, grab the last data: line
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    const lastData = raw.trim().split(/\n/).filter(l => l.startsWith("data: ")).pop();
    if (!lastData) throw new Error(`Docs MCP non-JSON response: ${raw.slice(0, 120)}`);
    json = JSON.parse(lastData.replace(/^data:\s*/, ""));
  }

  if (json.error) {
    throw new Error(`Docs MCP error: ${JSON.stringify(json.error).slice(0, 200)}`);
  }

  // Block content parsing
  const blocks = (json.result && json.result.content) || [];
  const firstText = blocks.find(b => b.type === "text")?.text || "";

  let parsed;
  try {
    parsed = JSON.parse(firstText);
  } catch {
    parsed = json.result || {};
  }

  // ← structuredContent fallback added
  const results =
    parsed.results ||
    parsed.hits ||
    (json.result && json.result.structuredContent && json.result.structuredContent.results) ||
    [];

  // Normalize & parse stringified metadata; surface URL from multiple keys
  return results.map((r, i) => {
    let meta = r.metadata;
    if (typeof meta === "string") {
      try { meta = JSON.parse(meta); } catch { meta = {}; }
    }
    meta = meta || {};

    return {
      rank: i + 1,
      content: r.content || r.text || "",
      url:
        r.url ||
        r.page_url ||
        r.source ||
        meta.url || meta.source || meta.page_url || null,
      distance: (r.distance ?? r.score ?? null),
      section: r.section || r.title || null,
      metadata: meta
    };
  });
}

module.exports = { semanticSearch };
