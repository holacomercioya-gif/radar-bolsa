// api/run-stocks.js
//
// Orquestador para el plan gratuito de Vercel (Hobby), que solo permite
// 2 cron jobs por proyecto. En vez de tener 5 crons separados para el
// circuito de acciones/CEDEARs/bonos, este endpoint los llama en un
// solo request.
//
// IMPORTANTE: el plan Hobby tiene un límite duro de 60 segundos por
// función. Correr los 5 pasos uno atrás del otro (en fila) se pasaba de
// ese límite, así que acá:
//   1. sync-market-data se ejecuta primero y se espera a que termine,
//      porque los otros 4 pasos necesitan los precios del día ya guardados.
//   2. enrich-scores, enrich-argentina, enrich-longterm y recommendations
//      se disparan los 4 EN PARALELO (no dependen entre sí), así el tiempo
//      total es el del más lento de los 4, no la suma de los 4.
//
// Se dispara automáticamente vía Vercel Cron (ver vercel.json), o a mano:
//   https://tu-dominio.vercel.app/api/run-stocks?secret=TU_SECRETO

const PARALLEL_STEPS = ['enrich-scores', 'enrich-argentina', 'enrich-longterm', 'recommendations'];

async function callStep(base, step) {
  try {
    const r = await fetch(`${base}/api/${step}?secret=${process.env.CRON_SECRET}`);
    const text = await r.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { step, ok: r.ok, status: r.status, data };
  } catch (err) {
    return { step, ok: false, error: err.message };
  }
}

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

  // Paso 1: sync-market-data, se espera solo (los demás dependen de esto)
  results.push(await callStep(base, 'sync-market-data'));

  // Pasos 2-5: en paralelo, no dependen entre sí
  const parallelResults = await Promise.all(PARALLEL_STEPS.map((step) => callStep(base, step)));
  results.push(...parallelResults);

  const allOk = results.every((r) => r.ok);
  res.status(allOk ? 200 : 207).json({ ok: allOk, results });
};
