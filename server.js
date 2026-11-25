/* Steinheer · Webserver für Railway: liefert das Spiel (eine Datei index.html) aus, ohne Abhängigkeiten */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PORT = process.env.PORT || 3000;
const page = fs.readFileSync(path.join(__dirname, 'index.html'));
const pageGz = zlib.gzipSync(page);

http
  .createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('ok');
    }
    if (p !== '/' && p !== '/index.html') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Nicht gefunden');
    }
    const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      ...(gz ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {})
    });
    res.end(req.method === 'HEAD' ? undefined : gz ? pageGz : page);
  })
  .listen(PORT, () => console.log(`Steinheer läuft auf Port ${PORT}`));
