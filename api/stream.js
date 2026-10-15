const { cached, cors, decode, checkRepo, loadRepo, loadCode, runProvider } = require('../lib/core');

const DEADLINE = Number(process.env.DEADLINE_MS || 4500);
const MAX_WAIT = Number(process.env.MAX_WAIT_MS || 15000); // if nothing finished by DEADLINE, wait for first streams up to this
const ADDON = 'NB';
const RES_ALL = ['4K', '1440p', '1080p', '720p', '480p', '360p', 'Unknown'];
const DEF_ORDER = ['1080p', '720p', '4K', '480p', '360p'];

// ---------- parsing helpers ----------
const L = (p) => new RegExp(`(?<![A-Za-z0-9])(?:${p})(?![A-Za-z0-9])`, 'i');
const A = (p) => new RegExp(`(?<![A-Za-z0-9])(?:${p})(?![A-Za-z])`, 'i'); // audio: digits may follow (DDP5.1)

function normRes(t) {
  t = String(t).trim().toLowerCase();
  if (/^(2160p?|4k|uhd)$/.test(t)) return '4K';
  if (/^(1440|1080|720|480|360)p?$/.test(t)) return parseInt(t, 10) + 'p';
  return t === 'unknown' ? 'Unknown' : null;
}
const RES_RE = [['4K', L('2160p|4k')], ['1440p', L('1440p')], ['1080p', L('1080p')], ['720p', L('720p')], ['480p', L('480p')], ['360p', L('360p')]];
function parseRes(label, file) {
  const d = normRes(label);
  if (d && d !== 'Unknown') return d;
  for (const t of [label, file]) for (const [n, re] of RES_RE) if (re.test(t)) return n;
  return 'Unknown';
}

const SRC = [['REMUX', L('(?:bd)?remux')], ['BluRay', L('blu[-_. ]?ray|bdrip|brrip')], ['WEB-DL', L('web[-_. ]?dl')], ['WEBRip', L('web[-_. ]?rip')], ['WEB', L('web')], ['HDTV', L('hdtv')], ['DVD', L('dvd(?:rip)?')], ['CAM', L('cam(?:rip)?|hdcam')]];
const COD = [['HEVC', L('x[-_. ]?265|hevc|h[-_. ]?265')], ['H.264', L('x[-_. ]?264|h[-_. ]?264|avc')], ['AV1', L('av1')]];
const AUD = [['Atmos', A('atmos')], ['TrueHD', A('true[-_. ]?hd')], ['DTS-HD', A('dts[-_. ]?hd')], ['DTS', A('dts')], ['DD+', A('ddp|dd\\+|e[-_. ]?ac[-_. ]?3')], ['DD', A('dd|ac[-_. ]?3')], ['AAC', A('aac')]];

function pick(texts, list) {
  for (const t of texts) for (const [n, re] of list) { const m = re.exec(t); if (m) return { n, t, m }; }
  return null;
}
function audio(texts) {
  const h = pick(texts, AUD);
  if (!h) return null;
  const after = h.t.slice(h.m.index + h.m[0].length);
  const near = /^[-_. ]?(7[._ ]1|5[._ ]1|2[._ ]0)(?![0-9])/.exec(after);
  const any = /(?<![0-9])(7\.1|5\.1|2\.0)(?![0-9])/.exec(h.t);
  const ch = near ? near[1] : any ? any[1] : '';
  return h.n + (ch ? ' ' + ch.replace(/[_ ]/, '.') : '');
}
function hdr(t) {
  const o = [];
  if (L('dolby[-_. ]?vision|dovi|dv').test(t)) o.push('DV');
  if (/(?<![A-Za-z0-9])hdr10(?:\+|plus)/i.test(t)) o.push('HDR10+');
  else if (/(?<![A-Za-z0-9])hdr(?:10)?(?![A-Za-z0-9+])/i.test(t)) o.push('HDR');
  return o;
}

