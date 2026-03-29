'use strict';

/**
 * GRABR v5.0 — Fixed Backend
 *
 * Fixes:
 *  - Auto-installs yt-dlp on Render.com (and any Linux server)
 *  - Returns thumbnail URLs
 *  - Proper quality detection with real sizes
 *  - No 0-byte downloads (fresh URL fetch on every download click)
 *  - Audio-only auto-detected per format (no manual mode toggle)
 */

const http    = require('http');
const https   = require('https');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');
const { spawn, execSync, spawnSync } = require('child_process');
const crypto  = require('crypto');

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

// ── Auto-install yt-dlp ───────────────────────────────────────────────────────
function autoInstallYtdlp() {
    // Try pip first (works on Render)
    const pipCmds = ['pip3', 'pip'];
    for (const pip of pipCmds) {
        try {
            const r = spawnSync(pip, ['install', '--quiet', '--upgrade', 'yt-dlp'], {
                timeout: 120000, stdio: 'pipe'
            });
            if (r.status === 0) {
                console.log(`✓ yt-dlp installed via ${pip}`);
                return true;
            }
        } catch (_) {}
    }

    // Try downloading binary directly (fallback)
    const binPath = '/usr/local/bin/yt-dlp';
    try {
        const r = spawnSync('curl', [
            '-L', '--silent', '--output', binPath,
            'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp'
        ], { timeout: 60000, stdio: 'pipe' });
        if (r.status === 0) {
            spawnSync('chmod', ['+x', binPath]);
            console.log('✓ yt-dlp binary downloaded');
            return true;
        }
    } catch (_) {}

    // Try wget
    try {
        const binPathW = '/usr/local/bin/yt-dlp';
        const r = spawnSync('wget', [
            '-q', '-O', binPathW,
            'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp'
        ], { timeout: 60000, stdio: 'pipe' });
        if (r.status === 0) {
            spawnSync('chmod', ['+x', binPathW]);
            console.log('✓ yt-dlp binary downloaded via wget');
            return true;
        }
    } catch (_) {}

    return false;
}

// ── Tool detection ────────────────────────────────────────────────────────────
function findBin(name) {
    try {
        const w = process.platform === 'win32'
            ? execSync(`where ${name} 2>nul`).toString().trim().split('\n')[0]
            : execSync(`which ${name} 2>/dev/null`).toString().trim();
        if (w) return w;
    } catch (_) {}
    for (const c of [
        `/usr/bin/${name}`, `/usr/local/bin/${name}`,
        `/opt/homebrew/bin/${name}`, `${os.homedir()}/.local/bin/${name}`,
        `${os.homedir()}/.local/share/pipx/venvs/yt-dlp/bin/${name}`,
    ]) {
        try { fs.accessSync(c, fs.constants.X_OK); return c; } catch (_) {}
    }
    // Also check python -m yt_dlp style
    if (name === 'yt-dlp') {
        try {
            const r = spawnSync('python3', ['-m', 'yt_dlp', '--version'], { timeout: 5000, stdio: 'pipe' });
            if (r.status === 0) return 'python3 -m yt_dlp'; // special marker
        } catch (_) {}
    }
    return null;
}

let FFMPEG_PATH = findBin('ffmpeg');
let YTDLP_PATH  = findBin('yt-dlp');

console.log(FFMPEG_PATH ? `✓ FFmpeg : ${FFMPEG_PATH}` : '✗ FFmpeg not found');
console.log(YTDLP_PATH  ? `✓ yt-dlp : ${YTDLP_PATH}`  : '✗ yt-dlp not found — attempting auto-install…');

if (!YTDLP_PATH) {
    const ok = autoInstallYtdlp();
    if (ok) {
        YTDLP_PATH = findBin('yt-dlp');
        if (!YTDLP_PATH) {
            // Maybe installed as module
            try {
                const r = spawnSync('python3', ['-m', 'yt_dlp', '--version'], { timeout: 8000, stdio: 'pipe' });
                if (r.status === 0) YTDLP_PATH = '__python_module__';
            } catch (_) {}
        }
        console.log(YTDLP_PATH ? `✓ yt-dlp now available: ${YTDLP_PATH}` : '✗ yt-dlp still not found after install');
    }
}

