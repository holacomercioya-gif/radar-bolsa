// api/close-recommendations.js
//
// Revisa las recomendaciones que el radar hizo hace unos días y todavía
// no se cerraron. Compara el precio de entrada contra el precio actual
// y calcula si hubiera dado ganancia o pérdida. Esto es lo que en unas
// semanas nos va a dar una probabilidad REAL de acierto (no inventada).
//
// Corto plazo se cierra a los 5 días hábiles. Mediano/largo plazo a los 30.
//
// Disparo manual para probar:
//   https://tu-dominio.vercel.app/api/close-recommendations?secret=TU_SECRETO

function getTodayAR() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date());
}

function daysBetween(dateStr1, dateStr2) {
  return Math.round((new Date(dateStr2) - new Date(dateStr1)) / 86400000);
}

async function supabaseRequest(path, { method = 'GET', body, prefer } = {}) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${path}`;
  const headers = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'content-type': 'application/json',
  };
  if (prefer) headers.prefer = prefer;

  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Supabase ${method} ${path} -> ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
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

  const today = getTodayAR();
  const openEntries = await supabaseRequest('recommendation_journal?cerrado=eq.false&select=id,asset_id,date_recommended,radar_mode,entrada');

  let closedCount = 0;

  for (const entry of openEntries) {
    const minDays = entry.radar_mode === 'moderado_largo' ? 30 : 5;
    if (daysBetween(entry.date_recommended, today) < minDays) continue;
    if (entry.entrada == null) continue;

    const [latestPrice] = await supabaseRequest(
      `daily_prices?asset_id=eq.${entry.asset_id}&order=date.desc&limit=1&select=close`
    );
    if (!latestPrice) continue;

    const resultadoPct = Math.round(((latestPrice.close - entry.entrada) / entry.entrada) * 10000) / 100;

    await supabaseRequest(`recommendation_journal?id=eq.${entry.id}`, {
      method: 'PATCH',
      body: { resultado_pct: resultadoPct, cerrado: true },
    });
    closedCount++;
  }

  res.status(200).json({ ok: true, revisadas: openEntries.length, cerradas: closedCount });
};
