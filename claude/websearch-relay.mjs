// Sits in front of CLIProxyAPI for the Claude desktop app and remote Claude Code sessions.
// A web search request for an OpenCode model goes to a model that can search; everything else
// passes through untouched, streaming included.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { readAliases, rerouteWebSearch } from '../lib/claude-desktop.mjs';
import { ROUTER_CONFIG, ROUTER_URL, loadSettings } from './settings.mjs';

const settings = loadSettings();
const upstream = new URL(ROUTER_URL);
const searchModel = readAliases(readFileSync(ROUTER_CONFIG, 'utf8')).get(settings.searchModel) || settings.searchModel;

http.createServer((req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    let body = Buffer.concat(chunks);
    if (req.method === 'POST' && req.url.split('?')[0].endsWith('/v1/messages') && body.length) {
      const routed = rerouteWebSearch(body, searchModel);
      if (routed !== body) console.error(`web search -> ${settings.searchModel}`);
      body = routed;
    }
    const headers = { ...req.headers, host: upstream.host, 'content-length': String(body.length) };
    delete headers['transfer-encoding'];
    const out = http.request({ host: upstream.hostname, port: upstream.port, method: req.method, path: req.url, headers }, up => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    });
    out.on('error', error => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'relay_error', message: error.message } }));
    });
    out.end(body);
  });
}).listen(settings.relayPort, '127.0.0.1', () => {
  console.error(`Claude web search relay on 127.0.0.1:${settings.relayPort} -> ${ROUTER_URL}, searches via ${settings.searchModel}`);
});
