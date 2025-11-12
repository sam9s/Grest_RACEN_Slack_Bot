import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { semanticSearch } = require("./docs_mcp.cjs");

// --- extract query terms (keep 'policy'!) ---
function queryTerms(q) {
  const stop = new Set([
    "the","a","an","and","or","for","to","of","in","is","are",
    "what","how","at","on","with","from","about","please","info","information"
  ]);
  return String(q)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(t => t && !stop.has(t) && t.length > 2);
}

// --- hit scoring: embedding + term overlap (generic) ---
function scoreHitGeneric(h, terms) {
  const txt = (h.content || "").toLowerCase();
  const base = h.distance == null ? 0.5 : (1 - Math.max(0, Math.min(1, h.distance))); // higher is better
  let bonus = 0;
  for (const t of terms) {
    if (txt.includes(t)) bonus += 0.15;
    if (new RegExp(`\\b${t}\\b`).test(txt)) bonus += 0.10;
  }
  return base + Math.min(bonus, 1.0);
}

// --- paragraph scoring: term density + structure (generic) ---
function bestParagraphForQuery(text, terms) {
  const paras = String(text).split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  let best = { s: -1, p: "" };
  for (const p of paras) {
    const t = p.toLowerCase();
    const len = p.length;

    let s = 0;

    // term coverage
    for (const term of terms) {
      if (t.includes(term)) s += 1.0;
      if (new RegExp(`\\b${term}\\b`).test(t)) s += 0.5;
    }

    // paragraph quality: prefer substantive text
    if (len >= 120) s += 0.8;            // long enough to be policy-like
    if (/[.!?]\s+[A-Z]/.test(p)) s += 0.3; // looks like multiple sentences
    if (/^[A-Z]/.test(p) && /[.!?]"?$/.test(p)) s += 0.2;

    // down-weight questions / headings
    if (/\?\s*$/.test(p) || /^[#*-]\s*/.test(p) || /^[A-Z][A-Za-z ]{0,70}\?$/.test(p)) s -= 0.9;

    // tiny bias toward policy-esque words if present in user query
    if (terms.includes("policy")) {
      if (/\bpolicy\b/.test(t)) s += 0.6;
      if (/\bcover(s|ed)?\b|\bnot covered\b|\bvalid\b|\bclaim\b/.test(t)) s += 0.6;
    }

    if (s > best.s) best = { s, p };
  }
  return best.p || (paras[0] || "");
}

(async () => {
  const q = process.argv.slice(2).join(" ") || "warranty policy at GREST";
  const terms = queryTerms(q);
  try {
    const hits = await semanticSearch(q, 12);
    if (!hits.length) {
      console.log(JSON.stringify({ ok: true, query: q, terms, hits: 0, note: "no evidence" }, null, 2));
      process.exit(0);
    }

    // rerank hits generically by query terms
    const ranked = [...hits].sort((a, b) => scoreHitGeneric(b, terms) - scoreHitGeneric(a, terms)).slice(0, 6);

    // choose best paragraph from the top few; avoid short/question paragraphs
    let pick = ranked[0];
    let para = bestParagraphForQuery(pick.content || "", terms);
    for (let i = 1; i < ranked.length && (para.length < 120 || /\?\s*$/.test(para)); i++) {
      const tryPara = bestParagraphForQuery(ranked[i].content || "", terms);
      if (tryPara.length >= 120 && !/\?\s*$/.test(tryPara)) { pick = ranked[i]; para = tryPara; break; }
    }

    console.log(JSON.stringify({
      ok: true,
      query: q,
      terms,
      hits: hits.length,
      top: {
        rank: pick.rank,
        score: scoreHitGeneric(pick, terms),
        distance: pick.distance,
        url: pick.url,
        paragraph: para.slice(0, 520)
      }
    }, null, 2));
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: String(e) }, null, 2));
    process.exit(1);
  }
})();
