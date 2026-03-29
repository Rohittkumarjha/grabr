/**
 * GRABR — Media Downloader Backend v2.1
 * Fixes: dead Cobalt instances, SSL cert errors, updated API schema, better error handling
 * Run: node server/index.js
 */

'use strict';

const http = require('http');
const https = require('https');
const url = require('url');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execSync } = require('child_process');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;

// ── FFmpeg detection ──────────────────────────────────────────────────────────
let FFMPEG_PATH = null;
try {
  const which = process.platform === 'win32'
    ? execSync('where ffmpeg 2>nul').toString().trim().split('\n')[0]
    : execSync('which ffmpeg 2>/dev/null').toString().trim();
  if (which) FFMPEG_PATH = which;
} catch (_) {}
if (!FFMPEG_PATH) {
  for (const c of ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg']) {
    try { fs.accessSync(c); FFMPEG_PATH = c; break; } catch (_) {}
  }
}
console.log(FFMPEG_PATH ? `✓ FFmpeg: ${FFMPEG_PATH}` : '✗ FFmpeg not found (YouTube 720p+ will lack audio)');

// ── Cobalt instances (v10 API, no-auth, CORS-open) ────────────────────────────
// Priority order: most reliable first. Backend uses Node so no browser CORS issues.
// These are community instances that currently have auth=false per instances.cobalt.best
const COBALT_INSTANCES = [
  'https://cobalt-api.kwiatekmiki.com',   // recommended default in gobalt v2
  'https://cobalt.api.timelessnesses.me',  // long-standing community instance
  'https://capi.oak.li',                   // community instance
  'https://api.cobalt.tools',              // official — may require JWT but try last
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function sendJSON(res, status, data) {
  if (res.headersSent) return;
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendFile(res, filePath) {
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.ico': 'image/x-icon',
    '.png': 'image/png',
  };
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mime[path.extname(filePath)] || 'text/plain' });
    res.end(data);
  });
}

/**
 * HTTP/HTTPS GET with redirect following and optional SSL override.
 * rejectUnauthorized=false is needed for community instances with self-signed certs.
 */
function httpGet(targetUrl, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    let redirects = 0;
    const doRequest = (reqUrl) => {
      if (redirects > 5) return reject(new Error('Too many redirects'));
      let parsed;
      try { parsed = new url.URL(reqUrl); } catch (e) { return reject(e); }
      const mod = parsed.protocol === 'https:' ? https : http;
      const options = {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120',
          'Accept': '*/*',
          ...extraHeaders,
        },
        // Allow self-signed community instance certs — Node blocks them by default
        rejectUnauthorized: false,
        timeout: 20000,
      };
      const req = mod.request(options, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          redirects++;
          // Handle relative redirects
          const next = res.headers.location.startsWith('http')
            ? res.headers.location
            : new url.URL(res.headers.location, reqUrl).href;
          res.resume(); // drain
          return doRequest(next);
        }
        resolve(res);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
      req.end();
    };
    doRequest(targetUrl);
  });
}

function downloadToFile(srcUrl, destPath) {
  return new Promise(async (resolve, reject) => {
    try {
      const res = await httpGet(srcUrl);
      if (res.statusCode >= 400) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} downloading stream`));
      }
      const out = fs.createWriteStream(destPath);
      res.pipe(out);
      out.on('finish', resolve);
      out.on('error', reject);
      res.on('error', reject);
    } catch (e) { reject(e); }
  });
}

function mergeWithFFmpeg(videoPath, audioPath, outputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-i', videoPath,
      '-i', audioPath,
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-movflags', '+faststart',
      outputPath,
    ];
    const proc = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg exited ${code}: ${stderr.slice(-500)}`));
    });
    proc.on('error', reject);
  });
}

/**
 * POST to a Cobalt v10 instance.
 * Cobalt v10 API: POST / with JSON body, Accept: application/json
 * Response statuses: tunnel | redirect | picker | error | rate-limited
 */
