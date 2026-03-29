# GRABR — Media Downloader

Download videos from YouTube, YouTube Shorts, Instagram (Reels, Posts, Stories, Carousels), and TikTok.

---

## Why a backend?

Instagram and YouTube block direct browser requests (CORS policy). The Node.js backend
acts as a server-side proxy — it calls the cobalt API on your behalf and returns the
download link to your browser. Without it, the site tries direct cobalt instances
which may or may not allow browser access depending on their CORS settings.

---

## Quick Start (with backend — recommended)

### Requirements
- Node.js 18 or newer (https://nodejs.org)

### Steps

```bash
# 1. Enter the project folder
cd grabr

# 2. Start the server (no npm install needed — uses only built-in Node.js modules)
node server/index.js

# 3. Open your browser
# Go to: http://localhost:3000
```

That's it. The server:
- Serves the frontend at http://localhost:3000
- Proxies cobalt API calls at http://localhost:3000/api/fetch
- Tries multiple cobalt instances automatically if one fails

---

## Without backend (browser-only mode)

Just open `public/index.html` directly in your browser.

The site will try a list of public CORS-enabled cobalt instances directly.
This works for many links but may fail if those instances block browser requests.

---

## Supported platforms

| Platform         | Video | Audio only | Multi-image |
|------------------|-------|------------|-------------|
| YouTube          | ✅    | ✅         | —           |
| YouTube Shorts   | ✅    | ✅         | —           |
| Instagram Reels  | ✅    | —          | —           |
| Instagram Posts  | ✅    | —          | ✅ (carousel)|
| Instagram Stories| ✅    | —          | —           |
| TikTok           | ✅    | ✅         | —           |
| Twitter/X        | ✅    | —          | —           |

---

## Changing the port

```bash
PORT=8080 node server/index.js
```

---

## Deploy online (free)

### Railway (recommended)
1. Push this folder to GitHub
2. Go to https://railway.app → New Project → Deploy from GitHub
3. Select your repo — Railway auto-detects Node.js and runs `npm start`
4. Your site will be live at a `*.railway.app` URL

### Render
1. Push to GitHub
2. Go to https://render.com → New Web Service
3. Build command: *(leave empty)*
4. Start command: `node server/index.js`

---

## How it works

1. You paste a URL → frontend detects platform
2. Frontend sends POST to `/api/fetch` on the backend
3. Backend tries cobalt instances in order until one succeeds
4. Cobalt returns a direct download URL (no caching, pure proxy)
5. You click Download → file saves directly from the source

---

## Powered by

- [cobalt.tools](https://cobalt.tools) — open-source media downloader
- No ads, no tracking, no file storage
