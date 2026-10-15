const { cors, decode, checkRepo, loadRepo, loadCode, runProvider, toStremio, imdbToTmdb } = require('../lib/core');

module.exports = async (req, res) => {
  cors(res);
  res.setHeader('Cache-Control', 'public, s-maxage=120');
  try {
    const cfg = decode(req.query.config);
    checkRepo(cfg.r);

    const type = req.query.type === 'movie' ? 'movie' : 'tv';
    const id = decodeURIComponent(String(req.query.id)).replace(/\.json$/, '');
    const [imdb, s, e] = id.split(':');
    if (!/^tt\d+$/.test(imdb)) return res.json({ streams: [] });

    const tmdbId = await imdbToTmdb(imdb, type);
    if (!tmdbId) return res.json({ streams: [] });
    const season = type === 'tv' ? Number(s) : null;
    const episode = type === 'tv' ? Number(e) : null;

    const repo = await loadRepo(cfg.r);
    const picked = repo.scrapers.filter((x) => cfg.p.includes(x.id) &&
      (type === 'movie' ? x.types.includes('movie') : x.types.some((t) => t === 'tv' || t === 'series')));

    const results = await Promise.allSettled(picked.map(async (sc) => {
      const code = await loadCode(sc.url);
      const out = await runProvider(code, { tmdbId, mediaType: type, season, episode });
      return (Array.isArray(out) ? out : []).map((st) => toStremio(st, sc.name)).filter(Boolean);
    }));

    const streams = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    res.json({ streams });
  } catch (err) {
    res.status(200).json({ streams: [], error: err.message });
  }
};
