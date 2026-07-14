/**
 * background.js — the extension's "brain" (MV3 service worker).
 *
 * Responsibilities:
 *  1. Detect every page visit (chrome.webNavigation.onCommitted).
 *  2. Record navigation edges: which page led to which page, and whether
 *     it was a link click, typed URL, redirect, etc.
 *  3. Receive click counts and time heartbeats from content.js and
 *     accumulate them in chrome.storage.local.
 *
 * CRITICAL CONSTRAINT: Chrome kills this worker after ~30s of inactivity
 * and restarts it on the next event. So:
 *  - Plain global variables DO NOT survive. Anything that must persist
 *    across worker restarts goes into chrome.storage.session (cleared when
 *    the browser closes) or chrome.storage.local (persists forever).
 */

// ---------------------------------------------------------------------------
// Storage shape (chrome.storage.local):
//
// pages: {
//   "<url>": {
//     title: string,
//     visits: number,        // how many times this page was loaded
//     clicks: number,        // total clicks on this page
//     seconds: number,       // total time the page was visible & focused
//     lastVisit: number      // timestamp (ms)
//   }
// }
//
// navigations: [
//   { from: string|null, to: string, type: string, redirect: boolean, time: number }
// ]   // capped at MAX_NAVIGATIONS, newest last
// ---------------------------------------------------------------------------

const MAX_NAVIGATIONS = 500;

/**
 * Normalize a URL so "same page" always maps to the same storage key.
 * We strip the #fragment (jumping to a section is not a new page) but
 * keep the query string (?q=... usually IS a different page).
 */
function normalizeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.hash = "";
    return url.href;
  } catch {
    return rawUrl;
  }
}

/** Ignore chrome://, about:blank, the Web Store, etc. — we only track real web pages. */
function isTrackableUrl(rawUrl) {
  return typeof rawUrl === "string" && /^https?:\/\//.test(rawUrl);
}

// ---------------------------------------------------------------------------
// A tiny write queue.
//
// chrome.storage has no transactions. If two events (say, a click batch and
// a heartbeat) both do "read → modify → write" at the same time, the second
// write can overwrite the first (a classic race condition / "lost update").
// Chaining every update onto one promise guarantees they run one at a time.
// ---------------------------------------------------------------------------
let writeQueue = Promise.resolve();

function enqueue(updateFn) {
  writeQueue = writeQueue.then(updateFn).catch((err) => {
    console.error("Storage update failed:", err);
  });
  return writeQueue;
}

/** Read the pages object, let `mutate` change one page's entry, write it back. */
function updatePage(rawUrl, mutate) {
  const url = normalizeUrl(rawUrl);
  return enqueue(async () => {
    const { pages = {} } = await chrome.storage.local.get("pages");
    const page = pages[url] ?? {
      title: "",
      visits: 0,
      clicks: 0,
      seconds: 0,
      lastVisit: 0,
    };
    mutate(page);
    pages[url] = page;
    await chrome.storage.local.set({ pages });
  });
}

/** Append one navigation edge, trimming the log to MAX_NAVIGATIONS entries. */
function recordNavigation(edge) {
  return enqueue(async () => {
    const { navigations = [] } = await chrome.storage.local.get("navigations");
    navigations.push(edge);
    await chrome.storage.local.set({
      navigations: navigations.slice(-MAX_NAVIGATIONS),
    });
  });
}

// ---------------------------------------------------------------------------
// 1 + 2. Page visits and navigation edges.
//
// webNavigation.onCommitted fires when the browser has decided which URL a
// tab is now showing. It tells us HOW the user got there:
//  - transitionType:      "link", "typed", "reload", "form_submit", ...
//  - transitionQualifiers: may contain "server_redirect" / "client_redirect"
//
// To know which page the user came FROM, we remember each tab's previous URL.
// That map must survive worker restarts, so it lives in chrome.storage.session
// (an in-memory store that outlives the worker but clears on browser exit).
// ---------------------------------------------------------------------------
chrome.webNavigation.onCommitted.addListener(async (details) => {
  // frameId 0 = the top-level page. Ignore iframes (ads, embeds, widgets),
  // otherwise every embedded YouTube player would count as a "visit".
  if (details.frameId !== 0 || !isTrackableUrl(details.url)) return;

  const to = normalizeUrl(details.url);
  const tabKey = `tabUrl_${details.tabId}`;

  // Where was this tab before? (null if it's a fresh tab)
  const stored = await chrome.storage.session.get(tabKey);
  const from = stored[tabKey] ?? null;

  // Remember the new URL as this tab's "previous URL" for next time.
  await chrome.storage.session.set({ [tabKey]: to });

  const redirect =
    details.transitionQualifiers.includes("server_redirect") ||
    details.transitionQualifiers.includes("client_redirect");

  // A reload of the same URL is not a new visit or a navigation edge.
  if (from === to && details.transitionType === "reload") return;

  updatePage(to, (page) => {
    page.visits += 1;
    page.lastVisit = Date.now();
  });

  recordNavigation({
    from,
    to,
    type: details.transitionType, // how the user navigated
    redirect, // was the browser redirected here automatically?
    time: Date.now(),
  });
});

// Once the page finishes loading, grab its <title> for nicer display.
chrome.webNavigation.onCompleted.addListener(async (details) => {
  if (details.frameId !== 0 || !isTrackableUrl(details.url)) return;
  try {
    const tab = await chrome.tabs.get(details.tabId);
    if (tab?.title) {
      updatePage(details.url, (page) => {
        page.title = tab.title;
      });
    }
  } catch {
    // Tab may already be closed — nothing to do.
  }
});

// Clean up the per-tab "previous URL" entry when a tab closes.
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(`tabUrl_${tabId}`);
});

// ---------------------------------------------------------------------------
// 3. Messages from content.js (clicks + time) and from the popup (clear data).
//
// `sender.tab.url` is trustworthy — Chrome fills it in, the page can't fake it.
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "clicks" && sender.tab && isTrackableUrl(sender.tab.url)) {
    updatePage(sender.tab.url, (page) => {
      page.clicks += message.count;
    });
  }

  if (message.type === "heartbeat" && sender.tab && isTrackableUrl(sender.tab.url)) {
    updatePage(sender.tab.url, (page) => {
      page.seconds += message.seconds;
    });
  }

  if (message.type === "clearData") {
    enqueue(async () => {
      await chrome.storage.local.remove(["pages", "navigations"]);
    }).then(() => sendResponse({ ok: true }));
    return true; // keep the message channel open for the async sendResponse
  }
});
