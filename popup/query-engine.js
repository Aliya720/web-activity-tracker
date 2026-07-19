/**
 * query-engine.js — the chatbot's "brain". A pure module:
 *
 *   answerQuestion(questionText, daysData) → { text, items }
 *
 * No DOM, no chrome.* APIs, no side effects. That separation matters:
 *  - it can be unit-tested with plain objects,
 *  - the UI (popup.js) stays dumb — it just renders whatever comes back,
 *  - if you ever swap this for an LLM, the UI doesn't change at all.
 *
 * How it works — a classic 3-stage intent parser:
 *   1. RANGE:  which days is the user asking about? (today / yesterday / week…)
 *   2. METRIC: which number? (visits = "opened", seconds = time, clicks)
 *   3. INTENT: what shape of answer? (top ranking / total / general summary)
 * Then merge the matching day buckets and phrase a reply.
 */

// ---------------------------------------------------------------------------
// Date helpers (local timezone — never toISOString(), which shifts to UTC).
// ---------------------------------------------------------------------------
function pad(n) {
  return String(n).padStart(2, "0");
}

export function dayKeyFor(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function daysAgoKey(now, n) {
  const d = new Date(now);
  d.setDate(d.getDate() - n);
  return dayKeyFor(d);
}

/** Keys for the last n days, ending today. */
function lastNDaysKeys(now, n) {
  const keys = [];
  for (let i = n - 1; i >= 0; i--) keys.push(daysAgoKey(now, i));
  return keys;
}

export function formatDuration(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ---------------------------------------------------------------------------
// Stage 1: time range. Returns the day keys to look at + how to phrase it.
// ---------------------------------------------------------------------------
function parseRange(q, now, allKeys) {
  if (q.includes("yesterday")) {
    return { keys: [daysAgoKey(now, 1)], phrase: "yesterday" };
  }
  if (q.includes("today")) {
    return { keys: [daysAgoKey(now, 0)], phrase: "today" };
  }
  const lastN = q.match(/last\s+(\d+)\s+days?/);
  if (lastN) {
    const n = Math.max(1, parseInt(lastN[1], 10));
    return { keys: lastNDaysKeys(now, n), phrase: `in the last ${n} days` };
  }
  if (/\bweek\b/.test(q)) {
    return { keys: lastNDaysKeys(now, 7), phrase: "in the last 7 days" };
  }
  if (/\bmonth\b|30 days/.test(q)) {
    return { keys: lastNDaysKeys(now, 30), phrase: "in the last 30 days" };
  }
  // No time word → look at everything we remember.
  return { keys: allKeys, phrase: "overall" };
}

// ---------------------------------------------------------------------------
// Stage 2: metric. Which stat is the question about?
// ---------------------------------------------------------------------------
function parseMetric(q) {
  if (/click/.test(q)) return "clicks";
  if (/time|stay|spent|long/.test(q)) return "seconds";
  if (/open|visit|view|browse|use/.test(q)) return "visits";
  return null; // unspecified — intent decides a default
}

// ---------------------------------------------------------------------------
// Stage 3: intent. What shape of answer does the user want?
// ---------------------------------------------------------------------------
function parseIntent(q) {
  if (/most|top|favorite|favourite|which|what did i open/.test(q)) return "top";
  if (/how many|how much|total|count/.test(q)) return "total";
  return "summary";
}

// ---------------------------------------------------------------------------
// Merge the requested day buckets into one { url → stats } map.
// ---------------------------------------------------------------------------
function mergeRange(days, keys) {
  const merged = {};
  for (const key of keys) {
    const bucket = days[key];
    if (!bucket) continue;
    for (const [url, p] of Object.entries(bucket)) {
      const m = (merged[url] ??= { title: "", visits: 0, clicks: 0, seconds: 0 });
      m.title = p.title || m.title;
      m.visits += p.visits;
      m.clicks += p.clicks;
      m.seconds += p.seconds;
    }
  }
  return merged;
}

function displayValue(metric, value) {
  if (metric === "seconds") return formatDuration(value);
  if (metric === "visits") return `${value} ${value === 1 ? "visit" : "visits"}`;
  return `${value} ${value === 1 ? "click" : "clicks"}`;
}

function topBy(merged, metric, count = 3) {
  return Object.entries(merged)
    .sort(([, a], [, b]) => b[metric] - a[metric])
    .slice(0, count)
    .filter(([, p]) => p[metric] > 0)
    .map(([url, p]) => ({
      url,
      title: p.title || url,
      value: displayValue(metric, p[metric]),
    }));
}

// ---------------------------------------------------------------------------
// The public API.
// Returns { text, items } — `items` are clickable page results for the UI.
// ---------------------------------------------------------------------------
export function answerQuestion(question, days, now = new Date()) {
  const q = question.toLowerCase();
  const allKeys = Object.keys(days).sort();

  const range = parseRange(q, now, allKeys);
  const merged = mergeRange(days, range.keys);
  const urls = Object.keys(merged);

  if (urls.length === 0) {
    return {
      text: `I have no activity recorded ${range.phrase}. Browse a bit and ask again — I remember the last 90 days.`,
      items: [],
    };
  }

  const intent = parseIntent(q);
  const metric = parseMetric(q);

  if (intent === "top") {
    const m = metric ?? "visits"; // "what did I open most" → visits
    const items = topBy(merged, m);
    if (items.length === 0) {
      return { text: `Nothing stands out ${range.phrase} for that.`, items: [] };
    }
    const verb = { visits: "opened", seconds: "spent time on", clicks: "clicked" }[m];
    return {
      text: `The page you most ${verb} ${range.phrase} was “${items[0].title}” — ${items[0].value}.`,
      items,
    };
  }

  if (intent === "total") {
    if (/pages?/.test(q) && metric !== "seconds" && metric !== "clicks") {
      return {
        text: `You opened ${urls.length} different ${urls.length === 1 ? "page" : "pages"} ${range.phrase}.`,
        items: [],
      };
    }
    const m = metric ?? "seconds"; // "how much…" defaults to time
    const total = urls.reduce((sum, url) => sum + merged[url][m], 0);
    return {
      text: `In total ${range.phrase}: ${displayValue(m, total)}.`,
      items: [],
    };
  }

  // Default: a brief summary of the period.
  const totals = urls.reduce(
    (acc, url) => {
      acc.visits += merged[url].visits;
      acc.clicks += merged[url].clicks;
      acc.seconds += merged[url].seconds;
      return acc;
    },
    { visits: 0, clicks: 0, seconds: 0 }
  );
  const items = topBy(merged, "seconds");
  return {
    text:
      `Here's ${range.phrase === "overall" ? "your overall activity" : `your activity ${range.phrase}`}: ` +
      `${urls.length} pages, ${totals.visits} visits, ${totals.clicks} clicks, ` +
      `${formatDuration(totals.seconds)} of active time. Where it went:`,
    items,
  };
}
