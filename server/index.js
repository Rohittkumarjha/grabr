'use strict';

/**
 * GRABR v6.0 — yt-dlp NATIVE backend
 *
 * ROOT CAUSE OF 0-BYTE DOWNLOADS:
 *   Cobalt returns short-lived CDN URLs that expire in ~6 min.
 *   By the time user clicks download, URL is dead.
 *
 * FIX:
 *   YouTube → yt-dlp downloads directly to server temp dir, then streams to browser.
 *             No Cobalt involved. No expiring URLs.
 *   Instagram/TikTok → Cobalt (no choice, yt-dlp can't always handle these)
 *
 * DEBUG:
 *   Every step is logged with [TAG] prefix. Check Render logs for full trace.
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
    console.log('[SETUP] yt-dlp not found — trying auto-install...');
    const cmds = [
        ['pip3', ['install', '--quiet', '--upgrade', 'yt-dlp', '--break-system-packages']],
        ['pip3', ['install', '--quiet', '--upgrade', 'yt-dlp']],
        ['pip',  ['install', '--quiet', '--upgrade', 'yt-dlp']],
        ['python3', ['-m', 'pip', 'install', '--quiet', '--upgrade', 'yt-dlp']],
    ];
    for (const [cmd, args] of cmds) {
        try {
            const r = spawnSync(cmd, args, { timeout: 120000, stdio: 'pipe' });
            if (r.status === 0) { console.log(`[SETUP] ✓ installed via ${cmd}`); return true; }
            console.log(`[SETUP] ${cmd} exit=${r.status}: ${(r.stderr||Buffer.from('')).toString().slice(0,80)}`);
        } catch (e) { console.log(`[SETUP] ${cmd} threw: ${e.message}`); }
    }
    // Binary download
    const bin = '/usr/local/bin/yt-dlp';
    for (const [tool, args] of [
        ['curl', ['-L', '--silent', '-o', bin, 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp']],
        ['wget', ['-q', '-O', bin, 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp']],
    ]) {
        try {
            const r = spawnSync(tool, args, { timeout: 60000, stdio: 'pipe' });
            if (r.status === 0) { spawnSync('chmod',['+x',bin]); console.log(`[SETUP] ✓ binary via ${tool}`); return true; }
        } catch (_) {}
    }
    return false;
}

// ── Tool detection ────────────────────────────────────────────────────────────
function findBin(name) {
    try {
        const cmd = process.platform === 'win32' ? `where ${name} 2>nul` : `which ${name} 2>/dev/null`;
        const w = execSync(cmd).toString().trim().split('\n')[0].trim();
        if (w) return w;
    } catch (_) {}
    for (const c of [
        `/usr/bin/${name}`, `/usr/local/bin/${name}`, `/opt/homebrew/bin/${name}`,
        `${os.homedir()}/.local/bin/${name}`, `/root/.local/bin/${name}`,
    ]) { try { fs.accessSync(c, fs.constants.X_OK); return c; } catch (_) {} }
    return null;
}

let FFMPEG_PATH = findBin('ffmpeg');
let YTDLP_PATH  = findBin('yt-dlp');
let YTDLP_MODE  = 'binary';

// Check python module fallback
if (!YTDLP_PATH) {
    try {
        const r = spawnSync('python3', ['-m', 'yt_dlp', '--version'], { timeout: 8000, stdio: 'pipe' });
        if (r.status === 0) { YTDLP_PATH = 'python3'; YTDLP_MODE = 'module'; }
    } catch (_) {}
}

if (!YTDLP_PATH) {
    autoInstallYtdlp();
    YTDLP_PATH = findBin('yt-dlp');
    if (!YTDLP_PATH) {
        try {
            const r = spawnSync('python3', ['-m', 'yt_dlp', '--version'], { timeout: 8000, stdio: 'pipe' });
            if (r.status === 0) { YTDLP_PATH = 'python3'; YTDLP_MODE = 'module'; }
        } catch (_) {}
    }
}

const YTDLP_CMD = YTDLP_MODE === 'module' ? 'python3 -m yt_dlp' : (YTDLP_PATH || 'yt-dlp');
console.log('\n' + '='.repeat(56));
console.log(` FFmpeg : ${FFMPEG_PATH || 'NOT FOUND'}`);
console.log(` yt-dlp : ${YTDLP_PATH ? YTDLP_CMD : 'NOT FOUND'}`);
console.log(` Cobalt : ${COBALT_INSTANCE || 'not configured'}`);
console.log('='.repeat(56) + '\n');

function spawnYtdlp(args, opts = {}) {
    if (YTDLP_MODE === 'module') return spawn('python3', ['-m', 'yt_dlp', ...args], opts);
    return spawn(YTDLP_PATH, args, opts);
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function makeRequest(method, targetUrl, jsonBody, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
        let hops = 0;
        const go = (url) => {
            if (++hops > 8) return reject(new Error('Too many redirects'));
            let p; try { p = new URL(url); } catch (e) { return reject(e); }
            const mod = p.protocol === 'https:' ? https : http;
            const buf = jsonBody != null ? Buffer.from(JSON.stringify(jsonBody)) : null;
            const opts = {
                hostname: p.hostname,
                port: p.port || (p.protocol === 'https:' ? 443 : 80),
                path: p.pathname + p.search,
                method,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'application/json, */*',
                    ...extraHeaders,
                    ...(buf ? { 'Content-Type': 'application/json', 'Content-Length': buf.length } : {}),
                },
                rejectUnauthorized: false,
                timeout: 30000,
            };
            const req = mod.request(opts, res => {
                const loc = res.headers.location;
                if ([301,302,303,307,308].includes(res.statusCode) && loc) {
                    res.resume();
                    return go(loc.startsWith('http') ? loc : new URL(loc, url).href);
                }
                resolve(res);
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout: ${p.hostname}`)); });
            if (buf) req.write(buf);
            req.end();
        };
        go(targetUrl);
    });
}

function postJSON(url, body) {
    return new Promise(async (resolve, reject) => {
        try {
            const res = await makeRequest('POST', url, body);
            let raw = '';
            res.on('data', c => { raw += c; });
            res.on('end', () => {
                console.log(`[HTTP-POST] ${url} → HTTP ${res.statusCode} | body: ${raw.slice(0,200)}`);
                try { resolve({ httpStatus: res.statusCode, data: JSON.parse(raw) }); }
                catch { reject(new Error(`Non-JSON HTTP ${res.statusCode}: ${raw.slice(0,200)}`)); }
            });
        } catch (e) { reject(e); }
    });
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let b = '';
        req.on('data', c => { b += c; if (b.length > 2e6) req.destroy(); });
        req.on('end', () => resolve(b));
        req.on('error', reject);
    });
}

function sendJSON(res, status, data) {
    if (res.headersSent) return;
    const body = JSON.stringify(data);
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Accept',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
}

function sendFile(res, filePath) {
    const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css', '.js':'application/javascript', '.ico':'image/x-icon', '.png':'image/png' };
    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': mime[path.extname(filePath)] || 'text/plain' });
        res.end(data);
    });
}

// ── yt-dlp: get full info JSON ────────────────────────────────────────────────
function ytdlpInfo(videoUrl) {
    return new Promise((resolve) => {
        if (!YTDLP_PATH) return resolve(null);

        const args = [
            '--dump-json', '--no-playlist', '--no-warnings', '--skip-download',
            '--no-check-certificates',
            videoUrl,
        ];
        console.log(`[YTDLP-INFO] CMD: ${YTDLP_CMD} ${args.join(' ')}`);

        const proc = spawnYtdlp(args, {});
        let stdout = '', stderr = '';
        proc.stdout.on('data', d => { stdout += d; });
        proc.stderr.on('data', d => { stderr += d; process.stderr.write('[yt-dlp] ' + d); });

        proc.on('close', code => {
            console.log(`[YTDLP-INFO] exit=${code} stdout_len=${stdout.length} stderr_len=${stderr.length}`);
            if (code !== 0 || !stdout.trim()) {
                console.error('[YTDLP-INFO] FAILED:', stderr.slice(0,400));
                return resolve(null);
            }
            try {
                const info = JSON.parse(stdout);
                const formats = info.formats || [];
                console.log(`[YTDLP-INFO] title="${info.title}" total_formats=${formats.length}`);

                // ── Log every format for debugging ──
                formats.forEach((f, i) => {
                    console.log(
                        `  [fmt ${String(i).padStart(3)}] id=${String(f.format_id).padEnd(12)} ` +
                        `ext=${String(f.ext||'?').padEnd(5)} ` +
                        `height=${String(f.height||'-').padEnd(5)} ` +
                        `vcodec=${String(f.vcodec||'none').padEnd(10)} ` +
                        `acodec=${String(f.acodec||'none').padEnd(10)} ` +
                        `size=${String(f.filesize||f.filesize_approx||0).padEnd(12)} ` +
                        `tbr=${f.tbr||0}`
                    );
                });

                // ── Parse thumbnail ──
                let thumbnail = info.thumbnail || '';
                if (Array.isArray(info.thumbnails) && info.thumbnails.length > 0) {
                    const best = [...info.thumbnails].sort((a,b) =>
                        (b.preference||b.width||0) - (a.preference||a.width||0)
                    )[0];
                    thumbnail = best.url || thumbnail;
                }

                // ── Group video formats by height ──
                const heightMap = new Map();
                for (const f of formats) {
                    if (!f.height || f.height < 100) continue;           // skip audio-only, tiny
                    if (!f.vcodec || f.vcodec === 'none') continue;       // must have video
                    const sz = f.filesize || f.filesize_approx || 0;
                    const prev = heightMap.get(f.height);
                    if (!prev || sz > (prev.size || 0)) {
                        heightMap.set(f.height, {
                            height:    f.height,
                            size:      sz,
                            has_audio: !!(f.acodec && f.acodec !== 'none'),
                            format_id: f.format_id,
                            ext:       f.ext || 'mp4',
                        });
                    }
                }

                // ── Best audio-only size (for merged size estimate) ──
                const audioFmts = formats.filter(f =>
                    f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none')
                );
                const bestAudio = audioFmts.reduce((b,f) => {
                    const s = f.filesize || f.filesize_approx || 0;
                    return (!b || s > (b.filesize||0)) ? { ...f, filesize: s } : b;
                }, null);
                const audioSize = bestAudio?.filesize || 0;

                const qualities = [...heightMap.values()]
                    .sort((a,b) => b.height - a.height)
                    .map(f => ({
                        quality:    String(f.height),
                        label:      f.height + 'p',
                        format_id:  f.format_id,
                        needsMerge: !f.has_audio,
                        hasAudio:   f.has_audio || !!FFMPEG_PATH,
                        size:       f.size + (!f.has_audio ? audioSize : 0),
                        ext:        f.ext,
                    }));

                console.log(`[YTDLP-INFO] qualities: ${qualities.map(q=>`${q.label}(${q.format_id})`).join(', ')}`);
                resolve({
                    title:    info.title || 'video',
                    uploader: info.uploader || info.channel || '',
                    duration: info.duration || 0,
                    thumbnail,
                    qualities,
                });
            } catch (e) {
                console.error('[YTDLP-INFO] parse error:', e.message, stdout.slice(0,100));
                resolve(null);
            }
        });
        proc.on('error', e => { console.error('[YTDLP-INFO] spawn error:', e.message); resolve(null); });
    });
}

// ── yt-dlp: download to temp file, return final path ─────────────────────────
function ytdlpDownloadToFile(videoUrl, fmtStr, outTemplate, extraArgs = []) {
    return new Promise((resolve, reject) => {
        if (!YTDLP_PATH) return reject(new Error('yt-dlp not available'));

        const args = [
            '--no-playlist', '--no-warnings', '--no-check-certificates',
            '--retries', '3', '--no-part',
            '--no-mtime',
            '-f', fmtStr,
            '-o', outTemplate,
            ...extraArgs,
            videoUrl,
        ];
        if (FFMPEG_PATH) {
            args.push('--ffmpeg-location', path.dirname(FFMPEG_PATH));
        }

        console.log(`[YTDLP-DL] CMD: ${YTDLP_CMD} ${args.join(' ')}`);

        const proc = spawnYtdlp(args, {});
        let stderr = '';
        proc.stdout.on('data', d => { process.stdout.write(d); });
        proc.stderr.on('data', d => { stderr += d; process.stderr.write('[yt-dlp-dl] ' + d); });

        proc.on('close', code => {
            console.log(`[YTDLP-DL] exit=${code}`);
            if (code !== 0) {
                return reject(new Error(`yt-dlp exited ${code}: ${stderr.slice(-300)}`));
            }
            resolve();
        });
        proc.on('error', e => reject(new Error(`yt-dlp spawn: ${e.message}`)));
    });
}

// Find actual output file yt-dlp wrote (extension may differ from template)
function findActualFile(dir, id) {
    try {
        const all = fs.readdirSync(dir).filter(f => f.includes(`grabr_${id}`));
        console.log(`[FIND-FILE] id=${id} candidates: [${all.join(', ')}]`);
        if (!all.length) return null;
        // Return largest
        return path.join(dir, all.sort((a,b) => {
            try { return fs.statSync(path.join(dir,b)).size - fs.statSync(path.join(dir,a)).size; }
            catch { return 0; }
        })[0]);
    } catch { return null; }
}

// ── Cobalt ────────────────────────────────────────────────────────────────────
async function cobaltFetch(payload) {
    if (!COBALT_INSTANCE) throw new Error('No Cobalt instance configured.');
    console.log(`[COBALT] POST ${COBALT_INSTANCE}/ → ${JSON.stringify(payload)}`);
    const { httpStatus, data } = await postJSON(COBALT_INSTANCE + '/', payload);
    const errCode = data?.error?.code || data?.text || '';
    if (httpStatus === 401 || httpStatus === 403 || errCode.includes('auth'))
        throw new Error('Cobalt requires authentication.');
    if (httpStatus === 429 || errCode.includes('rate'))
        throw new Error('Cobalt rate limited. Try again in a moment.');
    if (httpStatus < 400 && data?.status !== 'error') return data;
    const msg = String(errCode || data?.status || `HTTP ${httpStatus}`).toLowerCase();
    if (msg.includes('private') || msg.includes('login')) throw new Error('Content is private.');
    if (msg.includes('age')) throw new Error('Age-restricted content.');
    throw new Error(`Cobalt error: ${errCode || data?.status || httpStatus}`);
}

// ── /api/info ─────────────────────────────────────────────────────────────────
async function handleInfo(req, res) {
    let mediaUrl;
    try { ({ url: mediaUrl } = JSON.parse(await readBody(req))); }
    catch { return sendJSON(res, 400, { error: 'Invalid JSON body' }); }
    if (!mediaUrl) return sendJSON(res, 400, { error: 'Missing url' });

    console.log(`\n${'─'.repeat(56)}\n[INFO] ${mediaUrl}`);

    const isYT = /youtu\.?be/.test(mediaUrl);
    if (isYT) {
        if (!YTDLP_PATH) return sendJSON(res, 500, { error: 'yt-dlp not available on server. Redeploy to trigger auto-install.' });
        const meta = await ytdlpInfo(mediaUrl);
        if (!meta) return sendJSON(res, 500, { error: 'yt-dlp could not fetch video info. Video may be private, geo-blocked, or unavailable.' });
        if (!meta.qualities.length) {
            console.error('[INFO] yt-dlp returned 0 qualities — check format log above');
            return sendJSON(res, 500, { error: 'No video formats found. The video may be a live stream or use an unsupported codec.' });
        }
        return sendJSON(res, 200, { ...meta, ffmpeg: !!FFMPEG_PATH, source: 'ytdlp' });
    }

    // Non-YouTube
    try {
        const data = await cobaltFetch({ url: mediaUrl, downloadMode: 'auto', videoQuality: 'max', audioFormat: 'best' });
        if (Array.isArray(data.picker)) {
            return sendJSON(res, 200, { title: 'Instagram Post', uploader: '', picker: data.picker, ffmpeg: !!FFMPEG_PATH, source: 'cobalt' });
        }
        if (data.url) {
            const needsMerge = !!(data.audio && data.audio !== data.url);
            return sendJSON(res, 200, {
                title: data.filename || 'video', uploader: '', thumbnail: '', duration: 0,
                qualities: [{ quality: 'max', label: 'Best', needsMerge, hasAudio: !needsMerge || !!FFMPEG_PATH, size: 0, ext: 'mp4' }],
                ffmpeg: !!FFMPEG_PATH, source: 'cobalt',
            });
        }
        throw new Error('No URL in Cobalt response');
    } catch (e) {
        console.error('[INFO] non-YT error:', e.message);
        return sendJSON(res, 500, { error: e.message });
    }
}

// ── /api/download — THE MAIN FIX: yt-dlp downloads to disk, server streams it ─
async function handleDownload(req, res) {
    let mediaUrl, quality, audioOnly;
    try {
        const b = JSON.parse(await readBody(req));
        mediaUrl = b.url; quality = b.quality || 'max'; audioOnly = !!b.audioOnly;
    } catch { return sendJSON(res, 400, { error: 'Invalid JSON' }); }
    if (!mediaUrl) return sendJSON(res, 400, { error: 'Missing url' });

    console.log(`\n${'─'.repeat(56)}\n[DOWNLOAD] url=${mediaUrl} quality=${quality} audioOnly=${audioOnly}`);

    const isYT = /youtu\.?be/.test(mediaUrl);

    // ── Non-YouTube: proxy Cobalt ──────────────────────────────────────────
    if (!isYT) {
        try {
            const data = await cobaltFetch({
                url: mediaUrl,
                downloadMode: audioOnly ? 'audio' : 'auto',
                videoQuality: quality === 'max' ? 'max' : String(quality),
                audioFormat: audioOnly ? 'mp3' : 'best',
            });
            if (!data.url) throw new Error('Cobalt returned no URL');
            console.log(`[DOWNLOAD] Cobalt URL: ${data.url.slice(0,80)}`);
            const upstream = await makeRequest('GET', data.url, null);
            if (upstream.statusCode >= 400) { upstream.resume(); throw new Error(`Upstream HTTP ${upstream.statusCode}`); }
            console.log(`[DOWNLOAD] Upstream content-length: ${upstream.headers['content-length'] || 'unknown'}`);
            const ext = audioOnly ? 'mp3' : 'mp4';
            const headers = {
                'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store',
                'Content-Disposition': `attachment; filename="media.${ext}"`,
                'Content-Type': upstream.headers['content-type'] || `video/${ext}`,
            };
            if (upstream.headers['content-length']) headers['Content-Length'] = upstream.headers['content-length'];
            res.writeHead(200, headers);
            upstream.pipe(res);
        } catch (e) {
            console.error('[DOWNLOAD] Cobalt error:', e.message);
            if (!res.headersSent) sendJSON(res, 500, { error: e.message });
        }
        return;
    }

    // ── YouTube: use yt-dlp to download, then stream ───────────────────────
    if (!YTDLP_PATH) return sendJSON(res, 500, { error: 'yt-dlp not available' });

    const id  = crypto.randomBytes(8).toString('hex');
    const tmp = os.tmpdir();
    const outTemplate = path.join(tmp, `grabr_${id}.%(ext)s`);

    let fmtStr;
    const extraArgs = [];

    if (audioOnly) {
        fmtStr = 'bestaudio/best';
        extraArgs.push('--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0');
    } else {
        const h = parseInt(quality) || 0;
        if (FFMPEG_PATH) {
            // With FFmpeg: grab best video + best audio at height, merge
            fmtStr = h
                ? `bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${h}]+bestaudio/best[height<=${h}]`
                : `bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best`;
            extraArgs.push('--merge-output-format', 'mp4');
        } else {
            // No FFmpeg: only pre-muxed formats (audio already in video stream)
            fmtStr = h
                ? `best[height<=${h}][ext=mp4]/best[height<=${h}]/best`
                : `best[ext=mp4]/best`;
        }
    }

    console.log(`[DOWNLOAD] format="${fmtStr}" template="${outTemplate}"`);

    try {
        await ytdlpDownloadToFile(mediaUrl, fmtStr, outTemplate, extraArgs);

        const actualPath = findActualFile(tmp, id);
        if (!actualPath) throw new Error('Output file not found after yt-dlp completed');

        const stat = fs.statSync(actualPath);
        console.log(`[DOWNLOAD] ✓ File: ${actualPath} Size: ${(stat.size/1024/1024).toFixed(2)} MB`);

        if (stat.size === 0) {
            fs.unlinkSync(actualPath);
            throw new Error('yt-dlp produced a 0-byte file — check server logs');
        }

        const fileExt  = path.extname(actualPath).slice(1) || (audioOnly ? 'mp3' : 'mp4');
        const mimeType = audioOnly ? 'audio/mpeg' : 'video/mp4';
        const outName  = `video_${quality}.${fileExt}`;

        res.writeHead(200, {
            'Content-Type':        mimeType,
            'Content-Length':      stat.size,
            'Content-Disposition': `attachment; filename="${outName}"`,
            'Access-Control-Allow-Origin': '*',
            'Cache-Control':       'no-store',
        });

        const stream = fs.createReadStream(actualPath);
        stream.pipe(res);
        const cleanUp = () => { try { fs.unlinkSync(actualPath); } catch(_){} };
        stream.on('end',   cleanUp);
        stream.on('error', e => { console.error('[DOWNLOAD] stream error:', e.message); cleanUp(); });
        res.on('close',    cleanUp); // client disconnected early

    } catch (e) {
        console.error('[DOWNLOAD] ERROR:', e.message);
        // Clean up any partial files
        try {
            fs.readdirSync(tmp).filter(f => f.includes(`grabr_${id}`))
                .forEach(f => { try { fs.unlinkSync(path.join(tmp,f)); } catch(_){} });
        } catch(_) {}
        if (!res.headersSent) sendJSON(res, 500, { error: e.message });
    }
}

// ── /api/stream — proxy a direct URL (Instagram/TikTok Cobalt CDN) ────────────
async function handleStream(req, res) {
    const sp = new URL(req.url, 'http://x').searchParams;
    const targetUrl = decodeURIComponent(sp.get('url') || '');
    const filename  = decodeURIComponent(sp.get('filename') || 'media.mp4').replace(/[^a-zA-Z0-9._\- ]/g,'_');
    if (!targetUrl) return sendJSON(res, 400, { error: 'Missing url' });
    console.log(`\n[STREAM] ${filename} ← ${targetUrl.slice(0,80)}`);
    try {
        const up = await makeRequest('GET', targetUrl, null);
        if (up.statusCode >= 400) { up.resume(); return sendJSON(res, 502, { error: `Upstream HTTP ${up.statusCode}` }); }
        console.log(`[STREAM] upstream ${up.statusCode} content-length=${up.headers['content-length']||'?'}`);
        const headers = {
            'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'Content-Type': up.headers['content-type'] || 'video/mp4',
        };
        if (up.headers['content-length']) headers['Content-Length'] = up.headers['content-length'];
        res.writeHead(200, headers);
        up.pipe(res);
        up.on('error', () => { if (!res.headersSent) res.destroy(); });
    } catch (e) {
        console.error('[STREAM] error:', e.message);
        if (!res.headersSent) sendJSON(res, 502, { error: e.message });
    }
}

// ── /api/health ───────────────────────────────────────────────────────────────
function handleHealth(res) {
    sendJSON(res, 200, {
        ok: true, ffmpeg: !!FFMPEG_PATH, ytdlp: !!YTDLP_PATH,
        ytdlpCmd: YTDLP_PATH ? YTDLP_CMD : null,
        cobaltConfigured: !!COBALT_INSTANCE,
        platform: process.platform, node: process.version,
    });
}

// ── HTTP Server ───────────────────────────────────────────────────────────────
http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Methods':'GET,POST,OPTIONS', 'Access-Control-Allow-Headers':'Content-Type,Accept', 'Access-Control-Max-Age':'86400' });
        return res.end();
    }
    let pathname;
    try { pathname = new URL(req.url, 'http://x').pathname; } catch { pathname = '/'; }
    console.log(`[REQ] ${req.method} ${pathname}`);

    if (pathname === '/api/info'     && req.method === 'POST') return handleInfo(req, res);
    if (pathname === '/api/download' && req.method === 'POST') return handleDownload(req, res);
    if (pathname === '/api/stream'   && req.method === 'GET')  return handleStream(req, res);
    if (pathname === '/api/health'   && req.method === 'GET')  return handleHealth(res);

    const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/,'');
    sendFile(res, path.join(__dirname, '../public', safe === '/' ? 'index.html' : safe));
}).listen(PORT, () => {
    console.log(`\nGRABR v6.0 → http://localhost:${PORT}\n`);
});