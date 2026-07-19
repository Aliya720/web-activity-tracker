/**
 * popup.js — UI logic for the popup dashboard.
 *
 * This file is deliberately "dumb": it reads data, renders it, and forwards
 * user actions. All chatbot intelligence lives in query-engine.js (pure,
 * testable); all tracking bookkeeping lives in background.js.
 *
 * Data domains and their single writer:
 *   pages / days / navigations  → written ONLY by background.js (read here)
 *   bookmarks                   → written ONLY by this popup (user-curated)
 */

import { answerQuestion, formatDuration, dayKeyFor } from "./query-engine.js";

// ---------------------------------------------------------------------------
// Storage adapter.
//
// Inside the extension we use chrome.storage.local. Opened as a plain web
// page (for UI development), chrome.storage doesn't exist — so we fall back
// to an in-memory copy of sample data. Same interface either way: the rest
// of the code never knows which one it's talking to (the "adapter" pattern).
// ---------------------------------------------------------------------------
const IS_EXTENSION = typeof chrome !== "undefined" && !!chrome.storage?.local;

function buildSampleData() {
  const now = new Date();
  const today = dayKeyFor(now);
  const yest = new Date(now);
  yest.setDate(yest.getDate() - 1);
  const yesterday = dayKeyFor(yest);

  const docsUrl = "https://developer.chrome.com/docs/extensions/";
  const exampleUrl = "https://example.com/";

  return {
    pages: {
      [docsUrl]: { title: "Chrome Extensions documentation", visits: 4, clicks: 23, seconds: 780, lastVisit: Date.now() },
      [exampleUrl]: { title: "Example Domain", visits: 1, clicks: 2, seconds: 45, lastVisit: Date.now() - 3600_000 },
    },
    // Oldest first, matching how background.js appends to the real log.
    navigations: [
      { from: null, to: exampleUrl, type: "typed", redirect: true, time: Date.now() - 3600_000 },
      { from: exampleUrl, to: docsUrl, type: "link", redirect: false, time: Date.now() },
    ],
    days: {
      [yesterday]: {
        [docsUrl]: { title: "Chrome Extensions documentation", visits: 3, clicks: 15, seconds: 600 },
        [exampleUrl]: { title: "Example Domain", visits: 1, clicks: 2, seconds: 45 },
      },
      [today]: {
        [docsUrl]: { title: "Chrome Extensions documentation", visits: 1, clicks: 8, seconds: 180 },
      },
    },
    bookmarks: {
      Learning: [{ url: docsUrl, title: "Chrome Extensions documentation", added: Date.now() }],
    },
  };
}

const store = IS_EXTENSION
  ? {
      get: (keys) => chrome.storage.local.get(keys),
      set: (obj) => chrome.storage.local.set(obj),
    }
  : (() => {
      const mem = buildSampleData();
      return {
        get: async (keys) => {
          const wanted = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(wanted.map((k) => [k, structuredClone(mem[k])]));
        },
        set: async (obj) => Object.assign(mem, structuredClone(obj)),
      };
    })();

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

