const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = 3000;
const HTTPS_PORT = 3443;
const certPath = path.join(os.homedir(), '.jarvis-tls.json');

async function start() {
  const selfsigned = require('selfsigned');
  const httpProxy = require('http-proxy');

  let pems;
  if (fs.existsSync(certPath)) {
    pems = JSON.parse(fs.readFileSync(certPath, 'utf-8'));
  } else {
    pems = await selfsigned.generate([{ name: 'commonName', value: 'jarvis.local' }], { days: 3650 });
    fs.writeFileSync(certPath, JSON.stringify(pems));
  }

  const proxy = httpProxy.createProxyServer({ target: `http://127.0.0.1:${PORT}`, ws: true, changeOrigin: true });
  proxy.on('error', (err, _req, res) => {
    if (['ECONNRESET', 'ECONNREFUSED', 'EPIPE'].includes(err.code)) return;
    try { res.writeHead(502); res.end(); } catch {}
  });

  const server = https.createServer({ key: pems.private, cert: pems.cert }, (req, res) => proxy.web(req, res));

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    if (req.url && req.url.includes('webpack-hmr')) {
      const key = req.headers['sec-websocket-key'];
      if (key) {
        const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        socket.on('data', () => {});
      } else { socket.destroy(); }
      return;
    }
    proxy.ws(req, socket, head);
  });

  // Electron's main process also starts an HTTPS proxy on this port in dev.
  // Whichever binds first wins — the loser must NOT crash, because concurrently
  // runs with -k and would tear down Next + Electron with it.
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`HTTPS proxy already running on port ${HTTPS_PORT} (Electron), standing by.`);
      setInterval(() => {}, 1 << 30); // keep process alive so concurrently -k doesn't kill siblings
      return;
    }
    console.error('HTTPS proxy server error:', err.message);
  });

  server.listen(HTTPS_PORT, '0.0.0.0', () => {
    // Get LAN IP
    const nets = require('os').networkInterfaces();
    let ip = null;
    for (const iface of Object.values(nets).flat()) {
      if (iface.family === 'IPv4' && !iface.internal) { ip = iface.address; break; }
    }
    console.log(`HTTPS proxy ready: https://${ip || 'localhost'}:${HTTPS_PORT}`);
  });
}

start().catch(err => console.error('HTTPS proxy failed:', err));
