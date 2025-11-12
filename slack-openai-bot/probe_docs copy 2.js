import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { semanticSearch } = require("./docs_mcp.cjs");

// base score from embedding distance + keyword bumps tuned for GREST policy phrasing
function scoreHit(h) {
  const txt = (h.content || "").toLowerCase();
  const base = h.distance == null ? 0.5 : (1 - Math.max(0, Math.min(1, h.distance))); // higher is better
  let bonus = 0;
  const bumps = [
    { rx: /\bwarranty\b/, w: 0.35 },
    { rx: /\b6[-\s]?month(s)?\b|\bsix[-\s]?month(s)?\b/, w: 0.25 },
    { rx: /\bvalid\b|\bcoverage\b|\bcovers\b|\bclaim\b/, w: 0.15 },
    { rx: /\bmanufactur(?:er|ing)\b|\bdefect(s)?\b/, w: 0.12 },
    { rx: /\brefurbished\b|\bgrest\b/, w: 0.10 }
  ];
  for (const { rx, w } of bumps) if (rx.test(txt)) bonus += w;
  return base + bonus;
}

// choose the best full paragraph from a block (prefers warranty cues + complete sentences)
function bestWarrantyParagraph(text) {
  const paras = String(text).split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  let best = { s: -1, p: "" };
  for (const p of paras) {
    const t = p.toLowerCase();
    let s = 0;
    if (/\bwarranty\b/.test(t)) s += 2.0;
    if (/\b6[-\s]?month|\bsix[-\s]?month/.test(t)) s += 1.2;
    if (/\bcover(s|ed)?\b|\bvalid\b|\bclaim\b/.test(t)) s += 0.8;
    if (/not covered|physical damage|water damage|unauthorized repair/.test(t)) s += 0.4; // still policy context
    if (/^[A-Z]/.test(p) && /[.!?]"?$/.test(p)) s += 0.3; // likely a complete sentence
    if (s > best.s) best = { s, p };
  }
  return best.p || (paras[0] || "");
}

(async () => {
  const q = process.argv.slice(2).join(" ") || "warranty policy";
  try {
    const hits = await semanticSearch(q, 8);
    if (!hits.length) {
      console.log(JSON.stringify({ ok: true, query: q, hits: 0, note: "no evidence" }, null, 2));
      process.exit(0);
    }
    const ranked = [...hits].sort((a, b) => scoreHit(b) - scoreHit(a)).slice(0, 5);
    // pick the best paragraph from the top few
    let pick = ranked[0];
    let para = bestWarrantyParagraph(pick.content || "");
    // if paragraph doesn't include 'warranty', try the next one
    for (let i = 1; i < ranked.length && !/\bwarranty\b/i.test(para); i++) {
      const tryPara = bestWarrantyParagraph(ranked[i].content || "");
      if (/\bwarranty\b/i.test(tryPara)) { pick = ranked[i]; para = tryPara; break; }
    }

    console.log(JSON.stringify({
      ok: true,
      query: q,
      hits: hits.length,
      top: {
        rank: pick.rank,
        score: scoreHit(pick),
        distance: pick.distance,
        url: pick.url,
        section: pick.section,
        paragraph: para.slice(0, 520)
      }
    }, null, 2));
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: String(e) }, null, 2));
    process.exit(1);
  }
})();
