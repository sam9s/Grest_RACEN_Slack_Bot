import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load the root project env so local runs pick up tokens and DB settings
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
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
const THINKING_ON = (process.env.SLACK_THINKING_ENABLE || "1").trim() !== "0";
// Shared admin token for internal Slack-triggered operations. Prefer the
// general RACEN_ADMIN_TOKEN but honour the legacy IPHONE_SPECS_SYNC_TOKEN
// for backwards compatibility with earlier deployments.
const ADMIN_TOKEN = (process.env.RACEN_ADMIN_TOKEN || process.env.IPHONE_SPECS_SYNC_TOKEN || "").trim();

function convertMarkdownLinksToSlack(text) {
  if (!text) return text;
  const convertLine = (line) =>
    line.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (match, label, url) => {
      const safeLabel = String(label || "").trim();
      const safeUrl = String(url || "").trim();
      if (!safeLabel || !safeUrl) return match;
      return `<${safeUrl}|${safeLabel}>`;
    });
  return text
    .split("\n")
    .map((ln) => convertLine(ln))
    .join("\n");
}

// Answer API endpoint (Python FastAPI) that wraps our evaluated pipeline
const ANSWER_URL = process.env.RACEN_ANSWER_URL || "http://127.0.0.1:8011";
const SUPPORT_PHONE = (process.env.SUPPORT_PHONE || "").trim();
const SUPPORT_EMAIL = (process.env.SUPPORT_EMAIL || "").trim();

// Track last assistant answer per thread to help the backend/LLM interpret short acknowledgements
const lastAnswerByThread = new Map();
// Track repeated fallbacks per thread to escalate gracefully to human support
const fallbackCountByThread = new Map();
const escalatedThreads = new Set();
// Remember last active thread per (channel,user) to keep context even if user forgets to click "Reply in thread"
const lastThreadByChannelUser = new Map(); // key: `${channel}:${user}` -> { thread_ts, updated_at_ms }

// Global shortcut to ingest a grest.in URL via modal and DM status updates
app.shortcut("racen_ingest_url", async ({ ack, body, client }) => {
  await ack();
  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: "modal",
      callback_id: "racen_ingest_url_submit",
      title: { type: "plain_text", text: "Ingest URL" },
      submit: { type: "plain_text", text: "Ingest" },
      close: { type: "plain_text", text: "Cancel" },
      blocks: [
        {
          type: "input",
          block_id: "url_block",
          label: { type: "plain_text", text: "grest.in URL" },
          element: {
            type: "plain_text_input",
            action_id: "url_value",
            placeholder: { type: "plain_text", text: "https://grest.in/products/..." }
          }
        }
      ]
    }
  });
});

