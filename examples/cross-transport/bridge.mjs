// The browser reaches a real Server listener. Only this test-owned relay can
// cut its connection; native TCP/QUIC never go through it.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

const [root, bundle, upstreamPort] = process.argv.slice(2);
const file = name => path.join(root, name);
const sockets = new Set();
const get = new Set(['fixture', 'online', 'attachment', 'resume']);
const post = new Set(['browser-ready', 'browser-sent', 'browser-offline', 'browser-read', 'browser-error']);
let cut = false;

const server = http.createServer(async (req, res) => {
  const reply = (status, body = '', contentType = 'text/plain') =>
    res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' }).end(body);
  if (req.headers.host !== `127.0.0.1:${server.address().port}`) return reply(403);
  if (req.method === 'GET') {
    if (req.url === '/') return reply(200, '<!doctype html><body>Running browser test<script type="module" src="/bundle.js"></script></body>', 'text/html');
    if (req.url === '/bundle.js') return reply(200, fs.readFileSync(bundle), 'text/javascript');
    if (req.url === '/attachment.png') return reply(200, fs.readFileSync(file('attachment.png')), 'image/png');
    const name = req.url?.split('/')[2];
    if (get.has(name)) {
      if (!fs.existsSync(file(name))) return reply(204);
      return reply(200, fs.readFileSync(file(name)), 'application/json');
    }
    return reply(404);
  }
  if (req.method !== 'POST' || req.headers.origin !== `http://${req.headers.host}`) return reply(403);
  const name = req.url?.split('/')[2];
  if (name === 'drop-websocket') {
    cut = true;
    for (const sock of sockets) sock.destroy();
  } else if (post.has(name)) {
    let data = '';
    for await (const chunk of req) {
      data += chunk;
      if (data.length > 1024) return reply(413);
    }
    fs.writeFileSync(file(`${name}.tmp`), data);
    fs.renameSync(file(`${name}.tmp`), file(name));
  } else {
    return reply(404);
  }
  reply(200);
});

server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/gate' || req.headers.origin !== `http://127.0.0.1:${server.address().port}` ||
      (cut && !fs.existsSync(file('resume')))) {
    socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    return;
  }
  const upstream = net.connect(Number(upstreamPort), '127.0.0.1', () => {
    let request = `GET /gate HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      request += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    }
    upstream.write(request + '\r\n');
    upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  sockets.add(socket);
  socket.on('close', () => { sockets.delete(socket); upstream.destroy(); });
  upstream.on('close', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  upstream.on('error', () => socket.destroy());
});
server.listen(0, '127.0.0.1', () => console.log(server.address().port));
