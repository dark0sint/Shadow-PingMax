#!/usr/bin/env node
/**
 * Shadow PingMax - platform ping URL & keyword (XML-RPC weblogUpdates + IndexNow)
 * Zero dependency. Butuh Node.js >= 18.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ------------------------------------------------------------------ */
/* Konfigurasi                                                         */
/* ------------------------------------------------------------------ */
function loadEnv(file) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  } catch (_) { /* .env opsional */ }
}
loadEnv(path.join(__dirname, '.env'));

const num = (v, d) => (Number.isFinite(+v) && +v > 0 ? +v : d);
const CFG = {
  port: num(process.env.PORT, 3000),
  host: process.env.HOST || '0.0.0.0',
  password: process.env.ACCESS_PASSWORD || '',
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  cookieSecure: process.env.COOKIE_SECURE === '1',
  trustProxy: process.env.TRUST_PROXY === '1',
  maxUrls: num(process.env.MAX_URLS, 20),
  concurrency: num(process.env.CONCURRENCY, 10),
  timeoutMs: num(process.env.PING_TIMEOUT_MS, 12000),
  rateJobs: num(process.env.RATE_LIMIT_JOBS, 15),
  rateWindowMs: num(process.env.RATE_WINDOW_MIN, 60) * 60000,
  maxActiveJobs: num(process.env.MAX_ACTIVE_JOBS, 3),
  corsOrigins: (process.env.CORS_ORIGIN || '').split(',').map((x) => x.trim()).filter(Boolean),
  dataDir: process.env.DATA_DIR || path.join(__dirname, 'data'),
  servicesFile: process.env.SERVICES_FILE || path.join(__dirname, 'services.json'),
};

const PUBLIC_DIR = path.join(__dirname, 'public');
const UA = 'ShadowPingMax/1.0 (+xmlrpc-ping)';

const CATEGORIES = [
  { id: 'general', label: 'Umum' },
  { id: 'blog', label: 'Blog' },
  { id: 'news', label: 'Berita' },
  { id: 'technology', label: 'Teknologi' },
  { id: 'health', label: 'Kesehatan' },
  { id: 'finance', label: 'Keuangan' },
  { id: 'business', label: 'Bisnis' },
  { id: 'ecommerce', label: 'E-commerce' },
  { id: 'education', label: 'Pendidikan' },
  { id: 'travel', label: 'Wisata' },
  { id: 'entertainment', label: 'Hiburan' },
  { id: 'sports', label: 'Olahraga' },
  { id: 'lifestyle', label: 'Gaya hidup' },
];
const CATEGORY_IDS = new Set(CATEGORIES.map((c) => c.id));

