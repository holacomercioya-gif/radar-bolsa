// api/run-stocks.js
//
// Orquestador para el plan gratuito de Vercel (Hobby), que solo permite
// 2 cron jobs por proyecto. En vez de tener 5 crons separados para el
// circuito de acciones/CEDEARs/bonos, este endpoint los llama en orden,
// uno atrás del otro, y junta los resultados.
//
// Orden de ejecución:
//   1. sync-market-data   -> trae precios del día (data912)
//   2. enrich-scores      -> score corto plazo EE.UU. (Alpha Vantage)
//   3. enrich-argentina   -> score corto plazo Argentina
//   4. enrich-longterm    -> score fundamental mediano/largo plazo
//   5. recommendations    -> cierra y evalúa recomendaciones abiertas
//
// Se dispara automáticamente vía Vercel Cron (ver vercel.json), o a mano:
//   https://tu-dominio.vercel.app/api/run-stocks?secret=TU_SECRETO

const STEPS = [
  'sync-market-data',
  'enrich-scores',
  'enrich-argentina',
  'enrich-longterm',
  'recommendations',
];

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
