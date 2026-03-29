'use strict';

const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execSync } = require('child_process');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;

// ── Load .env ─────────────────────────────────────────────────────────────────
const envFile = path.join(__dirname, '../.env');
if (fs.existsSync(envFile)) {
    fs.readFileSync(envFile, 'utf8').split('\n').forEach(line => {
        const m = line.match(/^\s*([\w]+)\s*=\s*"?([^"#\n]*)"?\s*$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    });
}

const COBALT_INSTANCE = (process.env.COBALT_INSTANCE || '').replace(/\/$/, '');

// ── FFmpeg detection ──────────────────────────────────────────────────────────
let FFMPEG_PATH = null;
try {
    const which = process.platform === 'win32'
        ? execSync('where ffmpeg 2>nul').toString().trim().split('\n')[0]
        : execSync('which ffmpeg 2>/dev/null').toString().trim();
    if (which) FFMPEG_PATH = which;
} catch (_) { }
if (!FFMPEG_PATH) {
    for (const c of ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg']) {
        try { fs.accessSync(c); FFMPEG_PATH = c; break; } catch (_) { }
    }
}
console.log(FFMPEG_PATH ? `✓ FFmpeg: ${FFMPEG_PATH}` : '✗ FFmpeg not found');

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function makeRequest(method, targetUrl, jsonBody, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
        let hops = 0;
        const go = (reqUrl) => {
            if (++hops > 6) return reject(new Error('Too many redirects'));
            let parsed;
            try { parsed = new URL(reqUrl); }
            catch (e) { return reject(new Error('Invalid URL: ' + reqUrl)); }
            const mod = parsed.protocol === 'https:' ? https : http;
            const bodyBuf = jsonBody != null ? Buffer.from(JSON.stringify(jsonBody)) : null;
            const options = {
                hostname: parsed.hostname,
                port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
                path: parsed.pathname + parsed.search,
                method,
                headers: {
                    'User-Agent': 'grabr/3.0',
                    'Accept': 'application/json',
                    ...extraHeaders,
                    ...(bodyBuf ? {
                        'Content-Type': 'application/json',
                        'Content-Length': bodyBuf.length,
                    } : {}),
                },
                rejectUnauthorized: false,
                timeout: 25000,
            };
            const req = mod.request(options, res => {
                const loc = res.headers.location;
                if ([301, 302, 303, 307, 308].includes(res.statusCode) && loc) {
                    res.resume();
                    return go(loc.startsWith('http') ? loc : new URL(loc, reqUrl).href);
                }
                resolve(res);
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout connecting to ${parsed.hostname}`)); });
            if (bodyBuf) req.write(bodyBuf);
            req.end();
        };
        go(targetUrl);
    });
}

function postJSON(targetUrl, body) {
    return new Promise(async (resolve, reject) => {
        try {
            const res = await makeRequest('POST', targetUrl, body);
            let raw = '';
            res.on('data', c => { raw += c; });
            res.on('end', () => {
                try { resolve({ httpStatus: res.statusCode, data: JSON.parse(raw) }); }
                catch { reject(new Error(`Non-JSON response (HTTP ${res.statusCode}): ${raw.slice(0, 150)}`)); }
            });
            res.on('error', reject);
        } catch (e) { reject(e); }
    });
}

function getStream(targetUrl) {
    return makeRequest('GET', targetUrl, null, {});
}

/** HEAD request to get Content-Length without downloading. */
function headRequest(targetUrl) {
    return new Promise(async (resolve) => {
        try {
            const res = await makeRequest('HEAD', targetUrl, null, {});
            res.resume();
            const len = parseInt(res.headers['content-length'] || '0', 10);
            resolve(len || 0);
        } catch (_) {
            resolve(0);
        }
    });
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', c => { body += c; if (body.length > 2e6) req.destroy(new Error('Body too large')); });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

// ── Cobalt request ────────────────────────────────────────────────────────────
async function cobaltFetch(payload) {
    if (!COBALT_INSTANCE) {
        throw new Error(
            'No Cobalt instance configured. Deploy your own at https://railway.com/deploy/cobalt-media-downloader ' +
            'then add COBALT_INSTANCE env var.'
        );
    }

    const { httpStatus, data } = await postJSON(COBALT_INSTANCE + '/', payload);
    const errCode = data?.error?.code || data?.text || '';

    if (errCode.includes('auth') || httpStatus === 401 || httpStatus === 403) {
        throw new Error('Your Cobalt instance requires authentication.');
    }
    if (errCode.includes('rate') || httpStatus === 429) {
        throw new Error('Rate limited by Cobalt instance. Please wait and try again.');
    }
    if (httpStatus < 400 && data && data.status !== 'error') {
        return data;
    }
    throw new Error(interpretCobaltError(errCode || data?.status || `HTTP ${httpStatus}`));
}

function interpretCobaltError(code) {
    const c = String(code).toLowerCase();
    if (c.includes('private') || c.includes('login')) return 'This content is private or requires login.';
    if (c.includes('age')) return 'Age-restricted content cannot be downloaded.';
    if (c.includes('unavailable') || c.includes('not found')) return 'Content is unavailable or the link is wrong.';
    if (c.includes('rate') || c.includes('limit')) return 'Rate limited. Please wait a moment and try again.';
    return `Download failed: ${code}`;
}

// ── Quality probing ───────────────────────────────────────────────────────────
const ALL_QUALITIES = ['2160', '1440', '1080', '720', '480', '360', '240', '144'];

/**
 * Probe which qualities actually work for a given URL.
 * Returns array of { quality, url, audioUrl, hasAudio, needsMerge, size }
 */
async function probeQualities(mediaUrl) {
    const results = [];

    // First, try "max" to get the best quality and understand the media
    let maxData = null;
    try {
        maxData = await cobaltFetch({
            url: mediaUrl,
            downloadMode: 'auto',
            videoQuality: 'max',
            audioFormat: 'best',
        });
    } catch (e) {
        throw e; // If max fails, the URL is bad
    }

    // Detect platform
    const lUrl = mediaUrl.toLowerCase();
    const isYouTube = lUrl.includes('youtu');

    // For non-YouTube, just return max
    if (!isYouTube) {
        const size = maxData.url ? await headRequest(maxData.url) : 0;
        return [{
            quality: 'max',
            label: 'Best',
            url: maxData.url || null,
            audioUrl: maxData.audio || null,
            picker: maxData.picker || null,
            hasAudio: true,
            needsMerge: false,
            size,
            status: maxData.status,
        }];
    }

    // For YouTube: probe each quality in parallel (with concurrency limit)
    const probeOne = async (q) => {
        try {
            const data = await cobaltFetch({
                url: mediaUrl,
                downloadMode: 'auto',
                videoQuality: q,
                audioFormat: 'best',
            });

            if (!data || data.status === 'error') return null;

            // Determine if merge is needed
            // Cobalt returns status='tunnel' with audio separate when it needs merging
            const needsMerge = !!(data.audio && data.url && data.audio !== data.url);
            const hasAudio = !needsMerge || !!FFMPEG_PATH;

            // Get size
            let size = 0;
            if (data.url) {
                size = await headRequest(data.url);
                // If merge needed, add audio size
                if (needsMerge && data.audio) {
                    const aSize = await headRequest(data.audio);
                    size += aSize;
                }
            }

            return {
                quality: q,
                label: q + 'p',
                url: data.url || null,
                audioUrl: data.audio || null,
                hasAudio,
                needsMerge,
                size,
                status: data.status,
            };
        } catch (_) {
            return null; // Quality not available
        }
    };

    // Also probe max for YouTube
    const maxNeedsMerge = !!(maxData.audio && maxData.url && maxData.audio !== maxData.url);
    let maxSize = 0;
    if (maxData.url) {
        maxSize = await headRequest(maxData.url);
        if (maxNeedsMerge && maxData.audio) {
            const aSize = await headRequest(maxData.audio);
            maxSize += aSize;
        }
    }

    results.push({
        quality: 'max',
        label: 'Best',
        url: maxData.url || null,
        audioUrl: maxData.audio || null,
        hasAudio: !maxNeedsMerge || !!FFMPEG_PATH,
        needsMerge: maxNeedsMerge,
        size: maxSize,
        status: maxData.status,
    });

    // Probe all qualities in batches of 3
    const batchSize = 3;
    for (let i = 0; i < ALL_QUALITIES.length; i += batchSize) {
        const batch = ALL_QUALITIES.slice(i, i + batchSize);
        const batchResults = await Promise.all(batch.map(probeOne));
        batchResults.forEach(r => { if (r) results.push(r); });
    }

    // Deduplicate by URL (some qualities map to same file)
    const seen = new Set();
    const deduped = [];
    for (const r of results) {
        const key = r.url || r.quality;
        if (!seen.has(key)) {
            seen.add(key);
            deduped.push(r);
        }
    }

    return deduped;
}

// ── FFmpeg helpers ────────────────────────────────────────────────────────────
function downloadToFile(srcUrl, destPath) {
    return new Promise(async (resolve, reject) => {
        try {
            const res = await getStream(srcUrl);
            if (res.statusCode >= 400) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
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
        const proc = spawn(FFMPEG_PATH, [
            '-y', '-i', videoPath, '-i', audioPath,
            '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
            '-map', '0:v:0', '-map', '1:a:0',
            '-movflags', '+faststart', outputPath,
        ], { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        proc.stderr.on('data', d => { stderr += d; });
        proc.on('close', code => {
            if (code === 0) resolve();
            else reject(new Error(`FFmpeg exit ${code}: ${stderr.slice(-400)}`));
        });
        proc.on('error', reject);
    });
}

// ── Response senders ──────────────────────────────────────────────────────────
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
        '.html': 'text/html; charset=utf-8', '.css': 'text/css',
        '.js': 'application/javascript', '.ico': 'image/x-icon', '.png': 'image/png',
    };
    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': mime[path.extname(filePath)] || 'text/plain' });
        res.end(data);
    });
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * NEW: /api/probe — probe all available qualities for a URL
 * Returns array of available quality objects with size info
 */
async function handleProbe(req, res) {
    let mediaUrl;
    try {
        const b = JSON.parse(await readBody(req));
        mediaUrl = b.url;
    } catch { return sendJSON(res, 400, { error: 'Invalid JSON body' }); }
    if (!mediaUrl) return sendJSON(res, 400, { error: 'Missing url field' });

    console.log(`\n[PROBE] ${mediaUrl}`);

    try {
        const qualities = await probeQualities(mediaUrl);
        console.log(`  ✓ Found ${qualities.length} qualities`);
        sendJSON(res, 200, { qualities, ffmpeg: !!FFMPEG_PATH });
    } catch (e) {
        console.error('[PROBE ERROR]', e.message);
        sendJSON(res, 500, { error: e.message });
    }
}

async function handleFetch(req, res) {
    let mediaUrl, quality, audioOnly;
    try {
        const b = JSON.parse(await readBody(req));
        mediaUrl = b.url; quality = b.quality || 'max'; audioOnly = !!b.audioOnly;
    } catch { return sendJSON(res, 400, { error: 'Invalid JSON body' }); }
    if (!mediaUrl) return sendJSON(res, 400, { error: 'Missing url field' });

    console.log(`\n[FETCH] ${mediaUrl} | quality=${quality} audioOnly=${audioOnly}`);

    const payload = {
        url: mediaUrl,
        downloadMode: audioOnly ? 'audio' : 'auto',
        videoQuality: quality === 'max' ? 'max' : String(quality),
        audioFormat: audioOnly ? 'mp3' : 'best',
    };

    try {
        const data = await cobaltFetch(payload);
        data._ffmpeg = !!FFMPEG_PATH;
        sendJSON(res, 200, data);
        console.log(JSON.stringify(data, null, 2));
    } catch (e) {
        console.error('[FETCH ERROR]', e.message);
        sendJSON(res, 500, { error: e.message });
    }
}

async function handleStream(req, res) {
    const { searchParams } = new URL(req.url, 'http://localhost');
    const targetUrl = decodeURIComponent(searchParams.get('url') || '');
    const filename = decodeURIComponent(searchParams.get('filename') || 'media.mp4')
        .replace(/[^a-zA-Z0-9._\- ]/g, '_');

    if (!targetUrl) return sendJSON(res, 400, { error: 'Missing url parameter' });
    console.log(`\n[STREAM] ${filename}`);

    try {
        const upstream = await getStream(targetUrl);
        if (upstream.statusCode >= 400) {
            upstream.resume();
            return sendJSON(res, 502, { error: `Upstream HTTP ${upstream.statusCode}` });
        }
        const headers = {
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-store',
            'Content-Disposition': `attachment; filename="${filename}"`,
        };
        if (upstream.headers['content-type']) headers['Content-Type'] = upstream.headers['content-type'];
        if (upstream.headers['content-length']) headers['Content-Length'] = upstream.headers['content-length'];
        res.writeHead(200, headers);
        upstream.pipe(res);
        upstream.on('error', () => { if (!res.headersSent) res.destroy(); });
    } catch (e) {
        console.error('[STREAM ERROR]', e.message);
        if (!res.headersSent) sendJSON(res, 502, { error: e.message });
    }
}

async function handleMerge(req, res) {
    if (!FFMPEG_PATH) return sendJSON(res, 501, { error: 'FFmpeg not installed on server.' });
    let videoUrl, audioUrl, filename;
    try {
        ({ videoUrl, audioUrl, filename = 'video.mp4' } = JSON.parse(await readBody(req)));
    } catch { return sendJSON(res, 400, { error: 'Invalid JSON' }); }
    if (!videoUrl || !audioUrl) return sendJSON(res, 400, { error: 'Need videoUrl and audioUrl' });

    const id = crypto.randomBytes(8).toString('hex');
    const tmp = os.tmpdir();
    const vp = path.join(tmp, `grabr_v_${id}`);
    const ap = path.join(tmp, `grabr_a_${id}`);
    const op = path.join(tmp, `grabr_o_${id}.mp4`);
    const cleanup = () => [vp, ap, op].forEach(p => { try { fs.unlinkSync(p); } catch (_) { } });
    const safe = filename.replace(/[^a-zA-Z0-9._\- ]/g, '_');

    console.log(`\n[MERGE] ${safe}`);
    try {
        console.log('  Downloading video stream…');
        await downloadToFile(videoUrl, vp);
        console.log('  Downloading audio stream…');
        await downloadToFile(audioUrl, ap);
        console.log('  Merging with FFmpeg…');
        await mergeWithFFmpeg(vp, ap, op);

        const { size } = fs.statSync(op);
        if (size === 0) {
            cleanup();
            return sendJSON(res, 500, { error: 'Merge produced empty file. FFmpeg failed silently.' });
        }

        console.log(`  ✓ ${(size / 1024 / 1024).toFixed(1)} MB`);
        res.writeHead(200, {
            'Content-Type': 'video/mp4', 'Content-Length': size,
            'Content-Disposition': `attachment; filename="${safe}"`,
            'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store',
        });
        const stream = fs.createReadStream(op);
        stream.pipe(res);
        stream.on('end', cleanup);
        stream.on('error', cleanup);
    } catch (e) {
        cleanup();
        console.error('[MERGE ERROR]', e.message);
        if (!res.headersSent) sendJSON(res, 500, { error: 'Merge failed: ' + e.message });
    }
}

function handleHealth(res) {
    sendJSON(res, 200, {
        status: 'ok',
        ffmpeg: !!FFMPEG_PATH,
        cobaltInstance: COBALT_INSTANCE || null,
        cobaltConfigured: !!COBALT_INSTANCE,
        platform: process.platform,
        node: process.version,
    });
}

// ── HTTP Server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Accept',
            'Access-Control-Max-Age': '86400',
        });
        return res.end();
    }

    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; }
    catch { pathname = '/'; }

    if (pathname === '/api/probe' && req.method === 'POST') return handleProbe(req, res);
    if (pathname === '/api/fetch' && req.method === 'POST') return handleFetch(req, res);
    if (pathname === '/api/stream' && req.method === 'GET') return handleStream(req, res);
    if (pathname === '/api/merge' && req.method === 'POST') return handleMerge(req, res);
    if (pathname === '/api/health' && req.method === 'GET') return handleHealth(res);

    const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
    sendFile(res, path.join(__dirname, '../public', safePath === '/' ? 'index.html' : safePath));
});

server.on('error', e => {
    if (e.code === 'EADDRINUSE') console.error(`✗ Port ${PORT} in use. Set PORT=xxxx`);
    else console.error('Server error:', e.message);
    process.exit(1);
});

server.listen(PORT, () => {
    const instanceLine = COBALT_INSTANCE
        ? `✓ ${COBALT_INSTANCE}`
        : '✗ NOT SET — set COBALT_INSTANCE env var!';

    console.log(`
╔══════════════════════════════════════════════════════╗
║  GRABR v3.1 — Media Downloader Backend               ║
║  http://localhost:${PORT}                                 ║
╠══════════════════════════════════════════════════════╣
║  FFmpeg  : ${FFMPEG_PATH ? '✓ ' + FFMPEG_PATH.padEnd(38) : '✗ not found'.padEnd(42)}║
║  Cobalt  : ${instanceLine.padEnd(42)}║
╚══════════════════════════════════════════════════════╝
`);
});

