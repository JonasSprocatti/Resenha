/* Salas do modo "Todos juntos" do Quem Sou Eu?.
   Cada celular conversa com esta função; o estado fica no Redis (Upstash) ligado ao projeto no Vercel.
   Chaves por sala (todas expiram em 6 horas sem uso):
     resenha:<código>:meta     anfitrião e data de criação
     resenha:<código>:players  hash pid -> {name, lvl, t}
     resenha:<código>:pts      hash pid -> pontos acumulados
     resenha:<código>:round    rodada atual {n, startAt, cards, over, order, points}
     resenha:<código>:hits:<n> ordem de quem acertou (zset pela hora do acerto)
     resenha:<código>:scored:<n> trava para pontuar a rodada uma vez só */

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const TTL = 6 * 3600;
const MAX_PLAYERS = 20;
const LV = ['f', 'm', 'd', 'i'];
const MULT = { f: 1, m: 2, d: 3, i: 5 };
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

function fail(status, code) { const e = new Error(code); e.status = status; e.code = code; return e; }
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, n);
const K = (code, part) => `resenha:${code}:${part}`;
const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const roomCode = (v) => { const c = clean(v, 4).toUpperCase(); if (!/^[A-Z]{4}$/.test(c)) throw fail(404, 'no_room'); return c; };
const level = (v) => (LV.includes(v) ? v : 'f');
const json = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };
const pairs = (arr) => { const o = {}; for (let i = 0; i < (arr || []).length; i += 2) o[arr[i]] = arr[i + 1]; return o; };