function loadServices() {
  const list = JSON.parse(fs.readFileSync(CFG.servicesFile, 'utf8'));
  return list.filter((s) => s && s.id && s.name && /^https?:\/\//i.test(s.url || ''))
    .map((s) => ({ id: String(s.id), name: String(s.name), url: s.url, categories: Array.isArray(s.categories) ? s.categories : ['all'] }));
}
let SERVICES = loadServices();

/* ------------------------------------------------------------------ */
/* Util                                                                */
/* ------------------------------------------------------------------ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

function clientIp(req) {
  if (CFG.trustProxy) {
    const xf = req.headers['x-forwarded-for'];
    if (xf) return String(xf).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function makeLimiter(limit, windowMs) {
  const hits = new Map();
  return {
    hit(key) {
      const now = Date.now();
      const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
      if (arr.length >= limit) { hits.set(key, arr); return true; }
      arr.push(now); hits.set(key, arr); return false;
    },
    sweep() {
      const now = Date.now();
      for (const [k, arr] of hits) {
        const f = arr.filter((t) => now - t < windowMs);
        if (f.length) hits.set(k, f); else hits.delete(k);
      }
    },
  };
}
const pingLimiter = makeLimiter(CFG.rateJobs, CFG.rateWindowMs);
const loginLimiter = makeLimiter(10, 15 * 60000);

function json(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function readJson(req, limit = 100 * 1024) {
  return new Promise((resolve, reject) => {
    if (!/application\/json/i.test(req.headers['content-type'] || '')) {
      return reject(Object.assign(new Error('Content-Type harus application/json'), { status: 415 }));
    }
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Payload terlalu besar'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(Object.assign(new Error('JSON tidak valid'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ */
/* Auth (opsional, aktif jika ACCESS_PASSWORD diisi)                    */
/* ------------------------------------------------------------------ */
const COOKIE = 'spm_session';
const SESSION_MS = 7 * 24 * 3600 * 1000;
const sign = (v) => crypto.createHmac('sha256', CFG.secret).update(v).digest('hex');

function makeSession() { const exp = Date.now() + SESSION_MS; return `${exp}.${sign(String(exp))}`; }
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function isAuthed(req) {
  if (!CFG.password) return true;
  const auth = String(req.headers.authorization || '');
  const tok = auth.startsWith('Bearer ') ? auth.slice(7).trim() : parseCookies(req)[COOKIE];
  if (!tok) return false;
  const [exp, sig] = tok.split('.');
  if (!exp || !sig || +exp < Date.now()) return false;
  const good = sign(exp);
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}
function cookieHeader(req, value, maxAgeSec) {
  const secure = CFG.cookieSecure || req.headers['x-forwarded-proto'] === 'https';
  return `${COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
}

/* ------------------------------------------------------------------ */
/* XML-RPC                                                             */
/* ------------------------------------------------------------------ */
const clean = (s) => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
const esc = (s) => clean(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const decodeXml = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

function buildXml(method, params) {
  return '<?xml version="1.0"?><methodCall><methodName>' + method + '</methodName><params>' +
    params.map((p) => `<param><value><string>${esc(p)}</string></value></param>`).join('') +
    '</params></methodCall>';
}

async function readLimited(res, max = 65536) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = []; let size = 0;
  while (size < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value)); size += value.length;
  }
  try { await reader.cancel(); } catch (_) {}
  return Buffer.concat(chunks).toString('utf8').slice(0, max);
}

const stripTags = (s) => decodeXml(String(s).replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

function parseXmlRpc(status, body) {
  if (status < 200 || status >= 300) return { ok: false, soft: false, msg: `HTTP ${status}` };
  if (!/<methodResponse/i.test(body)) return { ok: false, soft: true, msg: 'Respons bukan XML-RPC' };
  if (/<fault>/i.test(body)) {
    const m = body.match(/faultString[\s\S]*?<value>([\s\S]*?)<\/value>/i);
    return { ok: false, soft: true, msg: (m ? stripTags(m[1]) : 'XML-RPC fault').slice(0, 160) || 'XML-RPC fault' };
  }
  const fl = body.match(/<name>\s*flerror\s*<\/name>\s*<value>\s*<(?:boolean|int|i4)>\s*(\d)/i);
  const mm = body.match(/<name>\s*message\s*<\/name>\s*<value>([\s\S]*?)<\/value>/i);
  const message = mm ? stripTags(mm[1]).slice(0, 160) : '';
  if (fl && fl[1] === '1') return { ok: false, soft: true, msg: message || 'Ditolak server (flerror)' };
  return { ok: true, msg: message || 'OK' };
}

async function xmlrpc(endpoint, method, params) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', 'User-Agent': UA, Accept: 'text/xml,application/xml,*/*' },
    body: buildXml(method, params),
    redirect: 'follow',
    signal: AbortSignal.timeout(CFG.timeoutMs),
  });
  const body = await readLimited(res);
  return parseXmlRpc(res.status, body);
}

async function pingService(job, service, url) {
  const tags = [job.keyword, ...job.categories].map((s) => s.replace(/\|/g, ' ')).join('|');
  const ext = await xmlrpc(service.url, 'weblogUpdates.extendedPing', [job.keyword, url, url, '', tags]);
  if (ext.ok) return ext;
  if (!ext.soft) return ext;
  const basic = await xmlrpc(service.url, 'weblogUpdates.ping', [job.keyword, url]);
  return basic;
}

async function pingIndexNow(job, url) {
  const u = `https://api.indexnow.org/indexnow?url=${encodeURIComponent(url)}&key=${encodeURIComponent(job.indexnowKey)}`;
  const res = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(CFG.timeoutMs) });
  await readLimited(res, 2048);
  if (res.status === 200 || res.status === 202) return { ok: true, msg: `Diterima (HTTP ${res.status})` };
  const map = {
    400: 'Request tidak valid',
    403: 'Key tidak valid atau file key tidak ada di domain',
    422: 'URL tidak cocok dengan host/key',
    429: 'Terlalu banyak request',
  };
  return { ok: false, msg: map[res.status] || `HTTP ${res.status}` };
}