// Helper to spawn yt-dlp regardless of install method
function spawnYtdlp(args, opts) {
    if (YTDLP_PATH === '__python_module__') {
        return spawn('python3', ['-m', 'yt_dlp', ...args], opts);
    }
    return spawn(YTDLP_PATH, args, opts);
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function makeRequest(method, targetUrl, jsonBody, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
        let hops = 0;
        const go = (reqUrl) => {
            if (++hops > 8) return reject(new Error('Too many redirects'));
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
                    'User-Agent': 'grabr/5.0',
                    'Accept': 'application/json',
                    ...extraHeaders,
                    ...(bodyBuf ? { 'Content-Type': 'application/json', 'Content-Length': bodyBuf.length } : {}),
                },
                rejectUnauthorized: false,
                timeout: 30000,
            };
            const req = mod.request(options, res => {
                const loc = res.headers.location;
                if ([301,302,303,307,308].includes(res.statusCode) && loc) {
                    res.resume();
                    return go(loc.startsWith('http') ? loc : new URL(loc, reqUrl).href);
                }
                resolve(res);
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout: ${parsed.hostname}`)); });
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
                catch { reject(new Error(`Non-JSON (HTTP ${res.statusCode}): ${raw.slice(0,300)}`)); }
            });
            res.on('error', reject);
        } catch (e) { reject(e); }
    });
}

function getStream(targetUrl) {
    return makeRequest('GET', targetUrl, null, {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
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

// ── yt-dlp metadata ───────────────────────────────────────────────────────────
function ytdlpGetFormats(videoUrl) {
    return new Promise((resolve) => {
        if (!YTDLP_PATH) return resolve(null);

        const proc = spawnYtdlp([
            '--dump-json', '--no-playlist', '--no-warnings',
            '--skip-download',
            '--no-check-certificates',
            videoUrl,
        ], { timeout: 45000 });

        let stdout = '', stderr = '';
        proc.stdout.on('data', d => { stdout += d; });
        proc.stderr.on('data', d => { stderr += d; });

        proc.on('close', (code) => {
            if (code !== 0 || !stdout.trim()) {
                console.warn('[yt-dlp] failed code=' + code, stderr.slice(0,300));
                return resolve(null);
            }
            try {
                const info = JSON.parse(stdout);
                const title    = info.title    || 'video';
                const uploader = info.uploader || info.channel || info.uploader_id || '';
                const duration = info.duration || 0;

                // Thumbnail: prefer a mid-size one
                let thumbnail = info.thumbnail || '';
                if (Array.isArray(info.thumbnails) && info.thumbnails.length > 0) {
                    // Sort by preference: prefer url containing 'maxresdefault' or 'hqdefault'
                    const sorted = [...info.thumbnails].sort((a,b) => (b.preference||0)-(a.preference||0));
                    thumbnail = sorted[0].url || thumbnail;
                }

                // Group video formats by height
                const heightMap = new Map();
                for (const f of (info.formats || [])) {
                    const h = f.height;
                    if (!h || h < 100 || !f.vcodec || f.vcodec === 'none') continue;
                    const fsize = f.filesize || f.filesize_approx || 0;
                    const existing = heightMap.get(h);
                    if (!existing || fsize > (existing.filesize || 0)) {
                        heightMap.set(h, {
                            height: h, filesize: fsize,
                            has_audio: !!(f.acodec && f.acodec !== 'none'),
                            ext: f.ext || 'mp4',
                            tbr: f.tbr || 0,
                        });
                    }
                }

                // Best audio-only size (for merged formats)
                const bestAudio = (info.formats || [])
                    .filter(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'))
                    .reduce((b, f) => {
                        const s = f.filesize || f.filesize_approx || 0;
                        return (!b || s > (b.filesize || 0)) ? f : b;
                    }, null);
                const audioSize = bestAudio ? (bestAudio.filesize || bestAudio.filesize_approx || 0) : 0;

                const qualities = Array.from(heightMap.values())
                    .sort((a, b) => b.height - a.height)
                    .map(f => ({
                        quality: String(f.height),
                        label: f.height + 'p',
                        needsMerge: !f.has_audio,
                        hasAudio: f.has_audio || !!FFMPEG_PATH,
                        size: f.filesize + (!f.has_audio ? audioSize : 0),
                        ext: f.ext,
                    }));

                resolve({ title, uploader, duration, thumbnail, qualities });
            } catch (e) {
                console.warn('[yt-dlp] parse error:', e.message);
                resolve(null);
            }
        });
        proc.on('error', e => { console.warn('[yt-dlp] spawn error:', e.message); resolve(null); });
    });
}

// ── Cobalt ────────────────────────────────────────────────────────────────────
async function cobaltFetch(payload) {
    if (!COBALT_INSTANCE) throw new Error('No Cobalt instance configured. Set COBALT_INSTANCE env var.');
    const { httpStatus, data } = await postJSON(COBALT_INSTANCE + '/', payload);
    const errCode = data?.error?.code || data?.text || '';
    if (errCode.includes('auth') || httpStatus === 401 || httpStatus === 403)
        throw new Error('Cobalt instance requires authentication.');
    if (errCode.includes('rate') || httpStatus === 429)
        throw new Error('Rate limited. Please wait and try again.');
    if (httpStatus < 400 && data && data.status !== 'error') return data;
    throw new Error(interpretCobaltError(errCode || data?.status || `HTTP ${httpStatus}`));
}

function interpretCobaltError(code) {
    const c = String(code).toLowerCase();
    if (c.includes('private') || c.includes('login')) return 'Content is private or requires login.';
    if (c.includes('age'))   return 'Age-restricted content cannot be downloaded.';
    if (c.includes('unavailable') || c.includes('not found')) return 'Content unavailable or wrong link.';
    if (c.includes('rate')  || c.includes('limit')) return 'Rate limited. Wait a moment and retry.';
    return `Download failed: ${code}`;
}

// ── /api/info ─────────────────────────────────────────────────────────────────
async function handleInfo(req, res) {
    let mediaUrl;
    try { ({ url: mediaUrl } = JSON.parse(await readBody(req))); }
    catch { return sendJSON(res, 400, { error: 'Invalid JSON' }); }
    if (!mediaUrl) return sendJSON(res, 400, { error: 'Missing url' });

    console.log(`\n[INFO] ${mediaUrl}`);
    const isYouTube = /youtu\.?be/.test(mediaUrl);

    // YouTube: use yt-dlp for accurate info + thumbnail
    if (isYouTube && YTDLP_PATH) {
        const meta = await ytdlpGetFormats(mediaUrl);
        if (meta && meta.qualities.length > 0) {
            console.log(`  ✓ "${meta.title}" — ${meta.qualities.length} qualities, thumb: ${meta.thumbnail ? 'yes' : 'no'}`);
            return sendJSON(res, 200, {
                title: meta.title, uploader: meta.uploader,
                duration: meta.duration, thumbnail: meta.thumbnail,
                qualities: meta.qualities,
                ffmpeg: !!FFMPEG_PATH, source: 'ytdlp',
            });
        }
        console.log('  ⚠ yt-dlp returned no formats, falling back to Cobalt');
    }

    // Non-YouTube or fallback
    try {
        const data = await cobaltFetch({
            url: mediaUrl, downloadMode: 'auto',
            videoQuality: 'max', audioFormat: 'best',
        });

        if ((data.status === 'picker' || data.picker) && Array.isArray(data.picker)) {
            return sendJSON(res, 200, {
                title: 'Instagram Post', uploader: '',
                picker: data.picker, ffmpeg: !!FFMPEG_PATH, source: 'cobalt',
            });
        }
        if (data.url) {
            const needsMerge = !!(data.audio && data.url && data.audio !== data.url);
            return sendJSON(res, 200, {
                title: data.filename || 'video', uploader: '',
                thumbnail: '', duration: 0,
                qualities: [{ quality: 'max', label: 'Best', needsMerge, hasAudio: !needsMerge || !!FFMPEG_PATH, size: 0, ext: 'mp4' }],
                ffmpeg: !!FFMPEG_PATH, source: 'cobalt',
            });
        }
        throw new Error('No downloadable URL found');
    } catch (e) {
        console.error('[INFO ERROR]', e.message);
        return sendJSON(res, 500, { error: e.message });
    }
}

// ── /api/fetch ────────────────────────────────────────────────────────────────
async function handleFetch(req, res) {
    let mediaUrl, quality, audioOnly;
    try {
        const b = JSON.parse(await readBody(req));
        mediaUrl = b.url; quality = b.quality || 'max'; audioOnly = !!b.audioOnly;
    } catch { return sendJSON(res, 400, { error: 'Invalid JSON body' }); }
    if (!mediaUrl) return sendJSON(res, 400, { error: 'Missing url' });

    console.log(`\n[FETCH] ${mediaUrl} | q=${quality} audio=${audioOnly}`);
    try {
        const data = await cobaltFetch({
            url: mediaUrl,
            downloadMode: audioOnly ? 'audio' : 'auto',
            videoQuality: quality === 'max' ? 'max' : String(quality),
            audioFormat: audioOnly ? 'mp3' : 'best',
        });
        data._ffmpeg = !!FFMPEG_PATH;
        sendJSON(res, 200, data);
    } catch (e) {
        console.error('[FETCH ERROR]', e.message);
        sendJSON(res, 500, { error: e.message });
    }
}

// ── /api/stream ───────────────────────────────────────────────────────────────
async function handleStream(req, res) {
    const { searchParams } = new URL(req.url, 'http://localhost');
    const targetUrl = decodeURIComponent(searchParams.get('url') || '');
    const filename  = decodeURIComponent(searchParams.get('filename') || 'media.mp4')
        .replace(/[^a-zA-Z0-9._\- ]/g, '_');
    if (!targetUrl) return sendJSON(res, 400, { error: 'Missing url' });
    console.log(`\n[STREAM] ${filename}`);
    try {
        const upstream = await getStream(targetUrl);
        if (upstream.statusCode >= 400) {
            upstream.resume();
            return sendJSON(res, 502, { error: `Upstream HTTP ${upstream.statusCode} — URL may have expired. Click GRAB IT again.` });
        }
        const headers = {
            'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'Content-Type': upstream.headers['content-type'] || 'video/mp4',
        };
        if (upstream.headers['content-length']) headers['Content-Length'] = upstream.headers['content-length'];
        res.writeHead(200, headers);
        upstream.pipe(res);
        upstream.on('error', () => { if (!res.headersSent) res.destroy(); });
    } catch (e) {
        console.error('[STREAM ERROR]', e.message);
        if (!res.headersSent) sendJSON(res, 502, { error: e.message });
    }
}

// ── /api/merge ────────────────────────────────────────────────────────────────
function dlToFile(srcUrl, destPath) {
    return new Promise(async (resolve, reject) => {
        try {
            const res = await getStream(srcUrl);
            if (res.statusCode >= 400) { res.resume(); return reject(new Error(`CDN HTTP ${res.statusCode} — URL expired. Click GRAB IT again.`)); }
            const out = fs.createWriteStream(destPath);
            res.pipe(out);
            out.on('finish', resolve);
            out.on('error', reject);
            res.on('error', reject);
        } catch (e) { reject(e); }
    });
}

function runFFmpeg(vp, ap, op) {
    return new Promise((resolve, reject) => {
        const proc = spawn(FFMPEG_PATH, [
            '-y', '-i', vp, '-i', ap,
            '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
            '-map', '0:v:0', '-map', '1:a:0', '-movflags', '+faststart', op,
        ], { stdio: ['ignore','ignore','pipe'] });
        let stderr = '';
        proc.stderr.on('data', d => { stderr += d; });
        proc.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg exit ${code}: ${stderr.slice(-500)}`)));
        proc.on('error', reject);
    });
}

