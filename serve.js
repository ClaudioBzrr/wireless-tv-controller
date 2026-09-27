#!/usr/bin/env node
/* Servidor estático local, sem dependências.
 *
 * Por que existe: Chrome/Edge 142+ bloqueiam conexões de páginas públicas
 * (ex.: GitHub Pages) para IPs da rede local — Local Network Access. Para
 * WebSocket não há prompt de permissão, então a conexão falha em silêncio.
 * Servindo esta pasta por HTTP a partir de um aparelho da própria rede, a
 * página passa a ser "origem local" e o acesso à TV é liberado.
 *
 * Uso:  node serve.js [porta]     (padrão: 8080)
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = __dirname;
const START_PORT = parseInt(process.argv[2], 10) || parseInt(process.env.PORT, 10) || 8080;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  Object.keys(ifaces).forEach((name) => {
    (ifaces[name] || []).forEach((info) => {
      if (info.family === 'IPv4' && !info.internal) out.push({ name: name, address: info.address });
    });
  });
  return out;
}

function send(res, status, type, body) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (e) {
    send(res, 400, 'text/plain; charset=utf-8', 'pedido inválido');
    return;
  }
  if (pathname === '/') pathname = '/index.html';

  const file = path.normalize(path.join(ROOT, pathname));
  if (!file.startsWith(ROOT)) {
    send(res, 403, 'text/plain; charset=utf-8', 'acesso negado');
    return;
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      send(res, 404, 'text/plain; charset=utf-8', 'não encontrado: ' + pathname);
      return;
    }
    send(res, 200, TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', data);
  });
});

function listen(port, attemptsLeft) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      listen(port + 1, attemptsLeft - 1);
      return;
    }
    console.error('Nao foi possivel iniciar o servidor: ' + err.message);
    process.exit(1);
  });

  server.listen(port, '0.0.0.0', () => {
    const addrs = lanAddresses();
    console.log('');
    console.log('  Controle TV - servidor local rodando');
    console.log('  ------------------------------------');
    console.log('  Neste computador:   http://localhost:' + port + '/');
    addrs.forEach((a) => {
      console.log('  Na rede (' + a.name + '): http://' + a.address + ':' + port + '/');
    });
    if (!addrs.length) {
      console.log('  Nao encontrei um IP de rede local - confira a conexao.');
    }
    console.log('');
    console.log('  Abra um desses enderecos no computador ou no celular (mesma rede da TV).');
    console.log('  Para parar: Ctrl+C');
    console.log('');
  });
}

listen(START_PORT, 10);