function errorMessage(e) {
  if (!e) return 'Error';
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return 'Timeout';
  const code = e.cause && (e.cause.code || e.cause.message);
  const map = { ENOTFOUND: 'Domain tidak ditemukan', ECONNREFUSED: 'Koneksi ditolak', ECONNRESET: 'Koneksi terputus', ETIMEDOUT: 'Timeout koneksi', CERT_HAS_EXPIRED: 'Sertifikat kedaluwarsa' };
  return String(map[code] || code || e.message || 'Error').slice(0, 160);
}

/* ------------------------------------------------------------------ */
/* Job runner + SSE                                                    */
/* ------------------------------------------------------------------ */
const jobs = new Map();
let activeJobs = 0;

function emit(job, type, data) {
  const id = job.events.length + 1;
  const ev = { id, type, data };
  job.events.push(ev);
  for (const res of job.subs) writeEvent(res, ev);
}
function writeEvent(res, ev) {
  res.write(`id: ${ev.id}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`);
}

async function runJob(job) {
  activeJobs++;
  const t0 = Date.now();
  const tasks = [];
  for (const url of job.urls) for (const service of job.services) tasks.push({ kind: 'xmlrpc', url, service });
  if (job.indexnowKey) for (const url of job.urls) tasks.push({ kind: 'indexnow', url });
  tasks.forEach((t, i) => { t.idx = i; });
  job.total = tasks.length;

  emit(job, 'start', {
    jobId: job.id, total: job.total, urls: job.urls, keyword: job.keyword, categories: job.categories,
    tasks: tasks.map((t) => ({ idx: t.idx, url: t.url, service: t.kind === 'indexnow' ? 'IndexNow (Bing, Yandex, Naver, Seznam)' : t.service.name })),
  });

  let cursor = 0;
  const worker = async () => {
    while (cursor < tasks.length && !job.cancelled) {
      const t = tasks[cursor++];
      const started = Date.now();
      let r;
      try {
        r = t.kind === 'indexnow' ? await pingIndexNow(job, t.url) : await pingService(job, t.service, t.url);
      } catch (e) { r = { ok: false, msg: errorMessage(e) }; }
      job.done++;
      const per = job.perUrl.get(t.url);
      if (r.ok) { job.success++; per.success++; } else { job.failed++; per.failed++; }
      emit(job, 'result', {
        idx: t.idx, url: t.url,
        service: t.kind === 'indexnow' ? 'IndexNow (Bing, Yandex, Naver, Seznam)' : t.service.name,
        status: r.ok ? 'success' : 'failed', ms: Date.now() - started, message: r.msg,
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(CFG.concurrency, tasks.length) }, worker));

  job.finished = true;
  activeJobs--;
  const summary = {
    total: job.total, done: job.done, success: job.success, failed: job.failed,
    cancelled: job.cancelled, durationMs: Date.now() - t0,
  };
  emit(job, 'done', summary);
  for (const res of job.subs) res.end();
  job.subs.clear();

  addHistory({
    id: job.id, createdAt: job.createdAt, keyword: job.keyword, categories: job.categories,
    urls: job.urls, indexnow: !!job.indexnowKey, ...summary,
    perUrl: [...job.perUrl].map(([url, v]) => ({ url, success: v.success, failed: v.failed })),
  });
}

/* ------------------------------------------------------------------ */
/* Riwayat                                                             */
/* ------------------------------------------------------------------ */
const HISTORY_FILE = path.join(CFG.dataDir, 'history.json');
let history = [];
try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch (_) { history = []; }
function saveHistory() {
  try {
    fs.mkdirSync(CFG.dataDir, { recursive: true });
    const tmp = HISTORY_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(history));
    fs.renameSync(tmp, HISTORY_FILE);
  } catch (e) { console.error('Gagal menyimpan riwayat:', e.message); }
}
function addHistory(entry) { history.unshift(entry); history = history.slice(0, 100); saveHistory(); }

