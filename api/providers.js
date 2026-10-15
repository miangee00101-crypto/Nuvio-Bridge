const { cors, checkRepo, loadRepo } = require('../lib/core');

module.exports = async (req, res) => {
  cors(res);
  try {
    const repo = String(req.query.repo || '').trim();
    checkRepo(repo);
    const data = await loadRepo(repo);
    res.json({ name: data.name, scrapers: data.scrapers.map(({ url, ...rest }) => rest) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
};
