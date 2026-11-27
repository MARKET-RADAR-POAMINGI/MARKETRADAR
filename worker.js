// Market Radar - simulazione crypto sempre attiva (Cloudflare Worker + D1)
// Stesso formato dati e stesso motore di segnale di index.html.
// Binding D1: nome variabile DB. Cron: * * * * *
// Opzionale: variabile segreta ADMIN_TOKEN per il pulsante "Azzera simulazione" della pagina.
// Endpoint: /state  /diag  /run  /reset (POST, con ?token=)

const SIM_START = 10000;
const SIM_PER_POS = 1000;
const SIM_LEVERAGE = 10;
const SIM_MAX_OPEN = 10;
const THRESHOLD = 68;
const BATCH = 8;          // quante serie storiche aggiornare per ciclo
const BUDGET = 45;        // richieste esterne massime per ciclo (limite gratuito: 50)
const SERIES_TTL = 55 * 60 * 1000;
const ATH_TTL = 24 * 3600 * 1000;
const RETRY_FAIL = 10 * 60 * 1000;

const CRYPTO = [
  ["bitcoin","BTC","Bitcoin"],["ethereum","ETH","Ethereum"],["binancecoin","BNB","BNB"],
  ["solana","SOL","Solana"],["ripple","XRP","XRP"],["cardano","ADA","Cardano"],
  ["dogecoin","DOGE","Dogecoin"],["tron","TRX","TRON"],["avalanche-2","AVAX","Avalanche"],
  ["chainlink","LINK","Chainlink"],["polkadot","DOT","Polkadot"],["litecoin","LTC","Litecoin"],
  ["bitcoin-cash","BCH","Bitcoin Cash"],["stellar","XLM","Stellar"],["toncoin","TON","Toncoin"],
  ["uniswap","UNI","Uniswap"],["near","NEAR","NEAR"],["aptos","APT","Aptos"],
  ["arbitrum","ARB","Arbitrum"],["optimism","OP","Optimism"],["shiba-inu","SHIB","Shiba Inu"],
  ["hedera-hashgraph","HBAR","Hedera"],["internet-computer","ICP","Internet Computer"],
  ["filecoin","FIL","Filecoin"],["cosmos","ATOM","Cosmos"],["algorand","ALGO","Algorand"],
  ["vechain","VET","VeChain"],["polygon-ecosystem-token","POL","Polygon"],["aave","AAVE","Aave"],
  ["maker","MKR","Maker"],["render-token","RENDER","Render"],["injective-protocol","INJ","Injective"],
  ["sui","SUI","Sui"],["sei-network","SEI","Sei"],["pepe","PEPE","Pepe"],
  ["dogwifcoin","WIF","dogwifhat"],["bonk","BONK","Bonk"],["the-graph","GRT","The Graph"],
  ["immutable-x","IMX","Immutable"],["lido-dao","LDO","Lido DAO"]
];

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "*",
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS } });
const text = (body, status = 200) => new Response(body, {
  status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...CORS } });

// ---------- Database ----------
async function ensureTable(env) {
  if (!env.DB) throw new Error("Database non collegato: nel Worker manca il binding D1 con nome DB (maiuscolo).");
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)").run();
}
async function kvGet(env, k) {
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k = ?").bind(k).first();
  if (row && row.v) { try { return JSON.parse(row.v); } catch (e) { /* corrotto */ } }
  return null;
}
async function kvSet(env, k, v) {
  await env.DB.prepare("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)").bind(k, JSON.stringify(v)).run();
}
function newSim() {
  return { cash: SIM_START, positions: {}, closed: [], curve: [], lastCycleT: null, lastOps: [], cycles: 0 };
}
function newState() {
  return { sim: newSim(), meta: { updatedAt: null, assets: 0, source: null, error: null } };
}
async function loadState(env) {
  await ensureTable(env);
  const st = await kvGet(env, "simstate");
  if (st && st.sim && st.meta) return st;
  return newState();
}