/* ------------------------------------------------------------------ */
/* Validasi input                                                      */
/* ------------------------------------------------------------------ */
function validateUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) return null;
  const h = u.hostname;
  if (h === 'localhost' || !h.includes('.') || raw.length > 2000) return null;
  return u.href;
}

function validatePingBody(b) {
  const keyword = clean(typeof b.keyword === 'string' ? b.keyword : '').replace(/\s+/g, ' ').trim();
  if (!keyword) return { error: 'Kata kunci / judul wajib diisi.' };
  if (keyword.length > 200) return { error: 'Kata kunci maksimal 200 karakter.' };

  let rawUrls = Array.isArray(b.urls) ? b.urls : (typeof b.urls === 'string' ? b.urls.split(/\s+/) : []);
  rawUrls = rawUrls.map((s) => String(s).trim()).filter(Boolean);
  if (!rawUrls.length) return { error: 'Masukkan minimal satu URL.' };
  const urls = []; const seen = new Set();
  for (const r of rawUrls) {
    const v = validateUrl(r);
    if (!v) return { error: `URL tidak valid: ${r.slice(0, 80)}` };
    if (!seen.has(v)) { seen.add(v); urls.push(v); }
  }
  if (urls.length > CFG.maxUrls) return { error: `Maksimal ${CFG.maxUrls} URL per proses.` };

  const categories = Array.isArray(b.categories) ? [...new Set(b.categories.map(String))] : [];
  if (!categories.length) return { error: 'Pilih minimal satu kategori.' };
  if (categories.some((c) => !CATEGORY_IDS.has(c))) return { error: 'Kategori tidak dikenal.' };

  let indexnowKey = '';
  if (b.indexnowKey) {
    indexnowKey = String(b.indexnowKey).trim();
    if (!/^[A-Za-z0-9-]{8,128}$/.test(indexnowKey)) return { error: 'IndexNow key harus 8-128 karakter (huruf, angka, strip).' };
  }
  return { keyword, urls, categories, indexnowKey };
}