/** Open a page in a new browser tab. Chrome closes the popup automatically. */
function openUrl(url) {
  if (IS_EXTENSION && chrome.tabs?.create) {
    chrome.tabs.create({ url });
  } else {
    window.open(url, "_blank");
  }
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

/**
 * A button styled as a link that opens `url`.
 * Built with createElement + textContent (never innerHTML): titles come from
 * arbitrary websites — rendering them as HTML would be self-inflicted XSS.
 */
function pageOpenButton(label, url) {
  const btn = document.createElement("button");
  btn.className = "page-open";
  btn.textContent = label;
  btn.title = url;
  btn.addEventListener("click", () => openUrl(url));
  return btn;
}

// ---------------------------------------------------------------------------
// Totals + Pages view.
// ---------------------------------------------------------------------------
function renderTotals(pages) {
  const entries = Object.values(pages);
  document.getElementById("totalPages").textContent = entries.length;
  document.getElementById("totalClicks").textContent = entries.reduce((s, p) => s + p.clicks, 0);
  document.getElementById("totalTime").textContent = formatDuration(
    entries.reduce((s, p) => s + p.seconds, 0)
  );
}

function renderPages(pages, bookmarkedUrls) {
  const list = document.getElementById("pageList");
  list.replaceChildren();

  const sorted = Object.entries(pages).sort(([, a], [, b]) => b.seconds - a.seconds);
  document.getElementById("pagesEmpty").hidden = sorted.length > 0;

  for (const [url, page] of sorted) {
    const item = document.createElement("li");
    item.className = "page-item";

    // Title row: clickable title + bookmark star.
    const head = document.createElement("div");
    head.className = "page-head";
    head.append(pageOpenButton(page.title || shortUrl(url), url));

    const star = document.createElement("button");
    star.className = "star-btn";
    const isSaved = bookmarkedUrls.has(url);
    star.textContent = isSaved ? "★" : "☆";
    star.classList.toggle("saved", isSaved);
    star.title = "Save to a bookmark group";
    star.setAttribute("aria-label", "Save to a bookmark group");
    head.append(star);

    const urlLine = document.createElement("div");
    urlLine.className = "page-url";
    urlLine.textContent = shortUrl(url);
    urlLine.title = url;

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

    item.append(head, urlLine, stats);

    // The star reveals an inline "which group?" panel instead of a prompt()
    // dialog — native dialogs are jarring inside a 380px popup.
    star.addEventListener("click", () => {
      const existing = item.querySelector(".save-panel");
      if (existing) {
        existing.remove();
        return;
      }
      const panel = document.createElement("div");
      panel.className = "save-panel";

      const input = document.createElement("input");
      input.placeholder = "Group name, e.g. Learning";
      input.setAttribute("list", "groupList"); // suggests existing groups

      const save = document.createElement("button");
      save.textContent = "Save";
      save.addEventListener("click", async () => {
        const group = input.value.trim();
        if (!group) return input.focus();
        await addBookmark(group, url, page.title || shortUrl(url));
        panel.remove();
        star.textContent = "★";
        star.classList.add("saved");
      });

      panel.append(input, save);
      item.append(panel);
      input.focus();
    });

    list.append(item);
  }
}

// ---------------------------------------------------------------------------
// Navigation trail view.
// ---------------------------------------------------------------------------
function renderNavigations(navigations) {
  const list = document.getElementById("navList");
  list.replaceChildren();

  const recent = [...navigations].reverse().slice(0, 50); // newest first
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
// Ask view — the chatbot.
//
// Flow: user question → query-engine.answerQuestion(question, days) →
// render the reply text + clickable page results. Fresh `days` data is read
// on every question so answers always reflect current activity.
// ---------------------------------------------------------------------------
function appendMessage(role, text, items = []) {
  const log = document.getElementById("chatLog");
  const msg = document.createElement("div");
  msg.className = `msg ${role}`;
  msg.textContent = text;

  if (items.length > 0) {
    const links = document.createElement("ul");
    links.className = "msg-links";
    for (const item of items) {
      const li = document.createElement("li");
      li.append(pageOpenButton(item.title, item.url));
      const value = document.createElement("span");
      value.className = "value";
      value.textContent = `— ${item.value}`;
      li.append(value);
      links.append(li);
    }
    msg.append(links);
  }

  log.append(msg);
  log.scrollTop = log.scrollHeight; // keep the newest message visible
}

async function ask(question) {
  appendMessage("user", question);
  const { days = {} } = await store.get("days");
  const answer = answerQuestion(question, days);
  appendMessage("bot", answer.text, answer.items);
}

function setupAsk() {
  const form = document.getElementById("askForm");
  const input = document.getElementById("askInput");

  form.addEventListener("submit", (event) => {
    event.preventDefault(); // a form submit would reload the popup page
    const question = input.value.trim();
    if (!question) return;
    input.value = "";
    ask(question);
  });

  // Suggestion chips double as documentation of what the engine understands.
  document.getElementById("chips").addEventListener("click", (event) => {
    if (event.target.classList.contains("chip")) {
      ask(event.target.textContent);
    }
  });

  appendMessage(
    "bot",
    "Ask me about your browsing — I remember the last 90 days, and nothing leaves your device. Try a suggestion below."
  );
}

// ---------------------------------------------------------------------------
// Saved view — bookmark groups.
// ---------------------------------------------------------------------------
async function getBookmarks() {
  const { bookmarks = {} } = await store.get("bookmarks");
  return bookmarks;
}

async function addBookmark(group, url, title) {
  const bookmarks = await getBookmarks();
  const items = (bookmarks[group] ??= []);
  if (!items.some((b) => b.url === url)) {
    items.push({ url, title, added: Date.now() });
    await store.set({ bookmarks });
  }
  renderSaved(bookmarks);
  refreshGroupDatalist(bookmarks);
}

async function removeBookmark(group, url) {
  const bookmarks = await getBookmarks();
  bookmarks[group] = (bookmarks[group] ?? []).filter((b) => b.url !== url);
  if (bookmarks[group].length === 0) delete bookmarks[group];
  await store.set({ bookmarks });
  renderSaved(bookmarks);
  refreshGroupDatalist(bookmarks);
  render(); // stars in the Pages tab may need to un-fill
}

/** Existing group names as <datalist> suggestions for the save panels. */
function refreshGroupDatalist(bookmarks) {
  const datalist = document.getElementById("groupList");
  datalist.replaceChildren();
  for (const name of Object.keys(bookmarks)) {
    const option = document.createElement("option");
    option.value = name;
    datalist.append(option);
  }
}

/**
 * Open every link in a bookmark group with one click.
 *
 * Tabs are created with { active: false } so the popup isn't closed by the
 * first tab stealing focus mid-loop. Then all new tabs are collected into a
 * native Chrome tab group titled after the bookmark group (chrome.tabGroups
 * needs the "tabGroups" permission in the manifest).
 */
async function openGroup(name, items) {
  if (IS_EXTENSION && chrome.tabs?.create) {
    const tabs = await Promise.all(
      items.map((b) => chrome.tabs.create({ url: b.url, active: false }))
    );
    if (chrome.tabs.group && chrome.tabGroups) {
      const groupId = await chrome.tabs.group({ tabIds: tabs.map((t) => t.id) });
      await chrome.tabGroups.update(groupId, { title: name });
    }
  } else {
    // Dev preview outside the extension: plain window.open. Note: popup
    // blockers typically allow only the first — full behavior needs Chrome.
    for (const b of items) window.open(b.url, "_blank");
  }
}

function renderSaved(bookmarks) {
  const container = document.getElementById("groupsContainer");
  container.replaceChildren();

  const groups = Object.entries(bookmarks);
  document.getElementById("savedEmpty").hidden = groups.length > 0;

  for (const [name, items] of groups) {
    const groupEl = document.createElement("div");
    groupEl.className = "group";

    const head = document.createElement("div");
    head.className = "group-head";

    const title = document.createElement("span");
    title.className = "group-name";
    title.textContent = name;
    const count = document.createElement("span");
    count.className = "group-count";
    count.textContent = `${items.length}`;
    title.append(count);

    const openAll = document.createElement("button");
    openAll.className = "open-all";
    openAll.textContent = "Open all ↗";
    openAll.title = `Open all ${items.length} links in a "${name}" tab group`;
    openAll.addEventListener("click", () => openGroup(name, items));

    head.append(title, openAll);

    const list = document.createElement("ul");
    list.className = "group-items";

    for (const bookmark of items) {
      const li = document.createElement("li");
      li.append(pageOpenButton(bookmark.title, bookmark.url));

      const remove = document.createElement("button");
      remove.className = "icon-btn";
      remove.textContent = "✕";
      remove.title = `Remove from ${name}`;
      remove.setAttribute("aria-label", `Remove ${bookmark.title} from ${name}`);
      remove.addEventListener("click", () => removeBookmark(name, bookmark.url));
      li.append(remove);

      list.append(li);
    }

    groupEl.append(head, list);
    container.append(groupEl);
  }
}

function setupBookmarkCurrent() {
  const btn = document.getElementById("bookmarkCurrentBtn");

  // Outside the extension there is no "current tab" — hide the button.
  if (!IS_EXTENSION || !chrome.tabs?.query) {
    btn.hidden = true;
    return;
  }

  btn.addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || !/^https?:\/\//.test(tab.url)) return;

    // Reuse the same inline panel pattern: pick/create a group, then save.
    if (btn.nextElementSibling?.classList.contains("save-panel")) {
      btn.nextElementSibling.remove();
      return;
    }
    const panel = document.createElement("div");
    panel.className = "save-panel";

    const input = document.createElement("input");
    input.placeholder = "Group name, e.g. Reading";
    input.setAttribute("list", "groupList");

    const save = document.createElement("button");
    save.textContent = "Save";
    save.addEventListener("click", async () => {
      const group = input.value.trim();
      if (!group) return input.focus();
      await addBookmark(group, tab.url, tab.title || shortUrl(tab.url));
      panel.remove();
    });

    panel.append(input, save);
    btn.after(panel);
    input.focus();
  });
}