async function handleMerge(req, res) {
    if (!FFMPEG_PATH) return sendJSON(res, 501, { error: 'FFmpeg not installed on server.' });
    let videoUrl, audioUrl, filename;
    try { ({ videoUrl, audioUrl, filename = 'video.mp4' } = JSON.parse(await readBody(req))); }
    catch { return sendJSON(res, 400, { error: 'Invalid JSON' }); }
    if (!videoUrl || !audioUrl) return sendJSON(res, 400, { error: 'Need videoUrl and audioUrl' });

    const id = crypto.randomBytes(8).toString('hex');
    const tmp = os.tmpdir();
    const vp = path.join(tmp, `grabr_v_${id}`);
    const ap = path.join(tmp, `grabr_a_${id}`);
    const op = path.join(tmp, `grabr_o_${id}.mp4`);
    const cleanup = () => [vp,ap,op].forEach(p => { try { fs.unlinkSync(p); } catch(_){} });
    const safe = filename.replace(/[^a-zA-Z0-9._\- ]/g, '_');

    console.log(`\n[MERGE] ${safe}`);
    try {
        console.log('  ↓ video…');
        await dlToFile(videoUrl, vp);
        const vs = fs.statSync(vp).size;
        if (vs === 0) throw new Error('Video stream is 0 bytes. The CDN URL expired — click GRAB IT again, then download immediately.');

        console.log(`  ↓ audio… (video ${(vs/1e6).toFixed(1)} MB)`);
        await dlToFile(audioUrl, ap);
        const as_ = fs.statSync(ap).size;
        if (as_ === 0) throw new Error('Audio stream is 0 bytes. The CDN URL expired — click GRAB IT again.');

        console.log('  ⚙ merging with FFmpeg…');
        await runFFmpeg(vp, ap, op);

        const { size } = fs.statSync(op);
        if (size === 0) { cleanup(); return sendJSON(res, 500, { error: 'FFmpeg produced empty file.' }); }

        console.log(`  ✓ ${(size/1e6).toFixed(1)} MB`);
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
        if (!res.headersSent) sendJSON(res, 500, { error: e.message });
    }
}

