/* Steinheer · Webserver für Railway, ohne Abhängigkeiten
   - liefert das Spiel aus (Ordner public/ oder, im Ein-Datei-Paket, nur index.html)
   - /health für Railways Startprüfung
   - /api/scores: Bestenliste (GET lesen, POST eintragen), gespeichert als JSON-Datei in DATA_DIR */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
const FLAT = !fs.existsSync(PUB); /* Ein-Datei-Paket: index.html liegt neben server.js */
const ROOT = FLAT ? __dirname : PUB;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

/* ---------- Bestenliste ---------- */
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'scores.json');
const SCORE = { win: 3, draw: 1, loss: 0, camp: 10 }; /* gleich wie im Spiel (js/44-scores.js) */
const FACS = ['ba', 'de', 'zw', 'or', 'he'];
const KEEP = 200,
  SHOW = 20,
  MAXB = 16; /* Schlachten pro Feldzug */
let scores = [];
try {
  scores = JSON.parse(fs.readFileSync(FILE, 'utf8'));
} catch (e) {
  scores = [];
}
const save = () => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(scores));
  fs.renameSync(FILE + '.tmp', FILE);
};
const ranked = () =>
  [...scores]
    .sort((a, b) => b.pts - a.pts || b.w - a.w || a.t - b.t)
    .slice(0, SHOW)
    .map(({ ip, ...x }) => x);
/* Eingaben prüfen, Punkte selbst berechnen */
function entry(b) {
  const int = v => Number.isInteger(v) && v >= 0 && v <= MAXB;
  const name = String(b.name || '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .trim()
    .slice(0, 20);
  if (!name || !FACS.includes(b.fac) || ![b.w, b.d, b.l].every(int)) return null;
  if (b.w + b.d + b.l > MAXB) return null;
  const won = b.won === true && b.w >= 10;
  return {
    id: crypto.randomUUID(),
    name,
    fac: b.fac,
    w: b.w,
    d: b.d,
    l: b.l,
    won,
    pts: b.w * SCORE.win + b.d * SCORE.draw + b.l * SCORE.loss + (won ? SCORE.camp : 0),
    t: Date.now()
  };
}
const last = new Map(); /* einfache Bremse: ein Eintrag pro Adresse alle 5 s (Schulklassen teilen oft eine Adresse) */

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
function api(req, res) {
  if (req.method === 'GET') return json(res, 200, ranked());
  if (req.method !== 'POST') return json(res, 405, { error: 'Methode nicht erlaubt' });
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
    .split(',')[0]
    .trim();
  if (Date.now() - (last.get(ip) || 0) < 5000) return json(res, 429, { error: 'Bitte kurz warten' });
  let body = '';
  req.on('data', c => {
    body += c;
    if (body.length > 2000) req.destroy();
  });
  req.on('end', () => {
    let e = null;
    try {
      e = entry(JSON.parse(body));
    } catch (err) {
      e = null;
    }
    if (!e) return json(res, 400, { error: 'Ungültiger Eintrag' });
    last.set(ip, Date.now());
    scores.push(e);
    scores = scores.sort((a, b) => b.pts - a.pts || a.t - b.t).slice(0, KEEP);
    try {
      save();
    } catch (err) {
      console.error('Speichern fehlgeschlagen:', err.message);
    }
    json(res, 200, { id: e.id, list: ranked() });
  });
}

/* ---------- Dateien ---------- */
function file(req, res, p) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    return res.end();
  }
  if (p.endsWith('/')) p += 'index.html';
  if (FLAT && p !== '/index.html') {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Nicht gefunden');
  }
  const f = path.normalize(path.join(ROOT, p));
  if (!f.startsWith(ROOT + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(f, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Nicht gefunden');
    }
    const type = TYPES[path.extname(f)] || 'application/octet-stream';
    const head = {
      'Content-Type': type,
      'Cache-Control': type.startsWith('text/html') ? 'no-cache' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff'
    };
    if (/\bgzip\b/.test(req.headers['accept-encoding'] || '') && /text|json|svg/.test(type)) {
      head['Content-Encoding'] = 'gzip';
      head.Vary = 'Accept-Encoding';
      buf = zlib.gzipSync(buf);
    }
    res.writeHead(200, head);
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}

const server = http.createServer((req, res) => {
  let p;
  try {
    p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch (e) {
    res.writeHead(400);
    return res.end();
  }
  if (p === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  if (p === '/api/scores') return api(req, res);
  file(req, res, p);
});
server.listen(PORT, () =>
  console.log(`Steinheer läuft auf Port ${PORT} · Bestenliste: ${FILE} (${scores.length} Einträge)`)
);
process.on('SIGTERM', () => server.close(() => process.exit(0)));
