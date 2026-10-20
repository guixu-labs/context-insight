import { createServer } from 'node:http';

// Teaching fixture, not a production component service or an MCP endpoint.
const port = Number(process.env.DEMO_PORT ?? 8120);
const mode = process.env.DEMO_MODE ?? 'ok';
const modes = ['ok', 'degraded', 'invalid', 'http-error', 'slow'];
if (!Number.isInteger(port) || port < 1 || port > 65535 || !modes.includes(mode)) {
  throw new Error('Use DEMO_PORT=1..65535 and DEMO_MODE=ok|degraded|invalid|http-error|slow');
}
const server = createServer((req, res) => {
  const send = (code, body) => {
    if (res.destroyed) return;
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.method !== 'GET' || req.url !== '/health') return send(404, { error: 'not_found' });
  if (process.env.COMPONENT_TOKEN
      && req.headers.authorization !== `Bearer ${process.env.COMPONENT_TOKEN}`) {
    return send(401, { error: 'unauthorized' });
  }
  console.log(`GET /health mode=${mode}`);
  if (mode === 'http-error') return send(503, { error: 'demo_unavailable' });
  if (mode === 'invalid') return send(200, { ready: true });
  if (mode === 'slow') {
    const timer = setTimeout(() => send(200, { status: 'ok' }), 6500);
    res.on('close', () => clearTimeout(timer));
    return;
  }
  send(200, { status: mode });
});
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => {
  console.log(`Ready: http://127.0.0.1:${port}/health (${mode})`);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { server.close(); server.closeAllConnections(); });
}
