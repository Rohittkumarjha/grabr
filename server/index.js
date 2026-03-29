/**
 * GRABR — Media Downloader Backend v2
 * Handles YouTube audio+video merging via FFmpeg
 * Run: node server/index.js
 */

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
} catch {}
if (!FFMPEG_PATH) {
  for (const c of ['/usr/bin/ffmpeg','/usr/local/bin/ffmpeg','/opt/homebrew/bin/ffmpeg']) {
    try { fs.accessSync(c); FFMPEG_PATH = c; break; } catch {}
  }
}
console.log(FFMPEG_PATH ? `✓ FFmpeg: ${FFMPEG_PATH}` : '✗ FFmpeg not found');

// ── Cobalt instances ──────────────────────────────────────────────────────────
const COBALT_INSTANCES = [
  'https://cobalt.api.buldav.com',
  'https://cobalt.api.timelessnesses.me',
  'https://capi.oak.li',
  'https://api.cobalt.tools',
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function sendJSON(res, status, data) {
  if (res.headersSent) return;
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

function sendFile(res, filePath) {
  const mime = {'.html':'text/html','.css':'text/css','.js':'application/javascript','.ico':'image/x-icon'};
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mime[path.extname(filePath)] || 'text/plain' });
    res.end(data);
  });
}

function httpFetch(targetUrl) {
  return new Promise((resolve, reject) => {
    const parsed = new url.URL(targetUrl);
    const mod = parsed.protocol === 'https:' ? https : http;
    mod.get(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': '*/*',
      }
    }, (res) => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        return resolve(httpFetch(res.headers.location));
      }
      resolve(res);
    }).on('error', reject);
  });
}

function downloadToFile(srcUrl, destPath) {
  return new Promise(async (resolve, reject) => {
    try {
      const res = await httpFetch(srcUrl);
      const out = fs.createWriteStream(destPath);
      res.pipe(out);
      out.on('finish', resolve);
      out.on('error', reject);
      res.on('error', reject);
    } catch(e) { reject(e); }
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
      outputPath
    ];
    const proc = spawn(FFMPEG_PATH, args);
    let stderr = '';
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error('FFmpeg exited ' + code + ': ' + stderr.slice(-400)));
    });
    proc.on('error', reject);
  });
}

function cobaltPost(instanceBase, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const parsed = new url.URL(instanceBase + '/');
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
        'User-Agent': 'grabr/2.0',
      },
    };
    const req = mod.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { reject(new Error('Invalid JSON from ' + instanceBase)); }
      });
    });
    req.setTimeout(14000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function fetchFromCobalt(payload) {
  const errors = [];
  for (const inst of COBALT_INSTANCES) {
    try {
      console.log(`  → ${inst}`);
      const r = await cobaltPost(inst, payload);
      if (r.status < 400 && r.data && r.data.status !== 'error') {
        console.log(`  ✓ ${inst} (${r.data.status})`);
        return { ...r.data, _instance: inst };
      }
      const errCode = r.data?.error?.code || r.data?.text || 'unknown';
      errors.push(`${inst}: status=${r.data?.status} code=${errCode}`);
      console.log(`  ✗ ${inst}: ${errCode}`);
    } catch(e) {
      errors.push(`${inst}: ${e.message}`);
      console.log(`  ✗ ${inst}: ${e.message}`);
    }
  }
  throw new Error('All instances failed:\n' + errors.map(e=>'  '+e).join('\n'));
}

// ── Route: POST /api/fetch ────────────────────────────────────────────────────
async function handleFetch(req, res) {
  let body = '';
  req.on('data', c => body += c);
  await new Promise(r => req.on('end', r));

  let mediaUrl, quality, audioOnly;
  try { ({ url: mediaUrl, quality = 'max', audioOnly = false } = JSON.parse(body)); }
  catch { return sendJSON(res, 400, { error: 'Invalid JSON' }); }
  if (!mediaUrl) return sendJSON(res, 400, { error: 'Missing url' });

  console.log(`\n[FETCH] ${mediaUrl}\n  quality=${quality} audioOnly=${audioOnly}`);

  const payload = {
    url: mediaUrl,
    videoQuality: quality,
    downloadMode: audioOnly ? 'audio' : 'auto',
    audioFormat: audioOnly ? 'mp3' : 'best',
    isAudioOnly: audioOnly,
    isNoTTWatermark: true,
    disableMetadata: false,
  };

  try {
    const data = await fetchFromCobalt(payload);
    // Add ffmpeg availability info so frontend can show merge option
    data._ffmpeg = !!FFMPEG_PATH;
    sendJSON(res, 200, data);
  } catch(e) {
    console.error('[FETCH ERROR]', e.message);
    sendJSON(res, 500, { error: e.message });
  }
}

// ── Route: GET /api/stream?url=...&filename=... ───────────────────────────────
// Proxies media through our server so browser can force-download with filename
async function handleStream(req, res) {
  const { query } = url.parse(req.url, true);
  const targetUrl = decodeURIComponent(query.url || '');
  const filename  = decodeURIComponent(query.filename || 'media.mp4');

  if (!targetUrl) return sendJSON(res, 400, { error: 'Missing url' });
  console.log(`\n[STREAM] ${filename}`);

  try {
    const upstream = await httpFetch(targetUrl);
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Content-Disposition': `attachment; filename="${filename.replace(/[^a-zA-Z0-9._\- ]/g,'_')}"`,
      'Cache-Control': 'no-store',
    };
    if (upstream.headers['content-type'])   headers['Content-Type']   = upstream.headers['content-type'];
    if (upstream.headers['content-length']) headers['Content-Length'] = upstream.headers['content-length'];

    res.writeHead(200, headers);
    upstream.pipe(res);
  } catch(e) {
    console.error('[STREAM ERROR]', e.message);
    sendJSON(res, 502, { error: e.message });
  }
}

// ── Route: POST /api/merge ────────────────────────────────────────────────────
// Downloads video+audio separately, merges with FFmpeg, streams combined MP4
async function handleMerge(req, res) {
  if (!FFMPEG_PATH) return sendJSON(res, 501, { error: 'FFmpeg not available on this server. Install FFmpeg to enable merging.' });

  let body = '';
  req.on('data', c => body += c);
  await new Promise(r => req.on('end', r));

  let videoUrl, audioUrl, filename;
  try { ({ videoUrl, audioUrl, filename = 'video.mp4' } = JSON.parse(body)); }
  catch { return sendJSON(res, 400, { error: 'Invalid body' }); }
  if (!videoUrl || !audioUrl) return sendJSON(res, 400, { error: 'Need videoUrl and audioUrl' });

  const id = crypto.randomBytes(8).toString('hex');
  const tmpDir = os.tmpdir();
  const vPath   = path.join(tmpDir, `grabr_v_${id}`);
  const aPath   = path.join(tmpDir, `grabr_a_${id}`);
  const outPath = path.join(tmpDir, `grabr_o_${id}.mp4`);

  const cleanup = () => {
    for (const p of [vPath, aPath, outPath]) { try { fs.unlinkSync(p); } catch {} }
  };

  console.log(`\n[MERGE] ${filename}`);
  try {
    console.log('  1/3 Downloading video stream…');
    await downloadToFile(videoUrl, vPath);
    console.log('  2/3 Downloading audio stream…');
    await downloadToFile(audioUrl, aPath);
    console.log('  3/3 Merging with FFmpeg…');
    await mergeWithFFmpeg(vPath, aPath, outPath);

    const stat = fs.statSync(outPath);
    console.log(`  ✓ Done — ${Math.round(stat.size/1024/1024*10)/10} MB`);

    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="${filename.replace(/[^a-zA-Z0-9._\- ]/g,'_')}"`,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });

    const stream = fs.createReadStream(outPath);
    stream.pipe(res);
    stream.on('end', cleanup);
    stream.on('error', cleanup);
  } catch(e) {
    cleanup();
    console.error('[MERGE ERROR]', e.message);
    sendJSON(res, 500, { error: 'Merge failed: ' + e.message });
  }
}

// ── HTTP Server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept',
    });
    return res.end();
  }

  const { pathname } = url.parse(req.url);

  if (pathname === '/api/fetch'  && req.method === 'POST') return handleFetch(req, res);
  if (pathname === '/api/stream' && req.method === 'GET')  return handleStream(req, res);
  if (pathname === '/api/merge'  && req.method === 'POST') return handleMerge(req, res);

  if (pathname === '/api/health') {
    return sendJSON(res, 200, {
      status: 'ok',
      ffmpeg: !!FFMPEG_PATH,
      instances: COBALT_INSTANCES.length,
      platform: process.platform,
    });
  }

  sendFile(res, path.join(__dirname, '../public', pathname === '/' ? 'index.html' : pathname));
});

server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════╗
║  GRABR v2 — Media Downloader             ║
║  http://localhost:${PORT}                     ║
╠═══════════════════════════════════════════╣
║  FFmpeg : ${FFMPEG_PATH ? '✓ installed' : '✗ not found — install for YT 720p+'}
║  Cobalt : ${COBALT_INSTANCES.length} instances                     ║
╚═══════════════════════════════════════════╝
`);
});

server.on('error', e => console.error('Server error:', e.message));