// ---------- Rete ----------
async function call(ctx, url, ms = 8000) {
  if (++ctx.n > BUDGET) throw new Error("limite richieste per ciclo raggiunto");
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { accept: "application/json", "user-agent": "market-radar-sim/2.0" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

// Prezzi spot: ognuna restituisce { SIMBOLO: prezzo }
const PRICE_SOURCES = [
  ["KuCoin", async ctx => {
    const d = await call(ctx, "https://api.kucoin.com/api/v1/market/allTickers");
    const m = {};
    for (const x of ((d.data && d.data.ticker) || [])) if (x.symbol.endsWith("-USDT")) m[x.symbol.slice(0, -5)] = parseFloat(x.last);
    return m;
  }],
  ["OKX", async ctx => {
    const d = await call(ctx, "https://www.okx.com/api/v5/market/tickers?instType=SPOT");
    const m = {};
    for (const x of (d.data || [])) if (x.instId.endsWith("-USDT")) m[x.instId.slice(0, -5)] = parseFloat(x.last);
    return m;
  }],
  ["Gate.io", async ctx => {
    const d = await call(ctx, "https://api.gateio.ws/api/v4/spot/tickers");
    const m = {};
    for (const x of d) if (x.currency_pair.endsWith("_USDT")) m[x.currency_pair.slice(0, -5)] = parseFloat(x.last);
    return m;
  }],
  ["Binance", async ctx => {
    let last;
    for (const u of ["https://api.binance.com/api/v3/ticker/price", "https://data-api.binance.vision/api/v3/ticker/price"]) {
      try {
        const d = await call(ctx, u);
        const m = {};
        for (const x of d) if (x.symbol.endsWith("USDT")) m[x.symbol.slice(0, -4)] = parseFloat(x.price);
        return m;
      } catch (e) { last = e; }
    }
    throw last;
  }],
];

async function getPrices(ctx) {
  const errs = [];
  for (const [name, fn] of PRICE_SOURCES) {
    try {
      const m = await fn(ctx);
      const n = CRYPTO.filter(c => m[c[1]] > 0).length;
      if (n >= 10) return { prices: m, source: name };
      errs.push(name + ": pochi simboli (" + n + ")");
    } catch (e) { errs.push(name + ": " + e.message); }
  }
  throw new Error(errs.join(" | "));
}

// Candele orarie (ultime 168): { closes:[...], hi, lo } dal piu' vecchio al piu' recente
async function getHourly(ctx, sym) {
  const now = Math.floor(Date.now() / 1000);
  const tries = [
    async () => {
      const d = await call(ctx, "https://api.kucoin.com/api/v1/market/candles?type=1hour&symbol=" + sym + "-USDT&startAt=" + (now - 170 * 3600) + "&endAt=" + now);
      return (d.data || []).map(k => ({ c: parseFloat(k[2]), h: parseFloat(k[3]), l: parseFloat(k[4]), t: +k[0] }));
    },
    async () => {
      const d = await call(ctx, "https://www.okx.com/api/v5/market/candles?instId=" + sym + "-USDT&bar=1H&limit=168");
      return (d.data || []).map(k => ({ c: parseFloat(k[4]), h: parseFloat(k[2]), l: parseFloat(k[3]), t: Math.floor(+k[0] / 1000) }));
    },
    async () => {
      const d = await call(ctx, "https://data-api.binance.vision/api/v3/klines?symbol=" + sym + "USDT&interval=1h&limit=168");
      return d.map(k => ({ c: parseFloat(k[4]), h: parseFloat(k[2]), l: parseFloat(k[3]), t: Math.floor(+k[0] / 1000) }));
    },
  ];
  let last = null;
  for (const f of tries) {
    try {
      const rows = (await f()).filter(r => isFinite(r.c) && r.c > 0).sort((a, b) => a.t - b.t);
      if (rows.length >= 30) {
        return { closes: rows.map(r => r.c), hi: Math.max(...rows.map(r => r.h)), lo: Math.min(...rows.map(r => r.l)) };
      }
      last = new Error("storico troppo corto");
    } catch (e) { last = e; }
  }
  throw last || new Error("nessuna fonte");
}

// Massimo/minimo storico (candele giornaliere KuCoin) per la distanza dai massimi
async function getAth(ctx, sym) {
  const now = Math.floor(Date.now() / 1000);
  const d = await call(ctx, "https://api.kucoin.com/api/v1/market/candles?type=1day&symbol=" + sym + "-USDT&startAt=" + (now - 1400 * 86400) + "&endAt=" + now);
  const rows = (d.data || []).map(k => ({ h: parseFloat(k[3]), l: parseFloat(k[4]) })).filter(r => isFinite(r.h) && isFinite(r.l));
  if (!rows.length) throw new Error("nessun dato");
  return { ath: Math.max(...rows.map(r => r.h)), atl: Math.min(...rows.map(r => r.l)) };
}

// ---------- Indicatori e segnale (copia del motore di index.html) ----------
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
function stdev(a) {
  if (a.length < 2) return 0;
  const m = avg(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / (a.length - 1));
}
function smaAt(arr, n) { return arr.length < n ? null : avg(arr.slice(-n)); }
function rsiCalc(arr, period) {
  if (arr.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = arr.length - period; i < arr.length; i++) {
    const d = arr[i] - arr[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  const ag = gain / period, al = loss / period;
  if (al === 0) return 100;
  return 100 - (100 / (1 + ag / al));
}
function realizedVol(arr) {
  if (arr.length < 8) return null;
  const rets = [];
  for (let i = 1; i < arr.length; i++) if (arr[i - 1] > 0) rets.push(arr[i] / arr[i - 1] - 1);
  if (rets.length < 6) return null;
  return stdev(rets.slice(-30)) * Math.sqrt(24 * 365) * 100;
}
function computeSignal(a) {
  const series = a.series || [];
  const price = a.price;
  let raw = 0;
  const smaF = smaAt(series, 24), smaS = smaAt(series, 120);
  if (smaF != null && smaS != null && price != null) {
    if (price > smaF && smaF > smaS) raw += 2;
    else if (price > smaF) raw += 1;
    else if (price < smaF && smaF < smaS) raw -= 2;
    else raw -= 1;
  }
  const rsi = rsiCalc(series, 14);
  if (rsi != null) {
    if (rsi >= 75) raw -= 1.5;
    else if (rsi >= 65) raw += 0;
    else if (rsi >= 45) raw += 1;
    else if (rsi >= 30) raw += 1.5;
    else raw += 1;
  }
  const m7 = a.chg7;
  if (m7 != null && isFinite(m7)) {
    if (m7 > 5) raw += 1; else if (m7 > 1) raw += 0.5; else if (m7 > -1) raw += 0;
    else if (m7 > -5) raw -= 0.5; else raw -= 1;
  }
  const hi = a.high52;
  if (hi && price) {
    const dd = (price / hi - 1) * 100;
    if (dd > -5) raw -= 0.5; else if (dd > -15) raw += 0.5; else if (dd > -30) raw += 1; else raw += 0.5;
  }
  const vol = realizedVol(series);
  if (vol != null) { if (vol > 60) raw -= 1; else if (vol > 35) raw -= 0.5; }
  const score = clamp(50 + raw * 7, 0, 100);
  let state = score >= 68 ? "buy" : (score >= 50 ? "watch" : "wait");
  if (state === "buy" && rsi != null && rsi > 78) state = "watch";
  return { score: Math.round(score), state };
}

// ---------- Ciclo di simulazione ----------
function equityOf(sim, px) {
  let v = sim.cash;
  for (const sym of Object.keys(sim.positions)) {
    const p = sim.positions[sym];
    const cur = px[sym] != null ? px[sym] : p.entry;
    v += p.margin + (cur - p.entry) * p.qty;
  }
  return v;
}

async function runCycle(env) {
  await ensureTable(env);
  const st = await loadState(env);
  const sim = st.sim;
  const ctx = { n: 0 };
  const now = Date.now();

  let quote;
  try { quote = await getPrices(ctx); }
  catch (e) { st.meta.error = e.message; await kvSet(env, "simstate", st); return st; }
  const prices = quote.prices;

  // serie storiche in cache, aggiornate a gruppi
  const cache = (await kvGet(env, "series")) || {};
  let dirty = false;
  const due = CRYPTO.map(c => c[1]).filter(s => prices[s] > 0).filter(s => {
    const e = cache[s];
    if (!e) return true;
    if (e.fail && now - e.fail < RETRY_FAIL) return false;
    return now - (e.t || 0) > SERIES_TTL || !e.ath || now - (e.athT || 0) > ATH_TTL;
  }).sort((a, b) => ((cache[a] && cache[a].t) || 0) - ((cache[b] && cache[b].t) || 0)).slice(0, BATCH);

  await Promise.all(due.map(async s => {
    const e = cache[s] || {};
    try {
      if (!e.t || now - e.t > SERIES_TTL) {
        const h = await getHourly(ctx, s);
        e.closes = h.closes; e.hi = h.hi; e.lo = h.lo; e.t = now; delete e.fail;
      }
      if (!e.ath || now - (e.athT || 0) > ATH_TTL) {
        try { const a = await getAth(ctx, s); e.ath = a.ath; e.atl = a.atl; e.athT = now; } catch (err) { /* resta il massimo settimanale */ }
      }
    } catch (err) { e.fail = now; }
    cache[s] = e; dirty = true;
  }));
  if (dirty) await kvSet(env, "series", cache);

  // asset con segnale
  const assets = [];
  for (const c of CRYPTO) {
    const sym = c[1], e = cache[sym], price = prices[sym];
    if (!e || !e.closes || e.closes.length < 30 || !(price > 0)) continue;
    const series = e.closes.slice(); series[series.length - 1] = price;
    const a = {
      sym, name: c[2], cls: "Crypto", price, series,
      chg7: (price / series[0] - 1) * 100,
      high52: Math.max(e.ath || 0, e.hi || 0, price) || null,
    };
    a.sig = computeSignal(a);
    assets.push(a);
  }
  const bySym = {};
  assets.forEach(a => { bySym[a.sym] = a; });

  st.meta.updatedAt = now; st.meta.source = quote.source; st.meta.error = null; st.meta.assets = assets.length;

  if (!assets.length) {
    st.meta.error = "storici in caricamento (" + Object.keys(cache).filter(k => cache[k].closes).length + "/" + CRYPTO.length + "), il primo ciclo parte tra pochi minuti";
    await kvSet(env, "simstate", st);
    return st;
  }

  const ops = [];
  // vendite
  for (const sym of Object.keys(sim.positions)) {
    const p = sim.positions[sym], a = bySym[sym];
    if (!a) continue;
    if (a.sig.state === "buy" && a.sig.score >= THRESHOLD) continue;
    const pnl = (a.price - p.entry) * p.qty;
    sim.cash += p.margin + pnl;
    sim.closed.push({ sym, name: p.name, cls: p.cls, entry: p.entry, exit: a.price, qty: p.qty, pnl,
      pct: (a.price / p.entry - 1) * 100, openT: p.openT, closeT: now });
    ops.push({ side: "sell", sym, name: p.name, price: a.price, pnl, pct: (a.price / p.entry - 1) * 100 });
    delete sim.positions[sym];
  }
  if (sim.closed.length > 400) sim.closed = sim.closed.slice(-400);

  // acquisti
  const buys = assets.filter(a => a.sig.state === "buy" && a.sig.score >= THRESHOLD && !sim.positions[a.sym])
    .sort((x, y) => y.sig.score - x.sig.score);
  for (const a of buys) {
    if (Object.keys(sim.positions).length >= SIM_MAX_OPEN) break;
    const margin = Math.min(SIM_PER_POS, sim.cash);
    if (margin < 50) break;
    sim.cash -= margin;
    sim.positions[a.sym] = { sym: a.sym, name: a.name, cls: a.cls, entry: a.price,
      qty: (margin * SIM_LEVERAGE) / a.price, margin, leverage: SIM_LEVERAGE, openT: now, score: a.sig.score };
    ops.push({ side: "buy", sym: a.sym, name: a.name, price: a.price, pnl: null, pct: null });
  }

  const px = {}; assets.forEach(a => { px[a.sym] = a.price; });
  sim.curve.push({ t: now, equity: equityOf(sim, px) });
  if (sim.curve.length > 300) sim.curve = sim.curve.slice(-300);
  sim.lastOps = ops;
  sim.lastCycleT = now;
  sim.cycles++;
  await kvSet(env, "simstate", st);
  return st;
}

// ---------- Diagnosi ----------
async function diag(env) {
  const out = []; let ok = true;
  const line = (label, good, detail) => { out.push((good ? "OK      " : "ERRORE  ") + label + (detail ? ": " + detail : "")); if (!good) ok = false; };
  if (!env.DB) {
    line("Database (binding DB)", false, "non collegato. Settings > Bindings > Add > D1 database, nome variabile DB.");
  } else {
    try {
      await ensureTable(env);
      line("Database e tabella kv", true, "collegato, tabella pronta");
      const st = await loadState(env);
      const cache = (await kvGet(env, "series")) || {};
      const n = Object.keys(cache).filter(k => cache[k].closes).length;
      line("Storici crypto", n >= 20, n + "/" + CRYPTO.length + " caricati" + (n < 20 ? " (si completano in pochi minuti)" : ""));
      if (st.meta.updatedAt) {
        const age = Math.round((Date.now() - st.meta.updatedAt) / 1000);
        line("Trigger (cron)", age < 180, "ultimo aggiornamento " + age + " secondi fa, cicli di simulazione " + st.sim.cycles +
          (age >= 180 ? ". Controlla il cron * * * * * in Settings > Trigger events." : ""));
      } else line("Trigger (cron)", false, "nessun aggiornamento ancora. Aspetta un minuto oppure apri /run.");
      if (st.meta.error) out.push("AVVISO  Ultimo messaggio: " + st.meta.error);
      out.push("INFO    posizioni aperte: " + Object.keys(st.sim.positions).length + ", capitale libero: " + st.sim.cash.toFixed(2));
    } catch (e) { line("Database", false, e.message); }
  }
  for (const [name, fn] of PRICE_SOURCES) {
    try { const m = await fn({ n: 0 }); out.push("OK      Prezzi " + name + ": " + CRYPTO.filter(c => m[c[1]] > 0).length + " crypto"); }
    catch (e) { out.push("AVVISO  Prezzi " + name + ": " + e.message); }
  }
  try { const h = await getHourly({ n: 0 }, "BTC"); out.push("OK      Candele orarie (BTC): " + h.closes.length + " punti"); }
  catch (e) { line("Candele orarie (BTC)", false, e.message); }
  out.push(""); out.push("esito: " + (ok ? "Tutto in ordine" : "Ci sono problemi, leggi le righe ERRORE sopra"));
  return text(out.join("\n"));
}

// ---------- Entry point ----------
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case "/": return json({ ok: true, name: "Market Radar simulazione", endpoints: ["/state", "/diag", "/run", "/reset"] });
        case "/state": return json(await loadState(env));
        case "/diag": return await diag(env);
        case "/run": {
          const st = await runCycle(env);
          return json({ ok: !st.meta.error, message: st.meta.error, equity: equityOf(st.sim, {}), positions: Object.keys(st.sim.positions).length,
            cycles: st.sim.cycles, assets: st.meta.assets, source: st.meta.source });
        }
        case "/reset": {
          if (request.method !== "POST") return text("Usa il pulsante Azzera simulazione della pagina (richiede ADMIN_TOKEN).", 405);
          if (!env.ADMIN_TOKEN || url.searchParams.get("token") !== env.ADMIN_TOKEN) return text("password errata", 403);
          const st = await loadState(env);
          st.sim = newSim();
          await kvSet(env, "simstate", st);
          return json({ ok: true });
        }
        default: return json({ error: "non trovato" }, 404);
      }
    } catch (e) { return json({ error: String(e && e.message || e) }, 500); }
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(runCycle(env).catch(() => {})); },
};