app.view("racen_ingest_url_submit", async ({ ack, body, view, client }) => {
  await ack();
  const userId = body.user.id;
  const raw = view.state.values?.url_block?.url_value?.value || "";
  let target = (raw || "").trim();
  console.debug(`[ingest] submit by ${userId} url=${target}`);
  try {
    const u = new URL(target);
    if (!/grest\.in$/i.test(u.hostname)) throw new Error("Only grest.in URLs are allowed");
  } catch (e) {
    // DM user about invalid URL
    try {
      const im = await client.conversations.open({ users: userId });
      await client.chat.postMessage({ channel: im.channel.id, text: `Invalid URL: ${target}` });
    } catch (err) {
      console.error(`[ingest] failed to DM invalid URL notice`, err);
    }
    return;
  }
  // Enqueue ingestion
  let jobId = "";
  try {
    const payload = { url: target, requested_by: userId };
    if (ADMIN_TOKEN) {
      payload.token = ADMIN_TOKEN;
    }
    const resp = await fetch(`${ANSWER_URL.replace(/\/$/, "")}/ingest/url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (resp.status === 403) {
      // User is not allowed to ingest; DM a friendly notice and stop.
      try {
        const im = await client.conversations.open({ users: userId });
        await client.chat.postMessage({
          channel: im.channel.id,
          text: "You are not authorized to ingest URLs. Please contact an admin if you need access."
        });
      } catch (err) {
        console.error(`[ingest] failed to DM not-authorized notice`, err);
      }
      return;
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    jobId = data.job_id || "";
    console.debug(`[ingest] enqueued job_id=${jobId}`);
  } catch (e) {
    console.error(`[ingest] enqueue failed`, e);
    try {
      const im = await client.conversations.open({ users: userId });
      await client.chat.postMessage({ channel: im.channel.id, text: `Failed to enqueue ingest: ${e}` });
    } catch (err) {
      console.error(`[ingest] failed to DM enqueue error`, err);
    }
    return;
  }
  // DM status updates by polling briefly
  let dm = null;
  try {
    const im = await client.conversations.open({ users: userId });
    dm = im.channel.id;
  } catch (err) {
    console.error(`[ingest] conversations.open failed`, err);
    return;
  }
  let msgTs = null;
  try {
    // Do NOT include the URL here to avoid early unfurl above later status messages
    const initial = await client.chat.postMessage({ channel: dm, text: `Accepted ingest\njob_id=${jobId}\nStage: queued` });
    msgTs = initial.ts;
  } catch (err) {
    console.error(`[ingest] initial DM post failed`, err);
    return;
  }
  let lastStatus = "";
  let lastStage = "";
  let transientErrors = 0;
  const interval = setInterval(async () => {
    try {
      const s = await fetch(`${ANSWER_URL.replace(/\/$/, "")}/ingest/status/${jobId}`);
      if (!s.ok) throw new Error(`status ${s.status}`);
      const js = await s.json();
      const stage = js.stage || "";
      console.debug(`[ingest] poll job=${jobId} status=${js.status} stage=${stage}`);
      const needStagePing = stage && stage !== lastStage && js.status !== "done" && js.status !== "error";
      if (js.status !== lastStatus || stage !== lastStage) {
        if (needStagePing) {
          try {
            await client.chat.postMessage({ channel: dm, text: `Stage: ${stage}` });
          } catch (err) {
            console.error(`[ingest] stage ping postMessage failed`, err);
          }
        }
        lastStatus = js.status;
        lastStage = stage;
        const detail = js.detail ? `\n${js.detail}` : "";
        const counts = (js.chunks_inserted || js.embeddings_inserted) ? `\nchunks=${js.chunks_inserted || "?"}, embeddings=${js.embeddings_inserted || "?"}` : "";
        const text = `job_id=${jobId}\nStatus: ${js.status}${stage ? `\nStage: ${stage}` : ""}${detail}${counts}`;
        // Skip updating the main message when we are at final states; we'll post a clean final summary instead
        if (js.status !== "done" && js.status !== "error") {
          try {
            await client.chat.update({ channel: dm, ts: msgTs, text });
          } catch (err) {
            console.error(`[ingest] chat.update failed`, err);
          }
        }
      }
      if (js.status === "done" || js.status === "error") {
        // Always send a final update to mark completion, even if no change detected in this tick
        try {
          // Remove URLs from the final summary so unfurl happens only on the separate URL message
          const rawDetail = js.detail ? `\n${js.detail}` : "";
          const safeDetail = rawDetail.replace(/https?:\/\/\S+/g, "").trimEnd();
          const counts = (js.chunks_inserted || js.embeddings_inserted) ? `\nchunks=${js.chunks_inserted || "?"}, embeddings=${js.embeddings_inserted || "?"}` : "";
          const finalText = `----------------\nStatus: ${js.status}${js.stage ? `\nStage: ${js.stage}` : ""}${safeDetail ? `\n${safeDetail}` : ""}${counts}`;
          // Post a new final summary message so it appears below earlier pings
          await client.chat.postMessage({ channel: dm, text: finalText });
          // Then post the URL to trigger unfurl below all statuses
          await client.chat.postMessage({ channel: dm, text: target });
        } catch (err) {
          console.error(`[ingest] final postMessage failed`, err);
        }
        clearInterval(interval);
      }
    } catch (err) {
      transientErrors += 1;
      console.error(`[ingest] status poll error (${transientErrors})`, err);
      if (transientErrors >= 5) {
        clearInterval(interval);
      }
    }
  }, 2000);
});

// Global shortcut to sync iPhone specs from the Google Sheet into RACEN's DB
app.shortcut("racen_sync_iphone_specs", async ({ ack, body, client }) => {
  await ack();
  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: "modal",
      callback_id: "racen_sync_iphone_specs_submit",
      title: { type: "plain_text", text: "Sync iPhone Specs" },
      submit: { type: "plain_text", text: "Sync" },
      close: { type: "plain_text", text: "Cancel" },
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text:
              "This will sync the latest iPhone prices and specs from the Google Sheet into RACEN's database.\n\nUse this after you update the sheet.",
          },
        },
      ],
    },
  });
});

app.view("racen_sync_iphone_specs_submit", async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;

  let dm = null;
  try {
    const im = await client.conversations.open({ users: userId });
    dm = im.channel.id;
  } catch (err) {
    console.error("[specs-sync] conversations.open failed", err);
    return;
  }

  try {
    const payload = ADMIN_TOKEN ? { token: ADMIN_TOKEN } : {};

    const resp = await fetch(
      `${ANSWER_URL.replace(/\/$/, "")}/admin/sync/iphone-specs`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
    );

    if (!resp.ok) {
      let detail = "";
      try {
        const data = await resp.json();
        detail = data.detail || data.reason || "";
      } catch {}
      const msg = `Specs sync failed (HTTP ${resp.status})${
        detail ? `: ${detail}` : ""
      }`;
      await client.chat.postMessage({ channel: dm, text: msg });
      return;
    }

    const data = await resp.json();
    const status = data.status || "";
    const rows = data.rows_written ?? 0;
    const dup = Array.isArray(data.duplicate_slugs) ? data.duplicate_slugs : [];
    const allMissing = Array.isArray(data.slugs_all_missing)
      ? data.slugs_all_missing
      : [];
    const someMissing = Array.isArray(data.slugs_some_missing)
      ? data.slugs_some_missing
      : [];

    let text = `iPhone specs sync status: ${status}\nRows written: ${rows}`;
    if (dup.length) {
      text += `\nDuplicate slugs (fix in sheet and retry): ${dup.join(", ")}`;
    }
    if (allMissing.length) {
      text += `\nNo prices set for slugs: ${allMissing.join(", ")}`;
    }
    if (someMissing.length) {
      text += `\nSome prices missing for slugs: ${someMissing.join(", ")}`;
    }

    await client.chat.postMessage({ channel: dm, text });
  } catch (err) {
    console.error("[specs-sync] request failed", err);
    try {
      await client.chat.postMessage({
        channel: dm,
        text: `Specs sync failed: ${err}`,
      });
    } catch (innerErr) {
      console.error("[specs-sync] failed to DM error", innerErr);
    }
  }
});

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

app.event("app_mention", async ({ event, say, client }) => {
  let thinkingTs = null;
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
    let allowlist = envAllow ? envAllow : allowlistForPreset(preset);
    // If the user pasted a grest.in URL, target that exact pathname to bias retrieval to the product page
    try {
      const urlMatch = (event.text || "").match(/https?:\/\/(?:www\.)?grest\.in\/[\S]+/i);
      if (urlMatch && urlMatch[0]) {
        const u = new URL(urlMatch[0]);
        const pathOnly = u.pathname || "/";
        // Override allowlist to the specific page (exclude query params for stability)
        allowlist = pathOnly;
      }
    } catch {}

    if (THINKING_ON) {
      try {
        const initial = await client.chat.postMessage({ channel, text: "Thinking…", thread_ts: threadId });
        thinkingTs = initial.ts;
      } catch {}
    }

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
      if (thinkingTs) {
        await client.chat.update({ channel, ts: thinkingTs, text: "Info not found" });
      } else {
        await say("Info not found");
      }
      return;
    }
    const data = await resp.json().catch(() => null);
    if (!data) {
      if (thinkingTs) {
        await client.chat.update({ channel, ts: thinkingTs, text: "Info not found" });
      } else {
        await say("Info not found");
      }
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

    // For product intent, ensure a clean product link is present on its own line to allow Slack unfurl
    try {
      const isProduct = /\bintent=product\b/i.test(ribbon);
      const hasCollectionBrowseLink = /https?:\/\/(?:www\.)?grest\.in\/collections\/iphones\b/i.test(text || "");
      const productBulletMatches = (text || "").match(/- \[[^\]]+\]\(https?:\/\/(?:www\.)?grest\.in\/products\//g) || [];
      const hasMultipleProductBullets = productBulletMatches.length >= 2;
      if (isProduct && citations && citations.length && !hasCollectionBrowseLink && !hasMultipleProductBullets) {
        const grestProducts = citations.filter((c) => {
          try {
            const u = new URL(c.url);
            return /grest\.in$/i.test(u.hostname) && u.pathname.startsWith("/products/");
          } catch {
            return false;
          }
        });
        let primary = grestProducts.find((c) => c.start_line === 1 && c.end_line === 1);
        if (!primary && grestProducts.length) {
          primary = grestProducts[grestProducts.length - 1];
        }
        if (primary) {
          let u;
          try {
            u = new URL(primary.url);
          } catch {}
          if (u) {
            const clean = `${u.origin}${u.pathname}`; // strip query for stability
            if (!text.includes(clean)) {
              text = `${text}\n\n[Product page](${clean})`;
            }
          }
        }
      }
    } catch {}

    // Convert any markdown-style links in the body into Slack link syntax so labels are clickable.
    text = convertMarkdownLinksToSlack(text);

    // Append the ribbon last so escalation appears before it, and ensure separation with blank lines
    if ((SHOW_CITES || SHOW_RIBBON) && ribbon) {
      text = `${text}\n\n_${ribbon}_`;
    }

    if (thinkingTs) {
      await client.chat.update({ channel, ts: thinkingTs, text });
    } else {
      await say({ text, thread_ts: threadId });
    }

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