function pickServices(categories) {
  return SERVICES.filter((s) => s.categories.includes('all') || s.categories.some((c) => categories.includes(c)));
}

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */
async function handleApi(req, res, url) {
  const p = url.pathname;
  const ip = clientIp(req);

  if (p === '/healthz') return json(res, 200, { ok: true, activeJobs });

  if (p === '/api/config' && req.method === 'GET') {
    return json(res, 200, {
      authRequired: !!CFG.password, authed: isAuthed(req),
      maxUrls: CFG.maxUrls, categories: CATEGORIES, serviceCount: SERVICES.length,
    });
  }

  if (p === '/api/login' && req.method === 'POST') {
    if (loginLimiter.hit(ip)) return json(res, 429, { error: 'Terlalu banyak percobaan. Coba lagi nanti.' });
    const b = await readJson(req);
    if (!CFG.password) return json(res, 200, { ok: true });
    const ok = crypto.timingSafeEqual(sha(b.password || ''), sha(CFG.password));
    if (!ok) return json(res, 401, { error: 'Password salah.' });
    const session = makeSession();
    return json(res, 200, { ok: true, token: session }, { 'Set-Cookie': cookieHeader(req, session, SESSION_MS / 1000) });
  }

  if (p === '/api/logout' && req.method === 'POST') {
    return json(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(req, '', 0) });
  }

  if (!isAuthed(req)) return json(res, 401, { error: 'Belum masuk.' });

  if (p === '/api/services' && req.method === 'GET') {
    return json(res, 200, SERVICES.map(({ id, name, categories }) => ({ id, name, categories })));
  }

  if (p === '/api/history' && req.method === 'GET') {
    return json(res, 200, history.slice(0, 50));
  }

  if (p === '/api/ping' && req.method === 'POST') {
    const body = await readJson(req);
    const v = validatePingBody(body);
    if (v.error) return json(res, 400, { error: v.error });
    if (pingLimiter.hit(ip)) return json(res, 429, { error: 'Batas penggunaan tercapai. Coba lagi beberapa saat lagi.' });
    if (activeJobs >= CFG.maxActiveJobs) return json(res, 503, { error: 'Server sedang sibuk. Coba lagi sebentar.' });

    const services = pickServices(v.categories);
    if (!services.length && !v.indexnowKey) return json(res, 400, { error: 'Tidak ada layanan ping untuk kategori ini.' });

    const job = {
      id: crypto.randomBytes(12).toString('hex'), createdAt: Date.now(),
      keyword: v.keyword, urls: v.urls, categories: v.categories, indexnowKey: v.indexnowKey,
      services, total: 0, done: 0, success: 0, failed: 0,
      events: [], subs: new Set(), finished: false, cancelled: false,
      perUrl: new Map(v.urls.map((u) => [u, { success: 0, failed: 0 }])),
    };
    jobs.set(job.id, job);
    runJob(job).catch((e) => { console.error('Job error:', e); job.finished = true; });
    return json(res, 202, { jobId: job.id });
  }

  let m = p.match(/^\/api\/jobs\/([a-f0-9]{24})\/stream$/);
  if (m && req.method === 'GET') {
    const job = jobs.get(m[1]);
    if (!job) return json(res, 404, { error: 'Job tidak ditemukan atau sudah kedaluwarsa.' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const last = parseInt(req.headers['last-event-id'] || url.searchParams.get('last') || '0', 10) || 0;
    for (const ev of job.events.slice(last)) writeEvent(res, ev);
    if (job.finished) return res.end();
    job.subs.add(res);
    req.on('close', () => job.subs.delete(res));
    return;
  }

  m = p.match(/^\/api\/jobs\/([a-f0-9]{24})\/cancel$/);
  if (m && req.method === 'POST') {
    const job = jobs.get(m[1]);
    if (!job) return json(res, 404, { error: 'Job tidak ditemukan.' });
    job.cancelled = true;
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'Endpoint tidak ditemukan.' });
}

/* ------------------------------------------------------------------ */
/* File statis                                                         */
/* ------------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Tidak ditemukan'); }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  // CORS opsional (untuk UI di GitHub Pages / domain lain)
  const origin = req.headers.origin;
  if (origin && (CFG.corsOrigins.includes('*') || CFG.corsOrigins.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (e) {
    if (e.status) return json(res, e.status, { error: e.message });
    console.error(e);
    if (!res.headersSent) return json(res, 500, { error: 'Kesalahan server.' });
    res.end();
  }
});

// Heartbeat SSE + pembersihan memori
setInterval(() => {
  for (const job of jobs.values()) for (const res of job.subs) res.write(': ping\n\n');
}, 15000).unref();
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) if (job.finished && now - job.createdAt > 3600 * 1000) jobs.delete(id);
  pingLimiter.sweep(); loginLimiter.sweep();
}, 10 * 60000).unref();

server.listen(CFG.port, CFG.host, () => {
  console.log(`Shadow PingMax berjalan di http://${CFG.host}:${CFG.port}`);
  console.log(`Layanan ping dimuat: ${SERVICES.length} | Auth: ${CFG.password ? 'aktif' : 'NONAKTIF (set ACCESS_PASSWORD)'}`);
});

function shutdown() { saveHistory(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
