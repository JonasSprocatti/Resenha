/* Salas online do Resenha: "Todos juntos" do Quem Sou Eu? e o Stop online.
   Cada celular conversa com esta função; o estado fica no Redis (Upstash) ligado ao projeto no Vercel.
   Chaves por sala (todas expiram em 6 horas sem uso):
     resenha:<código>:meta        anfitrião, jogo ('qse' ou 'stop') e data de criação
     resenha:<código>:players     hash pid -> {name, lvl, t}
     resenha:<código>:pts         hash pid -> pontos acumulados
     resenha:<código>:round       rodada atual
     resenha:<código>:hits:<n>    Quem Sou Eu?: ordem de quem acertou (zset pela hora)
     resenha:<código>:ans:<n>     Stop: respostas de cada um (hash pid -> {índice: texto})
     resenha:<código>:votes:<n>   Stop: votos (hash "eleitor|autor|índice" -> '1' vale, '0' não vale)
     resenha:<código>:scored:<n>  trava para pontuar a rodada uma vez só */

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const TTL = 6 * 3600;
const MAX_PLAYERS = 20;
const LV = ['f', 'm', 'd', 'i'];
const MULT = { f: 1, m: 2, d: 3, i: 5 };
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const STOP_GRACE = 3000; /* tempo para chegarem as últimas respostas depois do Stop */

function fail(status, code) { const e = new Error(code); e.status = status; e.code = code; return e; }
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, n);
const K = (code, part) => `resenha:${code}:${part}`;
const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const roomCode = (v) => { const c = clean(v, 4).toUpperCase(); if (!/^[A-Z]{4}$/.test(c)) throw fail(404, 'no_room'); return c; };
const level = (v) => (LV.includes(v) ? v : 'f');
/* jogadores podem escolher a Mista ('x'); cada carta continua com o nível real dela */
const playerLevel = (v) => (LV.includes(v) || v === 'x' ? v : 'f');
const json = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };
const pairs = (arr) => { const o = {}; for (let i = 0; i < (arr || []).length; i += 2) o[arr[i]] = arr[i + 1]; return o; };
/* compara respostas sem acento, sem maiúscula e sem espaço sobrando */
const norm = (s) => clean(s, 40).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const firstLetter = (s) => { const m = norm(s).match(/[a-z0-9]/); return m ? m[0].toUpperCase() : ''; };

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

async function touch(code) {
  await redis([
    ['EXPIRE', K(code, 'meta'), TTL], ['EXPIRE', K(code, 'players'), TTL],
    ['EXPIRE', K(code, 'pts'), TTL], ['EXPIRE', K(code, 'round'), TTL]
  ]);
}

async function getMeta(code) {
  const [raw] = await redis([['GET', K(code, 'meta')]]);
  const meta = json(raw);
  if (!meta) throw fail(404, 'no_room');
  return meta;
}
async function getRound(code) { const [raw] = await redis([['GET', K(code, 'round')]]); return json(raw); }
const saveRound = (code, round) => redis([['SET', K(code, 'round'), JSON.stringify(round), 'EX', TTL]]);

async function state(code, pid) {
  const [metaRaw, playersRaw, ptsRaw, roundRaw] = await redis([
    ['GET', K(code, 'meta')], ['HGETALL', K(code, 'players')], ['HGETALL', K(code, 'pts')], ['GET', K(code, 'round')]
  ]);
  const meta = json(metaRaw);
  if (!meta) throw fail(404, 'no_room');
  const game = meta.game === 'stop' ? 'stop' : 'qse';
  const pl = pairs(playersRaw); const pts = pairs(ptsRaw);
  const players = Object.keys(pl).map((id) => { const p = json(pl[id]) || {}; return { pid: id, name: p.name || 'Jogador', lvl: playerLevel(p.lvl), t: p.t || 0, pts: Number(pts[id]) || 0 }; })
    .sort((a, b) => a.t - b.t);
  let round = json(roundRaw);
  const out = { now: Date.now(), code, game, host: meta.host, players, round, hits: [] };
  if (!round) return out;

  if (game === 'qse') {
    const [z] = await redis([['ZRANGE', K(code, 'hits:' + round.n), 0, -1, 'WITHSCORES']]);
    for (let i = 0; i < (z || []).length; i += 2) out.hits.push({ pid: z[i], t: Number(z[i + 1]) });
    return out;
  }

  /* Stop: quando o tempo acaba, a primeira leitura leva todo mundo para a análise */
  if (round.phase === 'play' && round.endAt && Date.now() > round.endAt + 500) {
    round = Object.assign({}, round, { phase: 'review', stopAt: round.endAt, stoppedBy: null, reviewIdx: 0 });
    await saveRound(code, round);
    out.round = round;
  }
  if (round.phase === 'play' || round.phase === 'review') {
    const [ansRaw, votesRaw] = await redis([['HGETALL', K(code, 'ans:' + round.n)], ['HGETALL', K(code, 'votes:' + round.n)]]);
    const a = pairs(ansRaw); const answers = {};
    Object.keys(a).forEach((id) => { answers[id] = json(a[id]) || {}; });
    if (round.phase === 'play') {
      /* durante a rodada ninguém vê as respostas dos outros, só quantas já preencheram */
      out.filled = {};
      Object.keys(answers).forEach((id) => { out.filled[id] = Object.values(answers[id]).filter((v) => clean(v, 40)).length; });
      out.mine = answers[pid] || {};
    } else {
      out.answers = answers;
      out.votes = pairs(votesRaw);
    }
  }
  return out;
}

