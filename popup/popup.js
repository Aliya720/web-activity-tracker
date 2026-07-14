/**
 * popup.js — logic for the popup dashboard.
 *
 * The popup is a normal webpage that happens to have access to chrome.* APIs.
 * It is created fresh every time you click the icon and destroyed when it
 * closes, so it holds no state of its own — it just reads chrome.storage.local
 * (written by background.js) and renders it.
 */

// ---------------------------------------------------------------------------
// Data loading.
//
// When opened as a plain file (for UI development, outside the extension),
// chrome.storage doesn't exist — fall back to sample data so the popup is
// previewable without loading the extension.
// ---------------------------------------------------------------------------
const SAMPLE_DATA = {
  pages: {
    "https://developer.chrome.com/docs/extensions/": {
      title: "Chrome Extensions documentation",
      visits: 4,
      clicks: 23,
      seconds: 780,
      lastVisit: Date.now(),
    },
    "https://example.com/": {
      title: "Example Domain",
      visits: 1,
      clicks: 2,
      seconds: 45,
      lastVisit: Date.now() - 3600_000,
    },
  },
  // Oldest first, matching how background.js appends to the real log.
  navigations: [
    {
      from: null,
      to: "https://example.com/",
      type: "typed",
      redirect: true,
      time: Date.now() - 3600_000,
    },
    {
      from: "https://example.com/",
      to: "https://developer.chrome.com/docs/extensions/",
      type: "link",
      redirect: false,
      time: Date.now(),
    },
  ],
};

async function loadData() {
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    const { pages = {}, navigations = [] } = await chrome.storage.local.get([
      "pages",
      "navigations",
    ]);
    return { pages, navigations };
  }
  return SAMPLE_DATA;
}

// ---------------------------------------------------------------------------
// Formatting helpers.
// ---------------------------------------------------------------------------

/** 4523 seconds → "1h 15m"; 95 → "1m 35s"; 20 → "20s" */
function formatDuration(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Shorten a URL for display: drop the protocol, keep host + path. */
function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.host + (u.pathname === "/" ? "" : u.pathname) + u.search;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Rendering.
//
// We build DOM nodes with createElement + textContent instead of innerHTML.
// Page titles and URLs come from arbitrary websites — injecting them as HTML
// would let a malicious page title run script inside our popup (XSS).
// textContent is always treated as plain text, never parsed as HTML.
// ---------------------------------------------------------------------------

function renderTotals(pages) {
  const entries = Object.values(pages);
  document.getElementById("totalPages").textContent = entries.length;
  document.getElementById("totalClicks").textContent = entries.reduce(
    (sum, p) => sum + p.clicks,
    0
  );
  document.getElementById("totalTime").textContent = formatDuration(
    entries.reduce((sum, p) => sum + p.seconds, 0)
  );
}

function renderPages(pages) {
  const list = document.getElementById("pageList");
  list.replaceChildren();

  // Most time spent first — that's the most interesting ordering.
  const sorted = Object.entries(pages).sort(([, a], [, b]) => b.seconds - a.seconds);
  document.getElementById("pagesEmpty").hidden = sorted.length > 0;

  for (const [url, page] of sorted) {
    const item = document.createElement("li");
    item.className = "page-item";

    const title = document.createElement("div");
    title.className = "page-title";
    title.textContent = page.title || shortUrl(url);

    const urlLine = document.createElement("div");
    urlLine.className = "page-url";
    urlLine.textContent = shortUrl(url);
    urlLine.title = url; // full URL on hover

    const stats = document.createElement("div");
    stats.className = "page-stats";
    for (const [label, value] of [
      ["time", formatDuration(page.seconds)],
      ["clicks", page.clicks],
      ["visits", page.visits],
    ]) {
      const span = document.createElement("span");
      const b = document.createElement("b");
      b.textContent = value;
      span.append(b, ` ${label}`);
      stats.append(span);
    }

    item.append(title, urlLine, stats);
    list.append(item);
  }
}

function renderNavigations(navigations) {
  const list = document.getElementById("navList");
  list.replaceChildren();

  // Newest first.
  const recent = [...navigations].reverse().slice(0, 50);
  document.getElementById("navEmpty").hidden = recent.length > 0;

  for (const nav of recent) {
    const item = document.createElement("li");
    item.className = "nav-item";

    const route = document.createElement("div");
    route.className = "nav-route";

    const fromSpan = document.createElement("span");
    fromSpan.className = "nav-url";
    fromSpan.textContent = nav.from ? shortUrl(nav.from) : "(new tab)";

    const arrow = document.createElement("span");
    arrow.className = "nav-arrow";
    arrow.textContent = "→";

    const toSpan = document.createElement("span");
    toSpan.className = "nav-url";
    toSpan.textContent = shortUrl(nav.to);

    route.append(fromSpan, arrow, toSpan);

    const meta = document.createElement("div");
    meta.className = "nav-meta";

    const typeBadge = document.createElement("span");
    typeBadge.className = "badge";
    typeBadge.textContent = nav.type;
    meta.append(typeBadge);

    if (nav.redirect) {
      const redirectBadge = document.createElement("span");
      redirectBadge.className = "badge redirect";
      redirectBadge.textContent = "redirect";
      meta.append(redirectBadge);
    }

    const when = document.createElement("span");
    when.textContent = new Date(nav.time).toLocaleTimeString();
    meta.append(when);

    item.append(route, meta);
    list.append(item);
  }
}

// ---------------------------------------------------------------------------
// Tab switching + clear button.
// ---------------------------------------------------------------------------
function setupTabs() {
  const tabPages = document.getElementById("tabPages");
  const tabNav = document.getElementById("tabNav");
  const pagesView = document.getElementById("pagesView");
  const navView = document.getElementById("navView");

  function activate(showPages) {
    tabPages.classList.toggle("active", showPages);
    tabNav.classList.toggle("active", !showPages);
    tabPages.setAttribute("aria-selected", String(showPages));
    tabNav.setAttribute("aria-selected", String(!showPages));
    pagesView.hidden = !showPages;
    navView.hidden = showPages;
  }

  tabPages.addEventListener("click", () => activate(true));
  tabNav.addEventListener("click", () => activate(false));
}

function setupClearButton() {
  document.getElementById("clearBtn").addEventListener("click", async () => {
    if (!confirm("Delete all tracked activity data?")) return;
    if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
      await chrome.runtime.sendMessage({ type: "clearData" });
    }
    render(); // re-render the now-empty state
  });
}

// ---------------------------------------------------------------------------
// Boot.
// ---------------------------------------------------------------------------
async function render() {
  const { pages, navigations } = await loadData();
  renderTotals(pages);
  renderPages(pages);
  renderNavigations(navigations);
}

setupTabs();
setupClearButton();
render();
