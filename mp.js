/* Autobattler · Mehrspieler-Server (asynchron, wie die Terraforming-Mars-App)
   - Ein Spiel hat 5 Plätze (alle Völker). Menschen treten per Link bei, freie Plätze füllen KI-Heere.
   - Jeder Mensch hat einen geheimen Schlüssel (t) in seinem persönlichen Link; damit spielt er auf jedem Gerät weiter.
   - Die Spiellogik läuft mit derselben Engine wie im Browser: sie wird aus index.html bzw. public/js geladen.
   - Draft: echte Packweitergabe über Warteschlangen je Platz; KI-Plätze nehmen sofort.
   - Schlachten rechnet der Server: Mensch gegen KI sofort nach „Bereit“, Mensch gegen Mensch, wenn beide bereit sind.
   Speicher: DATA_DIR/mp/<id>.json (Spiel), <id>-<seat>.res.json (letzte Schlacht), <id>-<seat>.sav.json (Spielstand). */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const crypto = require('crypto');

const N = 5; /* höchstens so viele Plätze je Spiel */
const nOf = G => G.n || N,
  nbOf = G => G.nb || X.MPX.NBAT;
const KEEP_DAYS = 45;

/* ---------- Engine laden ---------- */
const STUB = `const mkEl=()=>({addEventListener(){},getBoundingClientRect(){return{left:0,top:0,width:80,height:100}},innerHTML:'',textContent:'',value:'',hidden:false,style:{setProperty(){}},dataset:{},classList:{add(){},remove(){},toggle(){},contains(){return false}},appendChild(){},append(){},remove(){},setAttribute(){},querySelector(){return mkEl()},querySelectorAll(){return[]},animate(){},offsetWidth:0});
const els={};globalThis.document={getElementById:id=>els[id]||(els[id]=mkEl()),createElement:mkEl,createElementNS:mkEl,addEventListener(){},body:mkEl()};
globalThis.setInterval=()=>0;globalThis.clearInterval=()=>0;globalThis.setTimeout=()=>0;globalThis.SERVER=1;`;
function engineSource(dir) {
  const pub = path.join(dir, 'public', 'js', 'order.json');
  if (fs.existsSync(pub)) {
    const order = JSON.parse(fs.readFileSync(pub, 'utf8'));
    return order.map(f => fs.readFileSync(path.join(dir, 'public', 'js', f), 'utf8')).join('\n');
  }
  const h = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const m = h.match(/<script>\n([\s\S]*?)\n\s*<\/script>/);
  if (!m) throw new Error('Spielcode in index.html nicht gefunden');
  return m[1].replace(/<\\\/script/g, '</script');
}
let X = null; /* Zugriff auf die Engine */
function loadEngine(dir) {
  const ctx = vm.createContext({ console: { log() {}, warn() {}, error: console.error }, URL });
  vm.runInContext(
    `${STUB}\n${engineSource(dir)}\n;globalThis.__X={MPX,setS:v=>(S=v),getS:()=>S,GW,GH,FAC};`,
    ctx,
    { filename: 'engine.js' }
  );
  X = ctx.__X;
}
/* Engine-Aufruf mit kleinem Zustand; Einheiten-Nummern laufen im Spiel weiter */
function E(G, map, f) {
  const S = {
    round: G.round,
    uid: G.uid,
    map: map || { i: 0, n: '', mods: [] },
    units: []
  };
  X.setS(S);
  const r = f(X.MPX);
  G.uid = X.getS().uid;
  return r;
}
/* Engine-Ergebnisse sind Objekte aus einem anderen Kontext: über JSON in normale Objekte wandeln */
const plain = o => JSON.parse(JSON.stringify(o));

