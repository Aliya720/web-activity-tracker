/**
 * content.js — injected into every http/https page (see manifest.json).
 *
 * This script runs INSIDE the webpage, so it can observe the DOM:
 *  1. Count every click on the page.
 *  2. Measure how long the page is actually visible (not just open).
 *
 * It has no access to chrome.storage rules of its own data model — instead it
 * reports raw events to background.js via chrome.runtime.sendMessage, and the
 * background worker owns all the bookkeeping. One writer = no conflicts.
 */

// ---------------------------------------------------------------------------
// 1. Click counting.
//
// We listen in the CAPTURE phase (third argument `true`). Events travel
// document → target (capture) and back up (bubble). Many sites call
// stopPropagation() on bubbling clicks, which would hide them from us —
// capture-phase listeners run first, so we see every click regardless.
//
// Clicks are batched: instead of messaging the background worker on every
// click (which would wake it constantly), we count locally and flush every
// few seconds. Batching is the standard pattern for high-frequency events.
// ---------------------------------------------------------------------------
let pendingClicks = 0;

document.addEventListener(
  "click",
  () => {
    pendingClicks += 1;
  },
  true
);

function flushClicks() {
  if (pendingClicks === 0) return;
  const count = pendingClicks;
  pendingClicks = 0;
  safeSend({ type: "clicks", count });
}

setInterval(flushClicks, 3000);

// Also flush when the user leaves the page, so the last few clicks
// aren't lost. `pagehide` is more reliable than `unload` in modern Chrome.
window.addEventListener("pagehide", flushClicks);

// ---------------------------------------------------------------------------
// 2. Time-on-page via heartbeats.
//
// Naive approach: record time on load, subtract on leave. Problem: a tab can
// sit open in the background for 8 hours — that's not "time spent".
//
// Robust approach: every HEARTBEAT_SECONDS, IF the page is currently visible
// (its tab is active and the window isn't minimized), report that interval.
// document.visibilityState gives us exactly that signal. Accuracy is within
// one heartbeat, and nothing is lost if the tab crashes or Chrome quits.
// ---------------------------------------------------------------------------
const HEARTBEAT_SECONDS = 5;

setInterval(() => {
  if (document.visibilityState === "visible") {
    safeSend({ type: "heartbeat", seconds: HEARTBEAT_SECONDS });
  }
}, HEARTBEAT_SECONDS * 1000);

// ---------------------------------------------------------------------------
// Helper: sendMessage that never throws.
//
// If the extension is reloaded/updated while this page is open, this script
// becomes "orphaned" — its chrome.runtime is dead and sendMessage throws
// "Extension context invalidated". That must not break the host page.
// ---------------------------------------------------------------------------
function safeSend(message) {
  try {
    chrome.runtime.sendMessage(message).catch(() => {});
  } catch {
    // Orphaned content script — silently stop reporting.
  }
}
