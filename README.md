# Web Activity Tracker

Web Activity Tracker is a Chrome extension that helps you understand your own browsing activity. It tracks pages you visit, clicks, active time on each page, and the path you took between pages.

All data stays on your computer. The extension stores activity in `chrome.storage.local` and does not send browsing data to any server.

## Project Path

Use this folder when loading the extension in Chrome:

```text
D:\projects\web-activity-tracker
```

## What It Does

- Tracks visited web pages.
- Counts clicks on each page.
- Measures active time only while a page is visible.
- Records navigation trails, such as typed URLs, link clicks, reloads, and redirects.
- Keeps daily activity for the last 90 days.
- Provides an Ask tab for local questions like:
  - `Summary of today`
  - `What did I open most yesterday?`
  - `Where did I spend most time this week?`
- Lets you save pages into named bookmark groups.
- Can open all saved links in a group as a native Chrome tab group.

## Install In Chrome

1. Open Chrome.
2. Go to:

```text
chrome://extensions
```

3. Turn on `Developer mode` in the top-right corner.
4. Click `Load unpacked`.
5. Select this project folder:

```text
D:\projects\web-activity-tracker
```

6. Pin the extension from the Chrome toolbar puzzle icon.
7. Browse a few normal `http` or `https` pages.
8. Click the Web Activity Tracker icon to open the dashboard.

## How To Use

### Pages

The Pages tab shows each tracked page with:

- Page title
- URL
- Visit count
- Click count
- Active time spent

Click a page title to open it again. Use the star button to save a page into a bookmark group.

### Trail

The Trail tab shows recent navigation history. It shows where you came from, where you went, and whether Chrome detected the navigation as a link, typed URL, reload, redirect, or another transition type.

### Ask

The Ask tab answers simple questions from your locally stored activity. No AI service or remote API is used.

Example questions:

```text
Summary of today
What did I open most yesterday?
How many pages did I open today?
Where did I spend most time this week?
How much time did I spend in the last 7 days?
```

### Saved

The Saved tab lets you keep useful pages in named groups, such as `Learning`, `Work`, or `Reading`.

Use `Bookmark current page` to save the current tab. Use `Open all` to open every link in a group and place those tabs into a Chrome tab group.

## Privacy

This extension is designed for local tracking only.

- Browsing activity is saved in Chrome's local extension storage.
- Data is not uploaded anywhere.
- The Ask feature runs with local JavaScript rules.
- `Clear data` deletes tracked activity but keeps saved bookmark groups.

## Files

```text
web-activity-tracker/
  manifest.json
  background.js
  content.js
  popup/
    popup.html
    popup.css
    popup.js
    query-engine.js
  README.md
```

### `manifest.json`

Defines the Chrome extension. It declares Manifest V3, extension permissions, the background service worker, the content script, and the popup page.

### `background.js`

Runs as the extension service worker. It owns activity storage, records page visits, records navigation trails, receives click and time messages, and clears tracked data when requested.

### `content.js`

Runs inside visited `http` and `https` web pages. It counts clicks and sends active-time heartbeats to the background service worker.

### `popup/popup.html`

Defines the popup dashboard structure.

### `popup/popup.css`

Styles the popup dashboard.

### `popup/popup.js`

Renders the dashboard, switches tabs, opens pages, manages saved bookmark groups, and connects the Ask tab to the query engine.

### `popup/query-engine.js`

Contains the local rule-based question engine used by the Ask tab.

## Permissions

The extension uses these Chrome permissions:

- `storage`: saves activity and bookmark groups locally.
- `tabs`: reads current tab details and opens saved pages.
- `webNavigation`: records visits and navigation transitions.
- `tabGroups`: opens saved bookmark groups as Chrome tab groups.

It also uses host permissions for:

```text
http://*/*
https://*/*
```

These allow the content script to run on normal web pages.

## Reload After Changes

After changing `manifest.json` or `background.js`:

1. Go to `chrome://extensions`.
2. Find Web Activity Tracker.
3. Click the reload button on the extension card.

After changing `content.js`, reload the extension and refresh the web pages you want to track.

After changing files in `popup/`, close and reopen the popup.

## Development Preview

You can open `popup/popup.html` directly in a browser to preview the popup UI with sample data. Full tracking only works when the project is loaded as a Chrome extension.

## Notes For New Users

- The extension only tracks pages loaded after it is installed.
- Chrome internal pages like `chrome://extensions` are not tracked.
- Background tabs do not accumulate active time.
- Activity is kept for 90 daily buckets.
- Saved bookmark groups are kept when you clear tracked activity.