/* ---------- Speicher ---------- */
let DIR = '';
const games = new Map();
const gfile = id => path.join(DIR, id + '.json');
const xfile = (id, s, k) => path.join(DIR, `${id}-${s}.${k}.json`);
function saveG(G) {
  G.upd = Date.now();
  G.v = (G.v || 0) + 1;
  fs.writeFileSync(gfile(G.id) + '.tmp', JSON.stringify(G));
  fs.renameSync(gfile(G.id) + '.tmp', gfile(G.id));
}
function putX(G, s, k, data) {
  fs.writeFileSync(xfile(G.id, s, k), typeof data === 'string' ? data : JSON.stringify(data));
}
function getX(G, s, k) {
  try {
    return fs.readFileSync(xfile(G.id, s, k), 'utf8');
  } catch (e) {
    return null;
  }
}
function loadAll() {
  fs.mkdirSync(DIR, { recursive: true });
  const old = Date.now() - KEEP_DAYS * 864e5;
  for (const f of fs.readdirSync(DIR)) {
    if (!/^[a-z0-9]+\.json$/.test(f)) continue;
    try {
      const G = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
      if (G.upd < old) {
        for (const g of fs.readdirSync(DIR)) if (g.startsWith(G.id)) fs.unlinkSync(path.join(DIR, g));
        continue;
      }
      games.set(G.id, G);
    } catch (e) {
      console.error('Spiel nicht lesbar:', f, e.message);
    }
  }
}

