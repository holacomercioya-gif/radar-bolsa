// api/enrich-longterm.js
//
// Analiza una lista de referencia de empresas grandes y líquidas para
// inversión de MEDIANO/LARGO PLAZO (meses), usando datos fundamentales
// reales de Alpha Vantage: calidad del negocio (ROE), crecimiento de
// ingresos, y valoración (PE ratio). Guarda el resultado en `scores`
// con radar_mode = 'moderado_largo'.
//
// A diferencia del score de corto plazo (que mira la variación del día),
// este mira la salud del negocio — no importa si la acción subió o bajó hoy.
//
// Como el plan gratis de Alpha Vantage tiene límite de consultas, este
// motor analiza solo 4 empresas por corrida, rotando por día sobre la
// lista completa — en unos días cubre toda la lista y se va actualizando
// sola en rotación continua (los fundamentales no cambian día a día,
// así que no hace falta actualizarlos todos los días).
//
// Disparo manual para probar:
//   https://tu-dominio.vercel.app/api/enrich-longterm?secret=TU_SECRETO

const WATCHLIST = [
  'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA',
  'META', 'JPM', 'V', 'JNJ', 'KO',
  'PG', 'XOM', 'WMT', 'HD', 'DIS',
  'NFLX', 'ADBE', 'CRM', 'PFE', 'INTC',
];

const BATCH_SIZE = 4;
const ALPHA_VANTAGE_KEY = process.env.ALPHA_VANTAGE_KEY;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getTodayAR() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date());
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
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

function pickTodaysBatch() {
  const dayIndex = Math.floor(Date.now() / 86400000);
  const start = (dayIndex * BATCH_SIZE) % WATCHLIST.length;
  const batch = [];
  for (let i = 0; i < BATCH_SIZE; i++) {
    batch.push(WATCHLIST[(start + i) % WATCHLIST.length]);
  }
  return batch;
}

async function fetchOverview(ticker) {
  try {
    const url = `https://www.alphavantage.co/query?function=OVERVIEW&symbol=${ticker}&apikey=${ALPHA_VANTAGE_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!data || !data.Symbol) return null;
    return {
      peRatio: parseFloat(data.PERatio) || null,
      roe: parseFloat(data.ReturnOnEquityTTM) || null,
      revenueGrowth: parseFloat(data.QuarterlyRevenueGrowthYOY) || null,
      name: data.Name || ticker,
    };
  } catch {
    return null;
  }
}

async function ensureAsset(ticker) {
  const [upserted] = await supabaseRequest('assets?on_conflict=ticker', {
    method: 'POST',
    body: [{ ticker, name: ticker, market: 'USA', asset_type: 'accion' }],
    prefer: 'resolution=merge-duplicates,return=representation',
  });
  return upserted.id;
}

async function getLatestPrice(assetId) {
  const rows = await supabaseRequest(`daily_prices?asset_id=eq.${assetId}&order=date.desc&limit=1&select=close`);
  return rows[0]?.close ?? null;
}

function computeLongTermScore({ peRatio, roe, revenueGrowth }) {
  const valoracionScore = peRatio != null ? clamp(100 - Math.abs(peRatio - 18) * 3, 0, 100) : null;
  const calidadScore = roe != null ? clamp(roe * 300, 0, 100) : null;
  const crecimientoScore = revenueGrowth != null ? clamp(50 + revenueGrowth * 150, 0, 100) : null;

  const parts = [valoracionScore, calidadScore, crecimientoScore].filter((v) => v != null);
  const total = parts.length > 0 ? Math.round(parts.reduce((s, v) => s + v, 0) / parts.length) : null;

  return { valoracionScore, calidadScore, crecimientoScore, total };
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

  if (!ALPHA_VANTAGE_KEY) {
    res.status(500).json({ error: 'Falta configurar ALPHA_VANTAGE_KEY en Vercel' });
    return;
  }

  const today = getTodayAR();
  const batch = pickTodaysBatch();
  const scoreRows = [];

  for (let i = 0; i < batch.length; i++) {
    const ticker = batch[i];
    const overview = await fetchOverview(ticker);

    if (overview) {
      const assetId = await ensureAsset(ticker);
      const price = await getLatestPrice(assetId);
      const { valoracionScore, calidadScore, crecimientoScore, total } = computeLongTermScore(overview);

      if (total != null) {
        scoreRows.push({
          asset_id: assetId,
          date: today,
          radar_mode: 'moderado_largo',
          score_total: total,
          calidad_empresarial: calidadScore != null ? Math.round(calidadScore) : null,
          crecimiento: crecimientoScore != null ? Math.round(crecimientoScore) : null,
          valoracion: valoracionScore != null ? Math.round(valoracionScore) : null,
          entrada_sugerida: price,
          objetivo_sugerido: price != null ? Math.round(price * 1.15 * 100) / 100 : null,
          stop_loss: price != null ? Math.round(price * 0.88 * 100) / 100 : null,
        });
      }
    }

    if (i < batch.length - 1) await sleep(12000);
  }

  if (scoreRows.length > 0) {
    await supabaseRequest('scores?on_conflict=asset_id,date,radar_mode', {
      method: 'POST',
      body: scoreRows,
      prefer: 'resolution=merge-duplicates',
    });
  }

  res.status(200).json({ ok: true, date: today, analizadas: batch, guardadas: scoreRows.length });
};