/* ---------- Quem Sou Eu? ---------- */
async function finishQse(code, round) {
  const [lock] = await redis([['SET', K(code, 'scored:' + round.n), '1', 'NX', 'EX', TTL]]);
  if (lock !== 'OK') return;
  const [order] = await redis([['ZRANGE', K(code, 'hits:' + round.n), 0, -1]]);
  const n = Object.keys(round.cards || {}).length;
  const points = {};
  (order || []).forEach((id, pos) => { const c = round.cards[id]; points[id] = Math.max(0, n - 1 - pos) * (MULT[c && c.lvl] || 1); });
  const done = Object.assign({}, round, { over: true, order: order || [], points });
  const cmds = Object.keys(points).filter((id) => points[id] > 0).map((id) => ['HINCRBY', K(code, 'pts'), id, points[id]]);
  cmds.push(['SET', K(code, 'round'), JSON.stringify(done), 'EX', TTL], ['EXPIRE', K(code, 'pts'), TTL]);
  await redis(cmds);
}

/* ---------- Stop ---------- */
function stopAnswers(round, raw) {
  const out = {};
  round.cats.forEach((_, i) => { const t = clean((raw || {})[i], 40); if (t) out[i] = t; });
  return out;
}
async function finishStop(code, round) {
  const [lock] = await redis([['SET', K(code, 'scored:' + round.n), '1', 'NX', 'EX', TTL]]);
  if (lock !== 'OK') return;
  const [ansRaw, votesRaw] = await redis([['HGETALL', K(code, 'ans:' + round.n)], ['HGETALL', K(code, 'votes:' + round.n)]]);
  const a = pairs(ansRaw); const votes = pairs(votesRaw);
  const ids = round.players || [];
  const results = {};
  ids.forEach((id) => { results[id] = { raw: 0, pts: 0, per: [] }; });
  round.cats.forEach((_, i) => {
    const valid = {};
    ids.forEach((id) => {
      const t = clean((json(a[id]) || {})[i], 40);
      let ok = !!t && firstLetter(t) === round.letter;
      if (ok) {
        /* cai se mais da metade dos outros votou que não vale; quem não votou conta como "vale" */
        const others = ids.filter((x) => x !== id);
        const no = others.filter((v) => votes[`${v}|${id}|${i}`] === '0').length;
        if (no > others.length - no) ok = false;
      }
      valid[id] = ok ? norm(t) : null;
      results[id].per[i] = { t, ok, pts: 0 };
    });
    ids.forEach((id) => {
      if (valid[id] == null) return;
      const same = ids.some((x) => x !== id && valid[x] === valid[id]);
      const p = same ? 5 : 10;
      results[id].per[i].pts = p; results[id].raw += p;
    });
  });
  const mult = MULT[round.lvl] || 1;
  ids.forEach((id) => { results[id].pts = results[id].raw * mult; });
  const done = Object.assign({}, round, { phase: 'done', results });
  const cmds = ids.filter((id) => results[id].pts > 0).map((id) => ['HINCRBY', K(code, 'pts'), id, results[id].pts]);
  cmds.push(['SET', K(code, 'round'), JSON.stringify(done), 'EX', TTL], ['EXPIRE', K(code, 'pts'), TTL]);
  await redis(cmds);
}
async function saveAnswers(code, round, pid, raw) {
  await redis([['HSET', K(code, 'ans:' + round.n), pid, JSON.stringify(stopAnswers(round, raw))], ['EXPIRE', K(code, 'ans:' + round.n), TTL]]);
}