function cobaltPost(instanceBase, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    let parsed;
    try { parsed = new url.URL(instanceBase + '/'); } catch (e) { return reject(e); }
    const mod = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: '/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        // Custom UA to avoid default-UA blocks some instances enforce
        'User-Agent': 'grabr/2.1 (+https://github.com/grabr-app/grabr)',
      },
      rejectUnauthorized: false, // allow self-signed community certs
      timeout: 18000,
    };
    const req = mod.request(options, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ httpStatus: res.statusCode, data: parsed });
        } catch {
          reject(new Error(`Non-JSON response from ${instanceBase} (HTTP ${res.statusCode}): ${data.slice(0, 120)}`));
        }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout from ${instanceBase}`)); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Try each Cobalt instance in order. Skip instances that require auth.
 * Cobalt v10 error codes to watch: error.api.auth.jwt.missing, error.api.auth.key.missing
 */
async function fetchFromCobalt(payload) {
  const errors = [];
  for (const inst of COBALT_INSTANCES) {
    try {
      console.log(`  → trying ${inst}`);
      const { httpStatus, data } = await cobaltPost(inst, payload);

      // Auth-required: skip to next instance instead of failing
      const errCode = data?.error?.code || data?.text || '';
      if (errCode.includes('auth')) {
        errors.push(`${inst}: auth required (${errCode})`);
        console.log(`  ✗ ${inst}: auth required — skipping`);
        continue;
      }

      // Rate limited: skip
      if (errCode.includes('rate') || httpStatus === 429) {
        errors.push(`${inst}: rate limited`);
        console.log(`  ✗ ${inst}: rate limited — skipping`);
        continue;
      }

      // Any non-error response (tunnel/redirect/picker) is a success
      if (httpStatus < 400 && data && data.status !== 'error') {
        console.log(`  ✓ ${inst} → status: ${data.status}`);
        return { ...data, _instance: inst };
      }

      errors.push(`${inst}: HTTP ${httpStatus} status=${data?.status} code=${errCode}`);
      console.log(`  ✗ ${inst}: ${errCode || data?.status}`);
    } catch (e) {
      errors.push(`${inst}: ${e.message}`);
      console.log(`  ✗ ${inst}: ${e.message}`);
    }
  }
  throw new Error('All Cobalt instances failed:\n' + errors.map(e => '  ' + e).join('\n'));
}

// ── Route: POST /api/fetch ────────────────────────────────────────────────────
async function handleFetch(req, res) {
  let body = '';
  req.on('data', c => { body += c; });
  await new Promise(r => req.on('end', r));

  let mediaUrl, quality, audioOnly;
  try {
    const parsed = JSON.parse(body);
    mediaUrl = parsed.url;
    quality = parsed.quality || 'max';
    audioOnly = !!parsed.audioOnly;
  } catch {
    return sendJSON(res, 400, { error: 'Invalid JSON body' });
  }
  if (!mediaUrl) return sendJSON(res, 400, { error: 'Missing url field' });

  console.log(`\n[FETCH] ${mediaUrl}\n  quality=${quality} audioOnly=${audioOnly}`);

  // Cobalt v10 API payload schema
  // - downloadMode: 'auto' | 'audio' | 'mute'
  // - videoQuality: '144' | '240' | '360' | '480' | '720' | '1080' | '1440' | '2160' | 'max'
  // - audioFormat: 'best' | 'mp3' | 'ogg' | 'wav' | 'opus'
  const qualityVal = quality === 'max' ? 'max' : String(parseInt(quality) || 'max');
  const payload = {
    url: mediaUrl,
    downloadMode: audioOnly ? 'audio' : 'auto',
    videoQuality: qualityVal,
    audioFormat: audioOnly ? 'mp3' : 'best',
    isNoTTWatermark: true,
    disableMetadata: false,
    twitterGif: false,
  };

  try {
    const data = await fetchFromCobalt(payload);
    data._ffmpeg = !!FFMPEG_PATH;
    sendJSON(res, 200, data);
  } catch (e) {
    console.error('[FETCH ERROR]', e.message);
    sendJSON(res, 500, { error: e.message });
  }
}

// ── Route: GET /api/stream?url=...&filename=... ───────────────────────────────
async function handleStream(req, res) {
  const { query } = url.parse(req.url, true);
  const targetUrl = decodeURIComponent(query.url || '');
  const filename = decodeURIComponent(query.filename || 'media.mp4')
    .replace(/[^a-zA-Z0-9._\- ]/g, '_');

  if (!targetUrl) return sendJSON(res, 400, { error: 'Missing url parameter' });
  console.log(`\n[STREAM] ${filename}`);

  try {
    const upstream = await httpGet(targetUrl);
    if (upstream.statusCode >= 400) {
      upstream.resume();
      return sendJSON(res, 502, { error: `Upstream returned HTTP ${upstream.statusCode}` });
    }
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="${filename}"`,
    };
    if (upstream.headers['content-type'])   headers['Content-Type']   = upstream.headers['content-type'];
    if (upstream.headers['content-length']) headers['Content-Length'] = upstream.headers['content-length'];
    res.writeHead(200, headers);
    upstream.pipe(res);
    upstream.on('error', () => { if (!res.headersSent) res.destroy(); });
  } catch (e) {
    console.error('[STREAM ERROR]', e.message);
    if (!res.headersSent) sendJSON(res, 502, { error: e.message });
  }
}

