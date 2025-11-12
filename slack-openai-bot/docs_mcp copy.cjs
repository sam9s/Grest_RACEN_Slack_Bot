// docs_mcp.js
// Minimal client for Tiger Docs MCP over JSON-RPC
// Uses DOCS_MCP_URL from env, e.g. http://tiger_docs_mcp:7000

const DOCS_MCP_URL = process.env.DOCS_MCP_URL || "http://tiger_docs_mcp:7000";

async function semanticSearch(prompt, limit = 5, fetchImpl) {
  const fetchFn = fetchImpl || fetch; // allow injection in tests
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "semantic_search_tiger_docs",
      arguments: { prompt, limit }
    }
  };

  const res = await fetchFn(`${DOCS_MCP_URL}/mcp/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream"
    },
    body: JSON.stringify(body),
    // 15s network timeout via AbortController
    signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Docs MCP HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = await res.json();
  if (json.error) {
    throw new Error(`Docs MCP error: ${JSON.stringify(json.error).slice(0, 200)}`);
  }

  // Expect: result.content[0].text containing a JSON blob with { results: [...] }
  const blocks = (json.result && json.result.content) || [];
  const firstText = blocks.find(b => b.type === "text")?.text || "";
  let parsed;
  try {
    parsed = JSON.parse(firstText);
  } catch {
    // Some builds may return a JSON object directly in result, handle both
    parsed = json.result || {};
  }

  const results = parsed.results || parsed.hits || [];
  // Normalize minimal shape for the Slack handler
  return results.map((r, i) => ({
    rank: i + 1,
    content: r.content || r.text || "",
    url: r.url || (r.metadata && (r.metadata.url || r.metadata.source)) || null,
    distance: r.distance ?? r.score ?? null,
    section: r.section || r.title || null,
    metadata: r.metadata || {}
  }));
}

module.exports = { semanticSearch };