async function redis(cmds) {
  const r = await fetch(`${REDIS_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds)
  });
  if (!r.ok) throw fail(502, 'db');
  const out = await r.json();
  return out.map((x) => { if (x.error) throw fail(502, 'db'); return x.result; });
}

async function touch(code, extra = []) {
  await redis([
    ['EXPIRE', K(code, 'meta'), TTL], ['EXPIRE', K(code, 'players'), TTL],
    ['EXPIRE', K(code, 'pts'), TTL], ['EXPIRE', K(code, 'round'), TTL], ...extra
  ]);
}

async function getMeta(code) {
  const [raw] = await redis([['GET', K(code, 'meta')]]);
  const meta = json(raw);
  if (!meta) throw fail(404, 'no_room');
  return meta;
}

async function state(code) {
  const [metaRaw, playersRaw, ptsRaw, roundRaw] = await redis([
    ['GET', K(code, 'meta')], ['HGETALL', K(code, 'players')], ['HGETALL', K(code, 'pts')], ['GET', K(code, 'round')]
  ]);
  const meta = json(metaRaw);
  if (!meta) throw fail(404, 'no_room');
  const pl = pairs(playersRaw); const pts = pairs(ptsRaw);
  const players = Object.keys(pl).map((pid) => { const p = json(pl[pid]) || {}; return { pid, name: p.name || 'Jogador', lvl: level(p.lvl), t: p.t || 0, pts: Number(pts[pid]) || 0 }; })
    .sort((a, b) => a.t - b.t);
  const round = json(roundRaw);
  let hits = [];
  if (round) {
    const [z] = await redis([['ZRANGE', K(code, 'hits:' + round.n), 0, -1, 'WITHSCORES']]);
    for (let i = 0; i < (z || []).length; i += 2) hits.push({ pid: z[i], t: Number(z[i + 1]) });
  }
  return { now: Date.now(), code, host: meta.host, players, round, hits };
}

async function finish(code, round) {
  const [lock] = await redis([['SET', K(code, 'scored:' + round.n), '1', 'NX', 'EX', TTL]]);
  if (lock !== 'OK') return;
  const [order] = await redis([['ZRANGE', K(code, 'hits:' + round.n), 0, -1]]);
  const n = Object.keys(round.cards || {}).length;
  const points = {};
  (order || []).forEach((pid, pos) => { const c = round.cards[pid]; points[pid] = Math.max(0, n - 1 - pos) * (MULT[c && c.lvl] || 1); });
  const done = Object.assign({}, round, { over: true, order: order || [], points });
  const cmds = Object.keys(points).filter((pid) => points[pid] > 0).map((pid) => ['HINCRBY', K(code, 'pts'), pid, points[pid]]);
  cmds.push(['SET', K(code, 'round'), JSON.stringify(done), 'EX', TTL], ['EXPIRE', K(code, 'pts'), TTL]);
  await redis(cmds);
}

const ACTIONS = {
  async create(b) {
    const name = clean(b.name, 24) || 'Anfitrião';
    const pid = newId();
    for (let i = 0; i < 10; i++) {
      const code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
      const [ok] = await redis([['SET', K(code, 'meta'), JSON.stringify({ host: pid, created: Date.now() }), 'NX', 'EX', TTL]]);
      if (ok === 'OK') {
        await redis([['HSET', K(code, 'players'), pid, JSON.stringify({ name, lvl: level(b.lvl), t: Date.now() })], ['EXPIRE', K(code, 'players'), TTL]]);
        return { code, pid, now: Date.now() };
      }
    }
    throw fail(500, 'no_code');
  },

  async join(b) {
    const code = roomCode(b.code);
    const name = clean(b.name, 24) || 'Jogador';
    await getMeta(code);
    let pid = clean(b.pid, 24);
    const [exists, count] = await redis([['HEXISTS', K(code, 'players'), pid || '-'], ['HLEN', K(code, 'players')]]);
    let t = Date.now();
    if (exists) { const [raw] = await redis([['HGET', K(code, 'players'), pid]]); t = (json(raw) || {}).t || t; }
    else { if (count >= MAX_PLAYERS) throw fail(409, 'full'); pid = newId(); }
    await redis([['HSET', K(code, 'players'), pid, JSON.stringify({ name, lvl: level(b.lvl), t })]]);
    await touch(code);
    return { code, pid, now: Date.now() };
  },

  async me(b) {
    const code = roomCode(b.code); const pid = clean(b.pid, 24);
    const [raw] = await redis([['HGET', K(code, 'players'), pid]]);
    const p = json(raw); if (!p) throw fail(404, 'no_player');
    if (b.name != null) p.name = clean(b.name, 24) || p.name;
    if (b.lvl != null) p.lvl = level(b.lvl);
    await redis([['HSET', K(code, 'players'), pid, JSON.stringify(p)]]);
    return { ok: true, now: Date.now() };
  },

  async leave(b) {
    const code = roomCode(b.code); const pid = clean(b.pid, 24);
    const meta = await getMeta(code);
    await redis([['HDEL', K(code, 'players'), pid]]);
    if (meta.host === pid) {
      const s = await state(code);
      if (s.players.length) await redis([['SET', K(code, 'meta'), JSON.stringify(Object.assign(meta, { host: s.players[0].pid })), 'EX', TTL]]);
    }
    return { ok: true, now: Date.now() };
  },

  async start(b) {
    const code = roomCode(b.code); const pid = clean(b.pid, 24);
    const meta = await getMeta(code);
    if (meta.host !== pid) throw fail(403, 'not_host');
    const s = await state(code);
    const ids = new Set(s.players.map((p) => p.pid));
    const cards = {};
    Object.keys(b.cards || {}).forEach((id) => {
      const c = b.cards[id] || {};
      if (ids.has(id) && clean(c.w, 80)) cards[id] = { w: clean(c.w, 80), cat: clean(c.cat, 40), lvl: level(c.lvl) };
    });
    if (Object.keys(cards).length < 2) throw fail(409, 'few_players');
    if (s.round && !s.round.over) await finish(code, s.round);
    const n = (s.round ? s.round.n : 0) + 1;
    const round = { n, startAt: Date.now() + 4000, cards, over: false };
    await redis([['SET', K(code, 'round'), JSON.stringify(round), 'EX', TTL]]);
    await touch(code);
    return { ok: true, n, now: Date.now() };
  },

  async hit(b) {
    const code = roomCode(b.code); const pid = clean(b.pid, 24);
    const [raw] = await redis([['GET', K(code, 'round')]]);
    const round = json(raw);
    if (!round || round.n !== Number(b.n) || round.over) throw fail(409, 'closed');
    if (!round.cards[pid]) throw fail(409, 'not_in_round');
    if (Date.now() < round.startAt) throw fail(409, 'too_early');
    const [, , count] = await redis([
      ['ZADD', K(code, 'hits:' + round.n), 'NX', Date.now(), pid], ['EXPIRE', K(code, 'hits:' + round.n), TTL],
      ['ZCARD', K(code, 'hits:' + round.n)]
    ]);
    if (count >= Object.keys(round.cards).length - 1) await finish(code, round);
    return { ok: true, now: Date.now() };
  },

  async undo(b) {
    const code = roomCode(b.code); const pid = clean(b.pid, 24);
    const [raw] = await redis([['GET', K(code, 'round')]]);
    const round = json(raw);
    if (!round || round.n !== Number(b.n) || round.over) throw fail(409, 'closed');
    await redis([['ZREM', K(code, 'hits:' + round.n), pid]]);
    return { ok: true, now: Date.now() };
  },

  async end(b) {
    const code = roomCode(b.code); const pid = clean(b.pid, 24);
    const meta = await getMeta(code);
    if (meta.host !== pid) throw fail(403, 'not_host');
    const [raw] = await redis([['GET', K(code, 'round')]]);
    const round = json(raw);
    if (round && !round.over) await finish(code, round);
    return { ok: true, now: Date.now() };
  }
};

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!REDIS_URL || !REDIS_TOKEN) return res.status(503).json({ error: 'no_db', now: Date.now() });
  try {
    if (req.method === 'GET') {
      if (req.query.ping) return res.status(200).json({ ok: true, now: Date.now() });
      return res.status(200).json(await state(roomCode(req.query.code)));
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'method', now: Date.now() });
    const body = typeof req.body === 'string' ? (json(req.body) || {}) : (req.body || {});
    const fn = ACTIONS[body.action];
    if (!fn) return res.status(400).json({ error: 'action', now: Date.now() });
    return res.status(200).json(await fn(body));
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.code || 'server', now: Date.now() });
  }
};
