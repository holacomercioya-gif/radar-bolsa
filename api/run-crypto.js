// api/run-crypto.js
//
// Orquestador para el plan gratuito de Vercel (Hobby), que solo permite
// 2 cron jobs por proyecto. Junta el circuito de cripto (2 pasos) en un
// solo endpoint, llamado una vez por día.
//
// Orden de ejecución:
//   1. sync-crypto-data -> trae top 30 cripto (CoinGecko)
//   2. enrich-crypto    -> score corto plazo cripto
//
// Se dispara automáticamente vía Vercel Cron (ver vercel.json), o a mano:
//   https://tu-dominio.vercel.app/api/run-crypto?secret=TU_SECRETO

const STEPS = ['sync-crypto-data', 'enrich-crypto'];

module.exports = async function handler(req, res) {
  const secret = req.query?.secret || req.headers['x-cron-secret'];
  const authHeader = req.headers['authorization'];
  const validCron = authHeader === `Bearer ${process.env.CRON_SECRET}`;
  const validManual = secret === process.env.CRON_SECRET;

  if (!validCron && !validManual) {
    res.status(401).json({ error: 'No autorizado' });
    return;
  }

  const base = `https://${req.headers.host}`;
  const results = [];

  for (const step of STEPS) {
    try {
      const r = await fetch(`${base}/api/${step}?secret=${process.env.CRON_SECRET}`);
      const text = await r.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
      results.push({ step, ok: r.ok, status: r.status, data });
    } catch (err) {
      results.push({ step, ok: false, error: err.message });
    }
  }

  const allOk = results.every((r) => r.ok);
  res.status(allOk ? 200 : 207).json({ ok: allOk, results });
};
