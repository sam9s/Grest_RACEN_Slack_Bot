import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { semanticSearch } = require("./docs_mcp.cjs");

// simple keyword re-rank tuned for GREST policy phrasing
function scoreHit(h) {
  const txt = (h.content || "").toLowerCase();
  const base = h.distance == null ? 0.5 : (1 - Math.max(0, Math.min(1, h.distance))); // higher is better
  let bonus = 0;

  const bumps = [
    { rx: /\bwarranty\b/, w: 0.35 },
    { rx: /\b6[-\s]?month(s)?\b|\bsix[-\s]?month(s)?\b/, w: 0.25 },
    { rx: /\bvalid\b|\bcoverage\b|\bcovers\b|\bclaim\b/, w: 0.15 },
    { rx: /\bmanufactur(?:er|ing)\b|\bdefect(s)?\b/, w: 0.12 },
    { rx: /\brefurbished\b|\bgrest\b/, w: 0.1 }
  ];
  for (const { rx, w } of bumps) if (rx.test(txt)) bonus += w;

  return base + bonus;
}

(async () => {
  const q = process.argv.slice(2).join(" ") || "warranty policy";
  try {
    const hits = await semanticSearch(q, 8); // ask for a few more
    if (!hits.length) {
      console.log(JSON.stringify({ ok: true, query: q, hits: 0, note: "no evidence" }, null, 2));
      process.exit(0);
    }

    const ranked = [...hits].sort((a, b) => scoreHit(b) - scoreHit(a));
    const top = ranked[0];

    console.log(JSON.stringify({
      ok: true,
      query: q,
      hits: hits.length,
      top: {
        rank: top.rank,
        score: scoreHit(top),
        distance: top.distance,
        url: top.url,
        section: top.section,
        snippet: (top.content || "").slice(0, 360)
      }
    }, null, 2));
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: String(e) }, null, 2));
    process.exit(1);
  }
})();
