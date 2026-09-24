#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
if [[ "$ROOT" == *Code6-25-B* ]]; then
  STATE_DIR="$HOME/.cache/code6-25-b"
else
  STATE_DIR="$HOME/.cache/code6-25-a"
fi
mkdir -p "$STATE_DIR"

export PATH="/Users/a1-6/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH"
export TZ="${TZ:-Asia/Shanghai}"

node -e 'const major=Number(process.versions.node.split(".")[0]); if (major < 22) process.exit(1)' || {
  echo "Node.js 22+ is required" >&2
  exit 1
}
command -v psql >/dev/null 2>&1 || {
  echo "PostgreSQL tools are required" >&2
  exit 1
}

find "$STATE_DIR" -maxdepth 1 -type f \( -name 'api-url' -o -name 'web-url' -o -name 'stop' -o -name 'restart-request' -o -name 'tour-id' -o -name 'api.pid' \) -delete
find "$ROOT" -maxdepth 1 -type f \( -name 'data.json' -o -name 'data.json.bak' -o -name 'data.json.tmp' -o -name 'data.json.corrupt-*' \) -delete

if [[ "${SKIP_INSTALL:-0}" != "1" ]]; then
  npm install --no-audit --no-fund >"$STATE_DIR/install.log" 2>&1
fi
npm run build >"$STATE_DIR/build.log" 2>&1

if lsof -nP -iTCP:3001 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port 3001 is required by this app but is already in use" >&2
  exit 1
fi

PUBLIC_PORT="$(node -e 'const net=require("net");const s=net.createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
API_UPSTREAM="http://127.0.0.1:3001"
PUBLIC_URL="http://127.0.0.1:$PUBLIC_PORT"

api_supervisor() {
  while [[ ! -f "$STATE_DIR/stop" ]]; do
    node api/dist/server.js >>"$STATE_DIR/api.log" 2>&1 &
    local api_pid=$!
    printf '%s\n' "$api_pid" >"$STATE_DIR/api.pid"
    wait "$api_pid" || true
    if [[ -f "$STATE_DIR/restart-request" ]]; then
      find "$STATE_DIR" -maxdepth 1 -type f -name 'restart-request' -delete
      continue
    fi
    [[ -f "$STATE_DIR/stop" ]] && break
    sleep 0.2
  done
}
api_supervisor &
SUPERVISOR_PID=$!

node - "$PUBLIC_PORT" "$API_UPSTREAM" "$STATE_DIR" <<'NODE' >>"$STATE_DIR/proxy.log" 2>&1 &
const http = require('http');
const fs = require('fs');
const path = require('path');
const [port, upstream, stateDir] = process.argv.slice(2);
const target = new URL(upstream);

function injectedScript() {
  try {
    const id = fs.readFileSync(path.join(stateDir, 'tour-id'), 'utf8').trim();
    if (!id) return '';
    const value = JSON.stringify(id).replace(/</g, '\\u003c');
    return `<script>try{localStorage.setItem('tour',${value})}catch(e){}</script>`;
  } catch {
    return '';
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/health/ready') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  const proxy = http.request({
    hostname: target.hostname,
    port: target.port,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: target.host }
  }, (upstreamRes) => {
    const type = String(upstreamRes.headers['content-type'] || '');
    if (req.method === 'GET' && type.includes('text/html')) {
      const chunks = [];
      upstreamRes.on('data', (chunk) => chunks.push(chunk));
      upstreamRes.on('end', () => {
        let body = Buffer.concat(chunks).toString('utf8');
        body = body.replace('</head>', `${injectedScript()}</head>`);
        const headers = { ...upstreamRes.headers };
        delete headers['content-length'];
        res.writeHead(upstreamRes.statusCode || 502, headers);
        res.end(body);
      });
      return;
    }
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });

  proxy.on('error', (error) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`proxy error: ${error.message}`);
  });
  req.pipe(proxy);
});

server.on('error', (error) => {
  console.error(error);
  process.exit(1);
});
server.listen(Number(port), '127.0.0.1', () => console.log(`proxy ${port} -> ${upstream}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
NODE
PROXY_PID=$!

cleanup() {
  touch "$STATE_DIR/stop"
  if [[ -n "${PROXY_PID:-}" ]]; then kill "$PROXY_PID" 2>/dev/null || true; fi
  if [[ -n "${SUPERVISOR_PID:-}" ]]; then kill "$SUPERVISOR_PID" 2>/dev/null || true; fi
  if [[ -f "$STATE_DIR/api.pid" ]]; then
    local pid
    pid="$(cat "$STATE_DIR/api.pid" 2>/dev/null || true)"
    [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
  fi
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

for _ in {1..150}; do
  if curl -fsS "$PUBLIC_URL/health/ready" >/dev/null 2>&1 && curl -fsS "$PUBLIC_URL/health/live" >/dev/null 2>&1; then
    printf '%s\n' "$PUBLIC_URL" >"$STATE_DIR/api-url"
    printf '%s\n' "$PUBLIC_URL" >"$STATE_DIR/web-url"
    echo "API and Web ready: $PUBLIC_URL"
    wait "$PROXY_PID"
    exit 0
  fi
  sleep 0.2
done

echo "Timed out starting local services" >&2
exit 1