// ── Route: POST /api/merge ────────────────────────────────────────────────────
async function handleMerge(req, res) {
  if (!FFMPEG_PATH) {
    return sendJSON(res, 501, { error: 'FFmpeg not installed. Run: sudo apt install ffmpeg (Linux) or brew install ffmpeg (Mac)' });
  }

  let body = '';
  req.on('data', c => { body += c; });
  await new Promise(r => req.on('end', r));

  let videoUrl, audioUrl, filename;
  try {
    ({ videoUrl, audioUrl, filename = 'video.mp4' } = JSON.parse(body));
  } catch {
    return sendJSON(res, 400, { error: 'Invalid JSON body' });
  }
  if (!videoUrl || !audioUrl) return sendJSON(res, 400, { error: 'Need videoUrl and audioUrl' });

  const id = crypto.randomBytes(8).toString('hex');
  const tmpDir = os.tmpdir();
  const vPath = path.join(tmpDir, `grabr_v_${id}`);
  const aPath = path.join(tmpDir, `grabr_a_${id}`);
  const outPath = path.join(tmpDir, `grabr_o_${id}.mp4`);

  const cleanup = () => {
    for (const p of [vPath, aPath, outPath]) {
      try { fs.unlinkSync(p); } catch (_) {}
    }
  };

  const safeFilename = filename.replace(/[^a-zA-Z0-9._\- ]/g, '_');
  console.log(`\n[MERGE] ${safeFilename}`);
  try {
    console.log('  1/3 Downloading video stream…');
    await downloadToFile(videoUrl, vPath);
    console.log('  2/3 Downloading audio stream…');
    await downloadToFile(audioUrl, aPath);
    console.log('  3/3 Merging with FFmpeg…');
    await mergeWithFFmpeg(vPath, aPath, outPath);

    const stat = fs.statSync(outPath);
    console.log(`  ✓ Merged — ${(stat.size / 1024 / 1024).toFixed(1)} MB`);

    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="${safeFilename}"`,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });
    const stream = fs.createReadStream(outPath);
    stream.pipe(res);
    stream.on('end', cleanup);
    stream.on('error', (e) => { cleanup(); if (!res.headersSent) res.destroy(); });
  } catch (e) {
    cleanup();
    console.error('[MERGE ERROR]', e.message);
    if (!res.headersSent) sendJSON(res, 500, { error: 'Merge failed: ' + e.message });
  }
}

// ── Route: GET /api/health ────────────────────────────────────────────────────
function handleHealth(res) {
  sendJSON(res, 200, {
    status: 'ok',
    ffmpeg: !!FFMPEG_PATH,
    instances: COBALT_INSTANCES.length,
    platform: process.platform,
    node: process.version,
  });
}

// ── HTTP Server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }

  const { pathname } = url.parse(req.url);

  if (pathname === '/api/fetch'  && req.method === 'POST') return handleFetch(req, res);
  if (pathname === '/api/stream' && req.method === 'GET')  return handleStream(req, res);
  if (pathname === '/api/merge'  && req.method === 'POST') return handleMerge(req, res);
  if (pathname === '/api/health' && req.method === 'GET')  return handleHealth(res);

  // Serve static files from ../public
  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(__dirname, '../public', safePath === '/' ? 'index.html' : safePath);
  sendFile(res, filePath);
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`✗ Port ${PORT} is already in use. Kill the existing process or set PORT=xxxx`);
  } else {
    console.error('Server error:', e.message);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║  GRABR v2.1 — Media Downloader Backend       ║
║  http://localhost:${PORT}                         ║
╠══════════════════════════════════════════════╣
║  FFmpeg  : ${FFMPEG_PATH ? '✓ ' + FFMPEG_PATH : '✗ not found'}
║  Cobalt  : ${COBALT_INSTANCES.length} instances configured             ║
║  Node.js : ${process.version}                           ║
╚══════════════════════════════════════════════╝
`);
});