function handleHealth(res) {
    sendJSON(res, 200, {
        status: 'ok', ffmpeg: !!FFMPEG_PATH, ytdlp: !!YTDLP_PATH,
        cobaltInstance: COBALT_INSTANCE || null, cobaltConfigured: !!COBALT_INSTANCE,
        platform: process.platform, node: process.version,
    });
}

// ── HTTP Server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin':'*',
            'Access-Control-Allow-Methods':'GET,POST,OPTIONS',
            'Access-Control-Allow-Headers':'Content-Type,Accept',
            'Access-Control-Max-Age':'86400',
        });
        return res.end();
    }
    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { pathname = '/'; }

    if (pathname === '/api/info'   && req.method === 'POST') return handleInfo(req, res);
    if (pathname === '/api/fetch'  && req.method === 'POST') return handleFetch(req, res);
    if (pathname === '/api/stream' && req.method === 'GET')  return handleStream(req, res);
    if (pathname === '/api/merge'  && req.method === 'POST') return handleMerge(req, res);
    if (pathname === '/api/health' && req.method === 'GET')  return handleHealth(res);

    const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
    sendFile(res, path.join(__dirname, '../public', safePath === '/' ? 'index.html' : safePath));
});

server.on('error', e => { console.error('Server error:', e.message); process.exit(1); });
server.listen(PORT, () => {
    console.log(`\n╔══════════════════════════════════════════════════════╗
║  GRABR v5.0                   http://localhost:${PORT}  ║
╠══════════════════════════════════════════════════════╣
║  FFmpeg : ${(FFMPEG_PATH  || '✗ not found').padEnd(42)}║
║  yt-dlp : ${(YTDLP_PATH  || '✗ not found').padEnd(42)}║
║  Cobalt : ${(COBALT_INSTANCE || '✗ set COBALT_INSTANCE env var').padEnd(42)}║
╚══════════════════════════════════════════════════════╝\n`);
});