const SZ = /(\d+(?:[.,]\d+)?)\s*(TB|GB|MB|KB)(?![A-Za-z])/i;
const UNIT = { tb: 1024 ** 4, gb: 1024 ** 3, mb: 1024 ** 2, kb: 1024 };
const stripSize = (t) => String(t == null ? '' : t).replace(new RegExp(SZ.source, 'ig'), ' ');
function parseSize(raw, texts) {
  if (typeof raw === 'number' && raw > 0) return raw;
  if (/^\d{4,}$/.test(String(raw))) return Number(raw);
  for (const t of [raw, ...texts]) {
    const m = SZ.exec(String(t == null ? '' : t));
    if (m) return Number(m[1].replace(',', '.')) * UNIT[m[2].toLowerCase()];
  }
  return null;
}
const fmtSize = (b) => (b == null ? '?' : b >= 1024 ** 3 ? (b / 1024 ** 3).toFixed(2) + ' GB' : Math.round(b / 1024 ** 2) + ' MB');

const LANG = { en: 'ENG', hi: 'HIN', ta: 'TAM', te: 'TEL', bn: 'BEN', ja: 'JPN', jp: 'JPN', ko: 'KOR', zh: 'CHI', fr: 'FRA', it: 'ITA', es: 'SPA', de: 'GER', pt: 'POR', tr: 'TUR', ru: 'RUS', ar: 'ARA', ur: 'URD', pa: 'PAN' };
function lang(s) {
  const v = [].concat(s.language || s.lang || s.languages || []).filter(Boolean).map((x) => {
    const k = String(x).toLowerCase();
    return LANG[k] || (k.length <= 3 ? k.toUpperCase() : k.slice(0, 3).toUpperCase());
  });
  return v.join('/');
}

// site name from the plugin description: "Vidrock • 1080p" -> Vidrock, "Provider: HDHub4u | x" -> HDHub4u
function siteName(desc, fallback) {
  const t = String(desc || '').replace(/^provider:\s*/i, '').split(/[•|·]/)[0].replace(/\s*\(.*?\)\s*/g, ' ').trim();
  return t || fallback;
}

const p2 = (n) => String(n).padStart(2, '0');

// Rebuilds ONLY name + title (gray info lines). url / behaviorHints untouched.
function build(s, ctx) {
  if (!s || !s.url) return null;
  const label = stripSize(s.quality), file = stripSize([s.title, s.name].filter(Boolean).join(' '));
  const texts = [label, file], joined = label + ' ' + file;
  const res = parseRes(label, file);
  const size = parseSize(s.size, [s.quality, s.title, s.name]);
  const l1 = [ctx.title, ctx.type === 'tv' ? `S${p2(ctx.season)}E${p2(ctx.episode)}` : ''].filter(Boolean).join(' · ');
  const src = pick(texts, SRC), cod = pick(texts, COD);
  const tech = [src && src.n, cod && cod.n, ...hdr(joined), L('10[-_. ]?bit').test(joined) ? '10-bit' : '', audio(texts)].filter(Boolean);
  const lg = lang(s), nsub = Array.isArray(s.subtitles) ? s.subtitles.length : 0;
  const lines = [
    l1 && '🎬 ' + l1,
    '📺 ' + (tech.join(' · ') || 'No tech info'),
    `💾 ${fmtSize(size)}  ·  ⚡ Direct`,
    ['🔑 ' + ctx.site, lg && '🌐 ' + lg, nsub && '💬 ' + (nsub > 1 ? 'Multi Subs' : 'Subs')].filter(Boolean).join('  ·  '),
  ].filter(Boolean);
  const hasHeaders = s.headers && Object.keys(s.headers).length > 0;
  return {
    res, size,
    obj: {
      name: `${ADDON} - ${res} - ${ctx.site}`,
      title: lines.join('\n'),
      url: s.url,
      ...(hasHeaders ? { behaviorHints: { notWebReady: true, proxyHeaders: { request: s.headers } } } : {}),
    },
  };
}

