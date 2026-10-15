const vm = require('vm');
const nodeCrypto = require('crypto');

const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36';
const TTL = 5 * 60 * 1000;           // repo + provider code cache
const PROVIDER_TIMEOUT = Number(process.env.PROVIDER_TIMEOUT_MS || 12000); // per provider, ms
const cache = new Map();

async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL) return hit.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  return v;
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
}

// ---- config (stateless: lives inside the install URL) ----
const encode = (cfg) => Buffer.from(JSON.stringify(cfg)).toString('base64url');
function decode(c) {
  const cfg = JSON.parse(Buffer.from(String(c), 'base64url').toString());
  if (!cfg || typeof cfg.r !== 'string' || !Array.isArray(cfg.p)) throw new Error('bad config');
  return cfg;
}

// ---- url safety ----
function checkUrl(u) {
  const url = new URL(u);
  const h = url.hostname;
  if (url.protocol !== 'https:') throw new Error('https only');
  if (h === 'localhost' || /^[\d.]+$/.test(h) || h.includes(':') || /\.(local|internal)$/.test(h)) {
    throw new Error('blocked host');
  }
  return url;
}
// Set ALLOWED_REPOS (comma-separated exact manifest URLs) to lock this deployment to repos you trust.
function checkRepo(u) {
  checkUrl(u);
  const allow = (process.env.ALLOWED_REPOS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (allow.length && !allow.includes(u)) throw new Error('repo not allowed on this deployment');
}

async function fetchText(u, ms = 15000) {
  checkUrl(u);
  const res = await fetch(u, { signal: AbortSignal.timeout(ms), headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${u}`);
  return { text: await res.text(), finalUrl: res.url || u };
}

// ---- plugin repo ----
function loadRepo(repoUrl) {
  return cached('repo:' + repoUrl, async () => {
    const { text, finalUrl } = await fetchText(repoUrl);
    const m = JSON.parse(text);
    const list = m.scrapers || m.providers || [];
    return {
      name: m.name || 'Plugin repo',
      scrapers: list
        .filter((s) => s && s.id && s.filename && s.enabled !== false)
        .map((s) => ({
          id: s.id,
          name: String(s.name || s.id).replace(/\.$/, ''),
          description: s.description || '',
          types: s.supportedTypes || ['movie', 'tv'],
          languages: s.contentLanguage || [],
          hasSettings: !!s.hasSettings,
          url: new URL(s.filename, finalUrl).href, // handles relative filenames too
        })),
    };
  });
}

const loadCode = (url) => cached('code:' + url, async () => (await fetchText(url)).text);

// ---- sandbox ----
function shimRequire(name) {
  switch (name) {
    case 'crypto': return nodeCrypto;
    case 'crypto-js': return require('crypto-js');
    case 'cheerio':
    case 'cheerio-without-node-native':
    case 'react-native-cheerio': return require('cheerio');
    default: throw new Error('module not available in bridge: ' + name);
  }
}

function runProvider(code, { tmdbId, mediaType, season, episode }) {
  const mod = { exports: {} };
  const quiet = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
  const sandbox = {
    module: mod, exports: mod.exports, require: shimRequire, console: quiet,
    fetch: (u, o = {}) => { checkUrl(typeof u === 'string' ? u : u.url); return fetch(u, { signal: AbortSignal.timeout(15000), ...o }); },
    URL, URLSearchParams, AbortController, TextEncoder, TextDecoder, Buffer, atob, btoa,
    Headers, Request, Response, setTimeout, clearTimeout, Promise,
    SCRAPER_SETTINGS: {},
  };
  sandbox.global = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  new vm.Script(code, { filename: 'provider.js' }).runInContext(sandbox, { timeout: 5000 });

  const fn = (mod.exports && mod.exports.getStreams) || sandbox.getStreams ||
    (typeof mod.exports === 'function' ? mod.exports : null);
  if (!fn) throw new Error('no getStreams export found');

  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('provider timeout')), PROVIDER_TIMEOUT); });
  return Promise.race([Promise.resolve(fn(tmdbId, mediaType, season, episode)), timeout])
    .finally(() => clearTimeout(timer));
}

// ---- stremio mapping ----
function toStremio(s, label) {
  if (!s || !s.url) return null;
  const hasHeaders = s.headers && Object.keys(s.headers).length > 0;
  return {
    name: label + (s.quality ? '\n' + s.quality : ''),
    title: [s.title || s.name, s.size].filter(Boolean).join('\n'),
    url: s.url,
    ...(hasHeaders ? { behaviorHints: { notWebReady: true, proxyHeaders: { request: s.headers } } } : {}),
  };
}

// Stremio sends IMDb ids; plugins want TMDB ids. Needs TMDB_API_KEY (v3 key or v4 token).
function imdbToTmdb(imdb, type) {
  return cached(`tmdb:${imdb}:${type}`, async () => {
    const key = process.env.TMDB_API_KEY;
    if (!key) throw new Error('TMDB_API_KEY is not set');
    const v4 = key.length > 40;
    const url = `https://api.themoviedb.org/3/find/${imdb}?external_source=imdb_id` + (v4 ? '' : `&api_key=${key}`);
    const r = await fetch(url, { headers: v4 ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    const hit = type === 'movie' ? (j.movie_results || [])[0] : (j.tv_results || [])[0];
    return hit ? String(hit.id) : null;
  });
}

module.exports = { cached, cors, encode, decode, checkRepo, loadRepo, loadCode, runProvider, toStremio, imdbToTmdb };