// ---------------------------------------------------------------------------
// Tabs + clear button.
// ---------------------------------------------------------------------------
function setupTabs() {
  const tabs = [...document.querySelectorAll(".tab")];
  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      for (const t of tabs) {
        const active = t === tab;
        t.classList.toggle("active", active);
        t.setAttribute("aria-selected", String(active));
        document.getElementById(t.dataset.view).hidden = !active;
      }
      if (tab.dataset.view === "askView") {
        document.getElementById("askInput").focus();
      }
    });
  }
}

function setupClearButton() {
  document.getElementById("clearBtn").addEventListener("click", async () => {
    if (!confirm("Delete all tracked activity data? (Bookmarks are kept.)")) return;
    if (IS_EXTENSION && chrome.runtime?.sendMessage) {
      await chrome.runtime.sendMessage({ type: "clearData" });
    } else {
      await store.set({ pages: {}, navigations: [], days: {} });
    }
    render();
  });
}

// ---------------------------------------------------------------------------
// Boot.
// ---------------------------------------------------------------------------
async function render() {
  const { pages = {}, navigations = [] } = await store.get(["pages", "navigations"]);
  const bookmarks = await getBookmarks();

  const bookmarkedUrls = new Set(
    Object.values(bookmarks).flatMap((items) => items.map((b) => b.url))
  );

  renderTotals(pages);
  renderPages(pages, bookmarkedUrls);
  renderNavigations(navigations);
  renderSaved(bookmarks);
  refreshGroupDatalist(bookmarks);
}

setupTabs();
setupClearButton();
setupAsk();
setupBookmarkCurrent();
render();
