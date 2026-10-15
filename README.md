# Nuvio Bridge

Config page + Stremio addon that runs providers from any Nuvio plugin repo.

## Deploy
1. Push this folder to a GitHub repo, import it in Vercel (no build settings needed).
2. Add env vars in Vercel:
   - `TMDB_API_KEY` (required): free key from themoviedb.org (v3 key or v4 token). Stremio sends IMDb ids, plugins want TMDB ids.
   - `ALLOWED_REPOS` (strongly recommended): comma-separated exact manifest URLs you trust, e.g. `https://plugin.eclipsia.dpdns.org/manifest.json`.
3. Open your Vercel URL, paste the repo manifest URL, pick providers, copy the link, paste it into Nuvio/Stremio addons.

## Notes
- Plugin code is fetched live (cached 5 min), so domain/scraper fixes in the repo apply without redeploying.
- The Node `vm` sandbox is NOT a hard security boundary. Only use repos you trust (ALLOWED_REPOS).
- Providers with in-app settings (hasSettings) run with empty settings.
- Anime/Kitsu ids are not mapped; only IMDb (tt...) ids.