// Stremio sends IMDb ids; plugins want TMDB ids. Also returns the title for the info text.
function findTmdb(imdb, type) {
  return cached(`find:${imdb}:${type}`, async () => {
    const key = process.env.TMDB_API_KEY;
    if (!key) throw new Error('TMDB_API_KEY is not set');
    const v4 = key.length > 40;
    const url = `https://api.themoviedb.org/3/find/${imdb}?external_source=imdb_id` + (v4 ? '' : `&api_key=${key}`);
    const r = await fetch(url, { headers: v4 ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    const hit = type === 'movie' ? (j.movie_results || [])[0] : (j.tv_results || [])[0];
    return hit ? { id: String(hit.id), title: hit.title || hit.name || '' } : null;
  });
}

// ---------- handler ----------
module.exports = async (req, res) => {
  cors(res);
  try {
    const cfg = decode(req.query.config);
    checkRepo(cfg.r);

    const allowed = new Set((Array.isArray(cfg.rs) ? cfg.rs : RES_ALL).map(normRes).filter(Boolean));
    const order = (Array.isArray(cfg.o) && cfg.o.length ? cfg.o : DEF_ORDER).map(normRes).filter(Boolean);
    const rank = (r) => { const i = order.indexOf(r); return i >= 0 ? i : order.length + RES_ALL.indexOf(r); };
    const dir = cfg.z === 's' ? 1 : -1; // 'l' = largest first (default), 's' = smallest first

    const type = req.query.type === 'movie' ? 'movie' : 'tv';
    const id = decodeURIComponent(String(req.query.id)).replace(/\.json$/, '');
    const [imdb, s, e] = id.split(':');
    if (!/^tt\d+$/.test(imdb)) return res.json({ streams: [] });
    const season = type === 'tv' ? Number(s) : null;
    const episode = type === 'tv' ? Number(e) : null;

    const [repo, found] = await Promise.all([loadRepo(cfg.r), findTmdb(imdb, type)]);
    if (!found) return res.json({ streams: [] });
    const tmdbId = found.id;

    const picked = repo.scrapers.filter((x) => cfg.p.includes(x.id) &&
      (type === 'movie' ? x.types.includes('movie') : x.types.some((t) => t === 'tv' || t === 'series')));

    const collected = [];
    let pending = picked.length;

    await new Promise((resolve) => {
      if (!pending) return resolve();
      let deadlineHit = false;
      const finish = () => { clearTimeout(t1); clearTimeout(t2); resolve(); };
      const t1 = setTimeout(() => { deadlineHit = true; if (collected.length) finish(); }, DEADLINE);
      const t2 = setTimeout(finish, MAX_WAIT);
      picked.forEach((sc) => {
        const ctx = { title: found.title, type, season, episode, site: siteName(sc.description, sc.name) };
        cached(`res2:${sc.id}:${tmdbId}:${season}:${episode}`, async () => {
          const code = await loadCode(sc.url);
          const out = await runProvider(code, { tmdbId, mediaType: type, season, episode });
          return (Array.isArray(out) ? out : []).map((st) => build(st, ctx)).filter(Boolean);
        })
          .then((v) => collected.push(...v.filter((x) => allowed.has(x.res))))
          .catch(() => {})
          .finally(() => { if (--pending === 0 || (deadlineHit && collected.length)) finish(); });
      });
    });

    collected.sort((a, b) => rank(a.res) - rank(b.res) ||
      (a.size == null) - (b.size == null) || (a.size == null ? 0 : dir * (a.size - b.size)));

    res.setHeader('Cache-Control', pending === 0 ? 'public, s-maxage=300, stale-while-revalidate=600' : 'public, s-maxage=5');
    res.json({ streams: collected.map((x) => x.obj) });
  } catch (err) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ streams: [], error: err.message });
  }
};
module.exports._test = { build, parseRes, normRes, siteName };
