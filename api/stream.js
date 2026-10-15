const { cached, cors, decode, checkRepo, loadRepo, loadCode, runProvider, toStremio, imdbToTmdb } = require('../lib/core');

// Return whatever has finished by this deadline instead of waiting for the slowest provider.
const DEADLINE = Number(process.env.DEADLINE_MS || 4500);

module.exports = async (req, res) => {
  cors(res);
  try {
    const cfg = decode(req.query.config);
    checkRepo(cfg.r);

    const type = req.query.type === 'movie' ? 'movie' : 'tv';
    const id = decodeURIComponent(String(req.query.id)).replace(/\.json$/, '');
    const [imdb, s, e] = id.split(':');
    if (!/^tt\d+$/.test(imdb)) return res.json({ streams: [] });
    const season = type === 'tv' ? Number(s) : null;
    const episode = type === 'tv' ? Number(e) : null;

    // repo manifest and TMDB lookup run at the same time
    const [repo, tmdbId] = await Promise.all([loadRepo(cfg.r), imdbToTmdb(imdb, type)]);
    if (!tmdbId) return res.json({ streams: [] });

    const picked = repo.scrapers.filter((x) => cfg.p.includes(x.id) &&
      (type === 'movie' ? x.types.includes('movie') : x.types.some((t) => t === 'tv' || t === 'series')));

    const collected = [];
    let pending = picked.length;

    await new Promise((resolve) => {
      if (!pending) return resolve();
      const timer = setTimeout(resolve, DEADLINE);
      picked.forEach((sc) => {
        // per-provider result cache: slow providers that finish after the deadline
        // still fill the cache, so the next request returns them instantly
        cached(`res:${sc.id}:${tmdbId}:${season}:${episode}`, async () => {
          const code = await loadCode(sc.url);
          const out = await runProvider(code, { tmdbId, mediaType: type, season, episode });
          return (Array.isArray(out) ? out : []).map((st) => toStremio(st, sc.name)).filter(Boolean);
        })
          .then((v) => collected.push(...v))
          .catch(() => {})
          .finally(() => { if (--pending === 0) { clearTimeout(timer); resolve(); } });
      });
    });

    const complete = pending === 0;
    res.setHeader('Cache-Control', complete ? 'public, s-maxage=300, stale-while-revalidate=600' : 'public, s-maxage=5');
    res.json({ streams: collected.slice() });
  } catch (err) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ streams: [], error: err.message })
      ;
  }
};