const ACTIONS = {
  async create(b) {
    const name = clean(b.name, 24) || 'Anfitrião';
    const game = b.game === 'stop' ? 'stop' : 'qse';
    const pid = newId();
    for (let i = 0; i < 10; i++) {
      const code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
      const [ok] = await redis([['SET', K(code, 'meta'), JSON.stringify({ host: pid, game, created: Date.now() }), 'NX', 'EX', TTL]]);
      if (ok === 'OK') {
        await redis([['HSET', K(code, 'players'), pid, JSON.stringify({ name, lvl: playerLevel(b.lvl), t: Date.now() })], ['EXPIRE', K(code, 'players'), TTL]]);
        return { code, pid, game, now: Date.now() };
      }
    }
    throw fail(500, 'no_code');
  },

  async join(b) {
    const code = roomCode(b.code);
    const name = clean(b.name, 24) || 'Jogador';
    const meta = await getMeta(code);
    let pid = clean(b.pid, 24);
    const [exists, count] = await redis([['HEXISTS', K(code, 'players'), pid || '-'], ['HLEN', K(code, 'players')]]);
    let t = Date.now();
    if (exists) { const [raw] = await redis([['HGET', K(code, 'players'), pid]]); t = (json(raw) || {}).t || t; }
    else { if (count >= MAX_PLAYERS) throw fail(409, 'full'); pid = newId(); }
    await redis([['HSET', K(code, 'players'), pid, JSON.stringify({ name, lvl: playerLevel(b.lvl), t })]]);
    await touch(code);
    return { code, pid, game: meta.game === 'stop' ? 'stop' : 'qse', now: Date.now() };
  },

  async me(b) {
    const code = roomCode(b.code); const pid = clean(b.pid, 24);
    const [raw] = await redis([['HGET', K(code, 'players'), pid]]);
    const p = json(raw); if (!p) throw fail(404, 'no_player');
    if (b.name != null) p.name = clean(b.name, 24) || p.name;
    if (b.lvl != null) p.lvl = playerLevel(b.lvl);
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

  /* Quem Sou Eu? */
  async start(b) {
    const code = roomCode(b.code); const pid = clean(b.pid, 24);
    const meta = await getMeta(code);
    if (meta.game === 'stop') throw fail(409, 'wrong_game');
    if (meta.host !== pid) throw fail(403, 'not_host');
    const s = await state(code);
    const ids = new Set(s.players.map((p) => p.pid));
    const cards = {};
    Object.keys(b.cards || {}).forEach((id) => {
      const c = b.cards[id] || {};
      if (ids.has(id) && clean(c.w, 80)) cards[id] = { w: clean(c.w, 80), cat: clean(c.cat, 40), lvl: level(c.lvl) };
    });
    if (Object.keys(cards).length < 2) throw fail(409, 'few_players');
    if (s.round && !s.round.over) await finishQse(code, s.round);
    const n = (s.round ? s.round.n : 0) + 1;
    await saveRound(code, { n, startAt: Date.now() + 4000, cards, over: false });
    await touch(code);
    return { ok: true, n, now: Date.now() };
  },

  async hit(b) {
    const code = roomCode(b.code); const pid = clean(b.pid, 24);
    const round = await getRound(code);
    if (!round || !round.cards || round.n !== Number(b.n) || round.over) throw fail(409, 'closed');
    if (!round.cards[pid]) throw fail(409, 'not_in_round');
    if (Date.now() < round.startAt) throw fail(409, 'too_early');
    const [, , count] = await redis([
      ['ZADD', K(code, 'hits:' + round.n), 'NX', Date.now(), pid], ['EXPIRE', K(code, 'hits:' + round.n), TTL],
      ['ZCARD', K(code, 'hits:' + round.n)]
    ]);
    if (count >= Object.keys(round.cards).length - 1) await finishQse(code, round);
    return { ok: true, now: Date.now() };
  },

  async undo(b) {
    const code = roomCode(b.code); const pid = clean(b.pid, 24);
    const round = await getRound(code);
    if (!round || !round.cards || round.n !== Number(b.n) || round.over) throw fail(409, 'closed');
    await redis([['ZREM', K(code, 'hits:' + round.n), pid]]);
    return { ok: true, now: Date.now() };
  },

  /* encerra a rodada: no Quem Sou Eu? pontua; no Stop leva para a análise ou fecha a análise */
  async end(b) {
    const code = roomCode(b.code); const pid = clean(b.pid, 24);
    const meta = await getMeta(code);
    if (meta.host !== pid) throw fail(403, 'not_host');
    const round = await getRound(code);
    if (!round) return { ok: true, now: Date.now() };
    if (meta.game === 'stop') {
      if (round.phase === 'play') await saveRound(code, Object.assign(round, { phase: 'review', stopAt: Date.now(), stoppedBy: null, reviewIdx: 0 }));
      else if (round.phase === 'review') await finishStop(code, round);
    } else if (!round.over) await finishQse(code, round);
    return { ok: true, now: Date.now() };
  },

  /* Stop */
  async sstart(b) {
    const code = roomCode(b.code); const pid = clean(b.pid, 24);
    const meta = await getMeta(code);
    if (meta.game !== 'stop') throw fail(409, 'wrong_game');
    if (meta.host !== pid) throw fail(403, 'not_host');
    const letter = clean(b.letter, 1).toUpperCase();
    const cats = (Array.isArray(b.cats) ? b.cats : []).map((c) => clean(c, 40)).filter(Boolean).slice(0, 16);
    if (!/^[A-Z]$/.test(letter) || !cats.length) throw fail(400, 'bad');
    const s = await state(code);
    if (s.players.length < 2) throw fail(409, 'few_players');
    if (s.round && s.round.phase === 'review') await finishStop(code, s.round);
    const n = (s.round ? s.round.n : 0) + 1;
    const limit = Math.min(600, Math.max(0, Math.round(Number(b.limit) || 0)));
    const startAt = Date.now() + 3500;
    await saveRound(code, {
      n, letter, cats, lvl: level(b.lvl), startAt, endAt: limit ? startAt + limit * 1000 : null,
      phase: 'play', players: s.players.map((p) => p.pid), reviewIdx: 0
    });
    await touch(code);
    return { ok: true, n, now: Date.now() };
  },

  async sanswer(b) {
    const code = roomCode(b.code); const pid = clean(b.pid, 24);
    const round = await getRound(code);
    if (!round || !round.cats || round.n !== Number(b.n)) throw fail(409, 'closed');
    if (!(round.players || []).includes(pid)) throw fail(409, 'not_in_round');
    const open = round.phase === 'play' || (round.phase === 'review' && Date.now() < (round.stopAt || 0) + STOP_GRACE + 1000);
    if (!open) throw fail(409, 'closed');
    await saveAnswers(code, round, pid, b.answers);
    return { ok: true, now: Date.now() };
  },

  async sstop(b) {
    const code = roomCode(b.code); const pid = clean(b.pid, 24);
    const round = await getRound(code);
    if (!round || !round.cats || round.n !== Number(b.n) || round.phase !== 'play') throw fail(409, 'closed');
    if (!(round.players || []).includes(pid)) throw fail(409, 'not_in_round');
    if (Date.now() < round.startAt) throw fail(409, 'too_early');
    const mine = stopAnswers(round, b.answers);
    if (Object.keys(mine).length < round.cats.length) throw fail(409, 'not_filled');
    await saveAnswers(code, round, pid, mine);
    await saveRound(code, Object.assign(round, { phase: 'review', stopAt: Date.now(), stoppedBy: pid, reviewIdx: 0 }));
    return { ok: true, now: Date.now() };
  },

  async svote(b) {
    const code = roomCode(b.code); const pid = clean(b.pid, 24);
    const round = await getRound(code);
    if (!round || !round.cats || round.n !== Number(b.n) || round.phase !== 'review') throw fail(409, 'closed');
    const author = clean(b.author, 24); const idx = Number(b.idx);
    const ids = round.players || [];
    if (!ids.includes(pid) || !ids.includes(author) || author === pid || !(idx >= 0 && idx < round.cats.length)) throw fail(400, 'bad');
    await redis([['HSET', K(code, 'votes:' + round.n), `${pid}|${author}|${idx}`, b.valid ? '1' : '0'], ['EXPIRE', K(code, 'votes:' + round.n), TTL]]);
    return { ok: true, now: Date.now() };
  },

  async snext(b) {
    const code = roomCode(b.code); const pid = clean(b.pid, 24);
    const meta = await getMeta(code);
    if (meta.host !== pid) throw fail(403, 'not_host');
    const round = await getRound(code);
    if (!round || !round.cats || round.n !== Number(b.n) || round.phase !== 'review') throw fail(409, 'closed');
    if (Date.now() < (round.stopAt || 0) + STOP_GRACE) throw fail(409, 'wait');
    if (round.reviewIdx < round.cats.length - 1) await saveRound(code, Object.assign(round, { reviewIdx: round.reviewIdx + 1 }));
    else await finishStop(code, round);
    return { ok: true, now: Date.now() };
  }
};

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!REDIS_URL || !REDIS_TOKEN) return res.status(503).json({ error: 'no_db', now: Date.now() });
  try {
    if (req.method === 'GET') {
      if (req.query.ping) return res.status(200).json({ ok: true, now: Date.now() });
      return res.status(200).json(await state(roomCode(req.query.code), clean(req.query.pid, 24)));
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