/* ---------- Hilfen ---------- */
const rid = n => crypto.randomBytes(n).toString('hex');
const shuffle = a => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const clean = (s, n) =>
  String(s || '')
    .replace(/[\u0000-\u001f\u007f<>&"]/g, '')
    .trim()
    .slice(0, n);
const isH = (G, s) => G.seats[s] && G.seats[s].k === 'h';
const humans = G => G.seats.map((x, i) => i).filter(i => isH(G, i));
const seatOf = (G, t) => G.seats.findIndex(x => x.k === 'h' && x.t === t);
const pairOf = (G, s) => (G.pairs || []).find(p => p.a === s || p.b === s);
const opp = (p, s) => (p.a === s ? p.b : p.a);
const flipMod = o => ({ ...o, x: +(X.GW - o.x).toFixed(1), y: +(X.GH - o.y).toFixed(1) });
function rec(G, s, out) {
  const t = (G.tab[s] = G.tab[s] || { w: 0, d: 0, l: 0 });
  if (out === 'win') t.w++;
  else t.l++;
}
const inv = o => (o === 'win' ? 'loss' : 'win');

/* ---------- Lobby ---------- */
function create(name, player, nh, o = {}) {
  const n = Math.max(2, Math.min(N, o.n | 0 || N)),
    nb = [4, 6, 8, 10, 12].includes(o.nb | 0) ? o.nb | 0 : X.MPX.NBAT,
    all = X.MPX.facs(),
    facs = Array.isArray(o.facs) ? all.filter(f => o.facs.includes(f)) : all.slice();
  nh = Math.max(1, Math.min(n, nh | 0 || 2));
  if (facs.length < nh)
    throw new Error('Es müssen mindestens so viele Völker gewählt sein wie Menschen mitspielen.');
  const G = {
    n,
    nb,
    facs,
    id: rid(5),
    name: clean(name, 40) || 'Feldzug',
    created: Date.now(),
    status: 'lobby',
    nh,
    seats: [{ k: 'h', name: clean(player, 20) || 'Spieler 1', t: rid(12), fac: '' }],
    round: 0,
    uid: 1,
    tab: {},
    met: {},
    rests: {},
    homes: {},
    log: []
  };
  games.set(G.id, G);
  saveG(G);
  return G;
}
function join(G, player) {
  if (G.status !== 'lobby') throw new Error('Das Spiel läuft schon.');
  if (G.seats.length >= G.nh) throw new Error('Alle Plätze sind vergeben.');
  const name = clean(player, 20) || 'Spieler ' + (G.seats.length + 1);
  if (G.seats.some(x => x.name.toLowerCase() === name.toLowerCase()))
    throw new Error('Diesen Namen gibt es im Spiel schon.');
  G.seats.push({ k: 'h', name, t: rid(12), fac: '' });
  const s = G.seats.length - 1;
  if (G.seats.length >= G.nh) start(G);
  return s;
}
/* Start: freie Plätze werden KI-Heere, dann wählt jeder Mensch sein Volk */
function start(G) {
  if (G.status !== 'lobby') return;
  const names = shuffle(X.MPX.names()).filter(n => !G.seats.some(x => x.name === n));
  while (G.seats.length < nOf(G)) G.seats.push({ k: 'ai', name: names.shift(), fac: '' });
  G.status = 'run';
  G.phase = 'fac';
}
function setFac(G, s, fac) {
  if (G.phase !== 'fac') throw new Error('Volkswahl ist vorbei.');
  if (!(G.facs || X.MPX.facs()).includes(fac))
    throw new Error('Dieses Volk spielt in diesem Feldzug nicht mit.');
  if (G.seats.some((x, i) => i !== s && x.k === 'h' && x.fac === fac))
    throw new Error('Dieses Volk ist schon vergeben.');
  G.seats[s].fac = fac;
  facDone(G);
}
/* alle Menschen haben gewählt: KI-Völker verteilen, erste Runde */
function facDone(G) {
  if (G.phase === 'fac' && humans(G).every(i => G.seats[i].fac)) {
    /* KI-Völker: zuerst freie, reichen sie nicht, kommen Völker mehrfach vor */
    const fa = G.facs || X.MPX.facs(),
      unused = shuffle(fa.filter(f => !G.seats.some(x => x.fac === f))),
      free = [...unused, ...shuffle(fa.slice()), ...shuffle(fa.slice()), ...shuffle(fa.slice())];
    G.ai = {};
    G.seats.forEach((x, i) => {
      if (x.k !== 'ai') return;
      x.fac = free.shift();
      G.ai[i] = E(G, null, M => plain(M.ai(x.name, x.fac)));
    });
    G.next = {};
    newRound(G);
  }
}

/* ---------- Beenden ---------- */
/* Wer das Spiel angelegt hat, beendet es für alle. Andere steigen aus: ihr Platz wird ein KI-Heer
   (mit frischem Heer seines Volkes), damit niemand auf sie warten muss. */
function leave(G, s) {
  if (G.status === 'over') return;
  if (s === 0 || G.status === 'lobby') {
    if (s !== 0) {
      G.seats.splice(s, 1);
      return;
    }
    G.status = 'over';
    G.phase = 'over';
    G.ended = true;
    return;
  }
  const x = G.seats[s];
  x.k = 'ai';
  x.t = rid(12); /* alter Link verfällt */
  x.ready = false;
  x.left = true;
  delete G.sub[s];
  if (G.phase === 'fac') {
    x.fac = '';
    return facDone(G);
  }
  G.ai[s] = E(G, null, M => plain(M.ai(x.name, x.fac)));
  if (G.phase === 'draft') aiLoop(G);
  else if (G.phase === 'build') {
    const p = pairOf(G, s);
    E(G, p ? p.map : { i: 0, n: '', mods: [] }, M => {
      const a = JSON.parse(JSON.stringify(G.ai[s]));
      M.aiBuild(a);
      G.ai[s] = plain(a);
    });
    /* wartete der Gegner schon auf ihn, kämpft er jetzt gegen die KI */
    const o = p ? opp(p, s) : -1;
    if (p && !p.done && G.sub[o]) fightIfReady(G, p, o);
    roundEnd(G);
  } else if (G.phase === 'route') {
    delete G.routeOpts[s];
    if (!Object.keys(G.routeOpts).length) newRound(G);
  }
}

/* ---------- Paarungen ---------- */
/* Bei ungerader Zahl setzt einer aus: lieber ein KI-Heer, sonst wer am seltensten aussetzte.
   Die übrigen werden so gepaart, dass man möglichst selten zweimal auf denselben trifft. */
function matchings(l) {
  if (!l.length) return [[]];
  const [a, ...r] = l,
    out = [];
  r.forEach((b, i) => matchings(r.filter((_, j) => j !== i)).forEach(m => out.push([[a, b], ...m])));
  return out;
}
function pairings(G) {
  const all = G.seats.map((x, i) => i),
    ais = all.filter(i => !isH(G, i)),
    pool = ais.length ? ais : all,
    r = all.length % 2 ? shuffle(pool.slice()).sort((a, b) => (G.rests[a] || 0) - (G.rests[b] || 0))[0] : -1,
    k = (x, y) => (x < y ? x + '-' + y : y + '-' + x),
    cost = o => o.reduce((s, [x, y]) => s + (G.met[k(x, y)] || 0) * 10, 0);
  const best = shuffle(matchings(shuffle(all.filter(i => i !== r)))).sort((p, q) => cost(p) - cost(q))[0];
  return {
    rest: r,
    pairs: best.map(([x, y]) => {
      /* Heim (sieht die Karte ungedreht, wählt das Schlachtfeld): der Mensch, bei zwei Menschen wer seltener Heim war */
      let h = x,
        g = y;
      if (!isH(G, x) || (isH(G, y) && (G.homes[y] || 0) < (G.homes[x] || 0))) [h, g] = [y, x];
      return { a: h, b: g };
    })
  };
}
const pkey = p => p.a + '-' + p.b;

/* ---------- Runden ---------- */
function newRound(G) {
  G.round++;
  const pl = G.nextPl || pairings(G);
  G.nextPl = null;
  G.rest = pl.rest;
  if (pl.rest >= 0) G.rests[pl.rest] = (G.rests[pl.rest] || 0) + 1;
  const maps = X.MPX.maps();
  G.pairs = pl.pairs.map(p => {
    const mi = G.next[pkey(p)] != null ? G.next[pkey(p)] : Math.floor(Math.random() * maps.length);
    const k = p.a < p.b ? p.a + '-' + p.b : p.b + '-' + p.a;
    G.met[k] = (G.met[k] || 0) + 1;
    if (isH(G, p.a) && isH(G, p.b)) G.homes[p.a] = (G.homes[p.a] || 0) + 1;
    const P = {
      ...p,
      map: { i: mi, n: maps[mi], mods: [] },
      wx: E(G, null, M => M.rollWx()),
      done: false
    };
    return P;
  });
  G.next = {};
  G.sub = {};
  G.routeOpts = {};
  G.log = [];
  G.seats.forEach(x => {
    x.ready = false;
    x.picks = 0;
  });
  if (X.MPX.isDraftR(G.round)) {
    G.phase = 'draft';
    G.dr = { p: 0, q: [] };
    openPacks(G);
  } else draftDone(G);
}
const dirOf = G => (G.dr.p % 2 ? -1 : 1);
function openPacks(G) {
  const P = E(G, null, M => plain(M.packs(nOf(G))));
  G.dr.q = P.map(pk => [pk]);
  aiLoop(G);
}
function pass(G, s) {
  const q = G.dr.q,
    pk = q[s].shift();
  if (pk.it.length) q[(s + dirOf(G) + nOf(G)) % nOf(G)].push(pk);
}
/* KI-Plätze nehmen, solange sie ein Pack vor sich haben; danach ggf. nächstes Pack oder Ende */
function aiLoop(G) {
  for (let go = true; go; ) {
    go = false;
    for (let s = 0; s < nOf(G); s++) {
      if (isH(G, s) || !G.dr.q[s].length) continue;
      const ai = G.ai[s],
        pk = G.dr.q[s][0];
      E(G, null, M => {
        /* über die Engine nehmen; Ergebnis zurück in normale Objekte */
        const a = JSON.parse(JSON.stringify(ai)),
          it = JSON.parse(JSON.stringify(pk.it));
        M.aiPick(a, it);
        G.ai[s] = plain(a);
        pk.it = plain(it);
      });
      pass(G, s);
      go = true;
    }
  }
  if (G.dr.q.every(q => !q.length)) {
    G.dr.p++;
    if (G.dr.p < X.MPX.DRP) openPacks(G);
    else draftDone(G);
  }
}
function pick(G, s, pid, idx) {
  if (G.phase !== 'draft') throw new Error('Kein Draft.');
  const q = G.dr.q[s];
  if (!q.length || q[0].id !== pid) throw new Error('Dieses Pack liegt nicht mehr vor dir.');
  const it = q[0].it.splice(idx, 1)[0];
  if (!it) throw new Error('Diesen Stein gibt es nicht.');
  G.seats[s].picks = (G.seats[s].picks || 0) + 1;
  pass(G, s);
  aiLoop(G);
  return it;
}
/* nach dem Draft: KI-Heere bauen und stellen sich auf der Karte ihrer Schlacht auf */
function draftDone(G) {
  G.phase = 'build';
  G.dr = null;
  G.seats.forEach((x, s) => {
    if (isH(G, s)) return;
    const p = pairOf(G, s),
      map = p ? p.map : { i: 0, n: '', mods: [] };
    E(G, map, M => {
      const a = JSON.parse(JSON.stringify(G.ai[s]));
      M.aiBuild(a);
      G.ai[s] = plain(a);
    });
  });
}
/* „Bereit“: Heer eines Menschen in eigenen Koordinaten, dazu seine Kartenänderungen (Schanzen) */
function ready(G, s, side, mods) {
  if (G.phase !== 'build') throw new Error('Gerade keine Schlacht vorzubereiten.');
  const p = pairOf(G, s);
  if (!p) throw new Error('Du setzt diese Runde aus.');
  if (G.sub[s]) throw new Error('Du bist schon bereit.');
  if (!side || !Array.isArray(side.us)) throw new Error('Heer fehlt.');
  side.abs = 0;
  ['O', 'eyes'].forEach(k => (side[k] = Array.isArray(side[k]) ? side[k] : []));
  side.M = side.M || {};
  side.b = side.b || {};
  G.sub[s] = { side, mods: Array.isArray(mods) ? mods.slice(0, 300) : [] };
  G.seats[s].ready = true;
  try {
    fightIfReady(G, p, s);
  } catch (e) {
    /* Rechenfehler: Meldung zurücknehmen, damit der Spieler es erneut versuchen kann */
    delete G.sub[s];
    G.seats[s].ready = false;
    console.error('Schlacht fehlgeschlagen:', e);
    throw new Error('Die Schlacht konnte nicht berechnet werden. Bitte noch einmal versuchen.');
  }
  roundEnd(G);
}
function fightIfReady(G, p, s) {
  const side = G.sub[s].side,
    o = opp(p, s);
  if (!isH(G, o)) {
    /* gegen KI sofort */
    const m = { i: p.map.i, n: p.map.n, mods: G.sub[s].mods };
    const r = E(G, m, M => plain(M.slim(M.vsAI(side, G.ai[o], m, p.wx))));
    finish(G, p, s, o, r, null);
  } else if (G.sub[o]) {
    const A = G.sub[p.a],
      B = G.sub[p.b],
      m = { i: p.map.i, n: p.map.n, mods: [...A.mods, ...B.mods.map(flipMod)] };
    const [ra, rb] = E(G, m, M => {
      const [x, y] = M.pvp(A.side, B.side, m, p.wx);
      return [plain(M.slim(x)), plain(M.slim(y))];
    });
    finish(G, p, p.a, p.b, ra, rb);
  }
}
function finish(G, p, a, b, ra, rb) {
  p.done = true;
  p.out = ra.out; /* aus Sicht von p.a bzw. des Menschen */
  rec(G, a, ra.out);
  rec(G, b, inv(ra.out));
  const meta = (r, me, foe) => ({ round: G.round, foe, foeN: G.seats[foe].name, out: r.out, r });
  putX(G, a, 'res', meta(ra, a, b));
  if (rb) putX(G, b, 'res', meta(rb, b, a));
  G.log.push({ a, b, out: ra.out });
}
/* Runde fertig, wenn alle Schlachten mit Menschen geschlagen sind: KI gegen KI, dann Routenwahl */
function roundEnd(G) {
  if (G.pairs.some(p => !p.done && (isH(G, p.a) || isH(G, p.b)))) return;
  for (const p of G.pairs.filter(p => !p.done)) {
    const out = E(G, p.map, M => M.duel(G.ai[p.a], G.ai[p.b], p.map, p.wx));
    p.done = true;
    rec(G, p.a, out);
    rec(G, p.b, inv(out));
    G.log.push({ a: p.a, b: p.b, out });
  }
  if (G.round >= nbOf(G)) {
    G.phase = 'over';
    G.status = 'over';
    return;
  }
  /* nächste Paarungen schon jetzt: wer Heim ist (oder gegen eine KI spielt), wählt das nächste Schlachtfeld */
  G.nextPl = pairings(G);
  G.phase = 'route';
  const n = X.MPX.maps().length;
  G.nextPl.pairs.forEach(p => {
    if (!isH(G, p.a)) return;
    const last = (G.pairs.find(q => q.a === p.a || q.b === p.a) || {}).map;
    G.routeOpts[p.a] = shuffle([...Array(n).keys()].filter(i => !last || i !== last.i)).slice(0, 3);
  });
  if (!Object.keys(G.routeOpts).length) newRound(G);
}
function route(G, s, i) {
  if (G.phase !== 'route') throw new Error('Gerade keine Routenwahl.');
  const o = G.routeOpts[s];
  if (!o || !o.includes(i)) throw new Error('Diese Route steht dir nicht offen.');
  const p = G.nextPl.pairs.find(q => q.a === s);
  G.next[pkey(p)] = i;
  delete G.routeOpts[s];
  if (!Object.keys(G.routeOpts).length) newRound(G);
}

/* ---------- Sicht eines Spielers ---------- */
function pub(G) {
  return {
    id: G.id,
    name: G.name,
    status: G.status,
    nh: G.nh,
    n: nOf(G),
    nb: nbOf(G),
    round: G.round,
    phase: G.phase || '',
    created: G.created,
    upd: G.upd,
    seats: G.seats.map(x => ({ name: x.name, k: x.k, fac: x.fac }))
  };
}
function view(G, s) {
  const v = {
    ...pub(G),
    v: G.v,
    me: s,
    nbat: nbOf(G),
    ended: !!G.ended,
    n: nOf(G),
    facs: G.facs || X.MPX.facs(),
    seats: G.seats.map((x, i) => ({
      name: x.name,
      k: x.k,
      fac: x.fac,
      ready: !!x.ready,
      picks: x.picks || 0,
      route: G.phase === 'route' ? !G.routeOpts[i] : true
    })),
    tab: G.tab,
    rest: G.rest,
    log: G.log
  };
  if (G.status === 'lobby' || G.phase === 'fac') return v;
  if (G.phase === 'draft') {
    const q = G.dr.q[s];
    v.dr = { p: G.dr.p, dir: dirOf(G), pack: q.length ? q[0] : null, queue: q.length };
  }
  const p = pairOf(G, s);
  if (p) {
    const o = opp(p, s),
      home = p.a === s;
    v.pair = {
      foe: o,
      home,
      ai: !isH(G, o),
      map: home ? p.map : { ...p.map, flip: 1, mods: p.map.mods.map(flipMod) },
      wx: p.wx,
      done: p.done,
      foeReady: !!G.sub[o] || !isH(G, o)
    };
    if (!isH(G, o) && G.phase !== 'draft') {
      const a = G.ai[o];
      v.pair.foeAI = {
        n: a.n,
        fac: a.fac,
        army: a.army || [],
        col: a.col,
        chr: a.chr,
        form: a.form || ''
      };
    }
  }
  if (G.phase === 'route') {
    v.route = { opts: G.routeOpts[s] || null };
    const np = G.nextPl.pairs.find(q => q.a === s || q.b === s);
    v.route.next = np ? { foe: opp(np, s), chooser: np.a } : null;
  }
  return v;
}

/* ---------- HTTP ---------- */
function send(req, res, code, data) {
  let buf = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
  const head = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (buf.length > 2000 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    buf = zlib.gzipSync(buf);
    head['Content-Encoding'] = 'gzip';
    head.Vary = 'Accept-Encoding';
  }
  res.writeHead(code, head);
  res.end(buf);
}
function body(req, max) {
  return new Promise((ok, no) => {
    let b = '',
      n = 0;
    req.on('data', c => {
      n += c.length;
      if (n > max) {
        no(new Error('Zu groß'));
        req.destroy();
      } else b += c;
    });
    req.on('end', () => {
      try {
        ok(b ? JSON.parse(b) : {});
      } catch (e) {
        no(new Error('Ungültige Daten'));
      }
    });
  });
}
/* /api/mp/games            GET Liste · POST {name, player, nh} anlegen
   /api/mp/g/<id>           GET ?t= Sicht (ohne t: öffentlich)
   /api/mp/g/<id>/<aktion>  POST {t, …}: join, start, fac, pick, ready, route, save
   /api/mp/g/<id>/res|sav   GET ?t= letzte Schlacht bzw. Spielstand */
async function handle(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); /* api, mp, … */
  try {
    if (parts[2] === 'games') {
      if (req.method === 'GET') {
        const L = [...games.values()]
          .filter(G => G.status !== 'over' || Date.now() - G.upd < 7 * 864e5)
          .sort((a, b) => b.upd - a.upd)
          .slice(0, 60)
          .map(pub);
        return send(req, res, 200, L);
      }
      const b = await body(req, 4000);
      const G = create(b.name, b.player, b.nh, { n: b.n, nb: b.nb, facs: b.facs });
      if (G.nh <= 1) start(G);
      saveG(G);
      return send(req, res, 200, { id: G.id, t: G.seats[0].t, seat: 0 });
    }
    if (parts[2] !== 'g') return send(req, res, 404, { error: 'Unbekannt' });
    const G = games.get(parts[3]);
    if (!G) return send(req, res, 404, { error: 'Spiel nicht gefunden.' });
    const act = parts[4] || '';
    if (req.method === 'GET') {
      const t = url.searchParams.get('t') || '',
        s = seatOf(G, t);
      if (!act) return send(req, res, 200, s < 0 ? pub(G) : view(G, s));
      if (s < 0) return send(req, res, 403, { error: 'Kein Zugang.' });
      if (act === 'res' || act === 'sav') {
        const d = getX(G, s, act);
        return d ? send(req, res, 200, d) : send(req, res, 404, { error: 'Nichts gespeichert.' });
      }
      return send(req, res, 404, { error: 'Unbekannt' });
    }
    const b = await body(req, act === 'save' || act === 'ready' ? 4e6 : 8000);
    if (act === 'join') {
      const s = join(G, b.player);
      saveG(G);
      return send(req, res, 200, { id: G.id, t: G.seats[s].t, seat: s });
    }
    const s = seatOf(G, b.t);
    if (s < 0) return send(req, res, 403, { error: 'Kein Zugang.' });
    let out = {};
    if (act === 'start') {
      if (s !== 0) throw new Error('Nur wer das Spiel angelegt hat, kann es starten.');
      start(G);
    } else if (act === 'fac') setFac(G, s, b.fac);
    else if (act === 'pick') out.it = pick(G, s, b.pid, b.i | 0);
    else if (act === 'ready') ready(G, s, b.side, b.mods);
    else if (act === 'route') route(G, s, b.i | 0);
    else if (act === 'leave') {
      leave(G, s);
      saveG(G);
      return send(req, res, 200, { ok: 1 });
    } else if (act === 'save') {
      putX(G, s, 'sav', JSON.stringify(b.S || null));
      return send(req, res, 200, { ok: 1 });
    } else return send(req, res, 404, { error: 'Unbekannte Aktion' });
    saveG(G);
    return send(req, res, 200, { ...out, view: view(G, s) });
  } catch (e) {
    if (!/^[A-ZÄÖÜ]/.test(e.message)) console.error('MP-Fehler:', e);
    return send(req, res, 400, { error: e.message });
  }
}
function init(dir, dataDir) {
  DIR = path.join(dataDir, 'mp');
  loadEngine(dir);
  loadAll();
  return games.size;
}
module.exports = {
  init,
  handle,
  _t: { games, create, join, start, setFac, pick, ready, route, view, leave, X: () => X }
};
