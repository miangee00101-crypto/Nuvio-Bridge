const nodeCrypto = require('crypto');
const { cors, decode } = require('../lib/core');

// Deliberately does NOT fetch the plugin repo, so the addon stays installable even if the repo is down.
module.exports = (req, res) => {
  cors(res);
  try {
    const cfg = decode(req.query.config);
    const short = nodeCrypto.createHash('sha1').update(req.query.config).digest('hex').slice(0, 8);
    res.setHeader('Cache-Control', 'public, s-maxage=300');
    res.json({
      id: 'community.nuvio.bridge.' + short,
      version: '1.0.0',
      name: `Nuvio Bridge (${cfg.p.length})`,
      description: 'Runs selected Nuvio plugin providers. Providers: ' + cfg.p.join(', '),
      resources: ['stream'],
      types: ['movie', 'series'],
      idPrefixes: ['tt'],
      catalogs: [],
      behaviorHints: { configurable: false },
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
};
