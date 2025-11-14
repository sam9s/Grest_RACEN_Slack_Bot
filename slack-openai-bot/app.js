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

// Answer API endpoint (Python FastAPI) that wraps our evaluated pipeline
const ANSWER_URL = process.env.RACEN_ANSWER_URL || "http://127.0.0.1:8000";
const SUPPORT_PHONE = (process.env.SUPPORT_PHONE || "").trim();
const SUPPORT_EMAIL = (process.env.SUPPORT_EMAIL || "").trim();

// Track last assistant answer per thread to help the backend/LLM interpret short acknowledgements
const lastAnswerByThread = new Map();

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
    const threadId = event.thread_ts || event.ts;

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
        previous_answer: threadId ? (lastAnswerByThread.get(threadId) || "") : ""
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

    const citationsBlock = citations.length
      ? citations
          .slice(0, 6)
          .map((c, i) => `[$${i + 1}] ${c.url} (lines ${c.start_line}-${c.end_line})`)
          .join("\n")
      : "";

    const text = [
      answer,
      citationsBlock ? "\n\n*Citations:*\n" + citationsBlock : "",
      ribbon ? `\n\n_${ribbon}_` : ""
    ]
      .filter(Boolean)
      .join("");

    await say({ text });

    // Remember this answer for the thread
    if (threadId && answer) {
      lastAnswerByThread.set(threadId, answer);
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
