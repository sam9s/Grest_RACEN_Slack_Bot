import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load the root project env so local runs pick up tokens and DB settings
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '..', 'windsurf-racen-local', '.env') });
// ESM-compatible import for CommonJS package
import boltPkg from "@slack/bolt";
const { App } = boltPkg;

import OpenAI from "openai";

// DO NOT paste tokens here—keep them in Dokploy env
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,     // xoxb-... from env
  appToken: process.env.SLACK_APP_TOKEN,  // xapp-... from env (App-level token)
  socketMode: true
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const SHOW_CITES = (process.env.SLACK_SHOW_CITATIONS || "1").trim() !== "0";
const SHOW_RIBBON = (process.env.ANSWER_DEBUG_FLAGS || "0").trim() !== "0";

// Answer API endpoint (Python FastAPI) that wraps our evaluated pipeline
const ANSWER_URL = process.env.RACEN_ANSWER_URL || "http://127.0.0.1:8000";
const SUPPORT_PHONE = (process.env.SUPPORT_PHONE || "").trim();
const SUPPORT_EMAIL = (process.env.SUPPORT_EMAIL || "").trim();

// Track last assistant answer per thread to help the backend/LLM interpret short acknowledgements
const lastAnswerByThread = new Map();
// Track repeated fallbacks per thread to escalate gracefully to human support
const fallbackCountByThread = new Map();
const escalatedThreads = new Set();
// Remember last active thread per (channel,user) to keep context even if user forgets to click "Reply in thread"
const lastThreadByChannelUser = new Map(); // key: `${channel}:${user}` -> { thread_ts, updated_at_ms }

function allowlistForPreset(preset) {
  const p = (preset || "").toLowerCase();
  if (p === "all") return ""; // full-site: no source filter
  if (p === "shipping") return "/policies/shipping/policy,/policies/refund/policy";
  if (p === "faqs_shipping") return "/pages/faqs,/policies/shipping/policy,/policies/refund/policy";
  if (p === "faqs_warranty_policies") {
    return "/pages/faqs,/pages/warranty,/policies/terms/of/service,/policies/refund/policy,/policies/shipping/policy";
  }
  if (p === "all_subset") return "/pages/faqs,/policies/shipping/policy,/policies/refund/policy";
  // default to FAQs
  return "/pages/faqs";
}

app.event("app_mention", async ({ event, say }) => {
  try {
    const q = (event.text || "").replace(/<@[^>]+>/, "").trim();
    const channel = event.channel;
    const user = event.user;
    const key = `${channel}:${user}`;
    const now = Date.now();
    const FRESH_MS = 10 * 60 * 1000; // 10 minutes
    let threadId = event.thread_ts || null;
    if (!threadId) {
      const last = lastThreadByChannelUser.get(key);
      if (last && (now - last.updated_at_ms) < FRESH_MS && last.thread_ts) {
        threadId = last.thread_ts;
      } else {
        threadId = event.ts; // start a new thread anchored at this message
      }
    }

    // Choose allowlist. If RETRIEVE_SOURCE_ALLOWLIST is set, honor it.
    // Otherwise derive from SLACK_ALLOWLIST_PRESET.
    const preset = process.env.SLACK_ALLOWLIST_PRESET || "faqs";
    const envAllow = (process.env.RETRIEVE_SOURCE_ALLOWLIST || "").trim();
    const allowlist = envAllow ? envAllow : allowlistForPreset(preset);

    // Call the Python Answer API for grounded answers with citations
    const resp = await fetch(`${ANSWER_URL.replace(/\/$/, "")}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question: q,
        allowlist,
        k: 18,
        short: true,
        previous_answer: threadId ? (lastAnswerByThread.get(threadId) || "") : "",
        previous_user: q
      })
    });

    if (!resp.ok) {
      await say("Info not found");
      return;
    }
    const data = await resp.json().catch(() => null);
    if (!data) {
      await say("Info not found");
      return;
    }

    const answer = data.answer || "Info not found";
    const citations = Array.isArray(data.citations) ? data.citations : [];
    const ribbon = data.settings_summary || "";

    const citationsBlock = SHOW_CITES && citations.length
      ? citations
          .slice(0, 6)
          .map((c, i) => `[$${i + 1}] ${c.url} (lines ${c.start_line}-${c.end_line})`)
          .join("\n")
      : "";

    // Build base text without ribbon for correct ordering (we may inject escalation before ribbon)
    let baseParts = [answer];
    if (SHOW_CITES && citationsBlock) baseParts.push("\n\n*Citations:*\n" + citationsBlock);
    let text = baseParts.filter(Boolean).join("");
    try {
      const ribbonFallback = /\bfallback=(\d)/.test(ribbon) && /\bfallback=1\b/.test(ribbon);
      const ans = (answer || "").trim();
      const prefixFallback = (
        ans.startsWith("I couldn’t find an exact line on that") ||
        ans.startsWith("I couldn’t find the exact info") ||
        ans.startsWith("Exact info nahi mila") ||
        ans.startsWith("Exact line nahi mila")
      );
      const isFallback = ribbonFallback || prefixFallback;
      if (threadId) {
        if (isFallback) {
          const prev = fallbackCountByThread.get(threadId) || 0;
          const next = prev + 1;
          fallbackCountByThread.set(threadId, next);
          // Escalate after 3 repeated fallbacks and only once per thread
          if (next >= 3 && !escalatedThreads.has(threadId)) {
            const toneMatch = /\btone=([A-Z_]+|[a-z_]+)\b/.exec(ribbon);
            const tone = toneMatch ? toneMatch[1].toLowerCase() : "neutral";
            const useEmoji = tone !== "upset";
            const emoji = useEmoji ? " 🙂" : "";
            const lines = [
              `\n\nIf you want, I can connect you to our support team.${emoji}`,
              SUPPORT_PHONE ? `Phone: ${SUPPORT_PHONE}` : "",
              SUPPORT_EMAIL ? `Email: ${SUPPORT_EMAIL}` : "",
              "Contact link: https://grest.in/pages/contact-us",
            ].filter(Boolean);
            // Replace the fallback body with a concise escalation-only block to avoid repetition
            text = lines.join("\n");
            escalatedThreads.add(threadId);
          }
        } else {
          // Reset the counter when we get a non-fallback answer
          fallbackCountByThread.set(threadId, 0);
        }
      }
    } catch {}

    // Append the ribbon last so escalation appears before it
    if ((SHOW_CITES || SHOW_RIBBON) && ribbon) {
      text = `${text}\n\n_${ribbon}_`;
    }

    // Reply within the same thread to preserve conversation context for ACK detection
    await say({ text, thread_ts: threadId });

    // Remember this answer for the thread
    if (threadId && answer) {
      lastAnswerByThread.set(threadId, answer);
      // update last-thread mapping for this user in this channel
      lastThreadByChannelUser.set(key, { thread_ts: threadId, updated_at_ms: now });
    }
  } catch (err) {
    console.error(err);
    await say("Error handling that message.");
  }
});

// Note: We intentionally do not hardcode an acknowledgement regex handler here.
// The backend/LLM interprets acknowledgements and responds appropriately.

// Start the app (Socket Mode; no public HTTP needed)
app.start(process.env.PORT || 3000).then(() => {
  console.log("Slack OpenAI bot is running.");
});
