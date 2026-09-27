#!/usr/bin/env node
/* Diagnóstico da TV LG webOS, sem dependências e sem navegador.
 *
 * O navegador impõe várias restrições (Local Network Access, conteúdo misto,
 * certificado). Este script fala WebSocket direto, então serve para separar
 * "problema de rede/TV" de "problema de navegador".
 *
 * Uso:
 *   node probe.js --scan            procura TVs na sua rede local
 *   node probe.js 192.168.1.50      testa a TV nesse IP
 *   node probe.js 192.168.1.50 --origin http://192.168.1.9:8080
 */
'use strict';

const net = require('node:net');
const tls = require('node:tls');
const os = require('node:os');
const crypto = require('node:crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const HELLO_TIMEOUT = 3000;

/* ---------------- WebSocket mínimo (cliente) ---------------- */

function encodeText(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, 0x80 | len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 0x80 | 127;
    header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6);
  }
  const mask = crypto.randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

function decodeFrames(buffer, onText) {
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const b0 = buffer[offset];
    const b1 = buffer[offset + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let cursor = offset + 2;
    if (len === 126) {
      if (buffer.length - cursor < 2) break;
      len = buffer.readUInt16BE(cursor); cursor += 2;
    } else if (len === 127) {
      if (buffer.length - cursor < 8) break;
      len = Number(buffer.readBigUInt64BE(cursor)); cursor += 8;
    }
    let mask = null;
    if (masked) {
      if (buffer.length - cursor < 4) break;
      mask = buffer.subarray(cursor, cursor + 4); cursor += 4;
    }
    if (buffer.length - cursor < len) break;
    const payload = Buffer.from(buffer.subarray(cursor, cursor + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    offset = cursor + len;
    if (opcode === 0x1) onText(payload.toString('utf8'));
    else if (opcode === 0x8) return { rest: buffer.subarray(offset), closed: true, code: payload.length >= 2 ? payload.readUInt16BE(0) : 0 };
  }
  return { rest: buffer.subarray(offset), closed: false, code: 0 };
}

function wsConnect(host, port, secure, origin, timeout) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const key = crypto.randomBytes(16).toString('base64');
    const expected = crypto.createHash('sha1').update(key + GUID).digest('base64');

    const socket = secure
      ? tls.connect({ host, port, rejectUnauthorized: false, timeout, servername: host })
      : net.connect({ host, port, timeout });

    const conn = {
      host, port, secure, origin: origin || null,
      status: null, ms: 0, closed: false, closeCode: 0,
      messages: [], waiters: [], send, close
    };

    let buffer = Buffer.alloc(0);
    let settled = false;

    function send(text) { socket.write(encodeText(text)); }
    function close() { try { socket.destroy(); } catch (e) { /* ignora */ } }

    function fail(message) {
      if (settled) return;
      settled = true;
      close();
      reject(Object.assign(new Error(message), { conn }));
    }

    function finish() {
      if (settled) return;
      settled = true;
      resolve(conn);
    }

    socket.on('error', (e) => fail('erro de rede: ' + e.message));
    socket.on('timeout', () => fail('tempo esgotado ao conectar'));
    socket.on('close', () => { conn.closed = true; });

    socket.on('connect', () => {
      const lines = [
        'GET / HTTP/1.1',
        'Host: ' + host + ':' + port,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: ' + key,
        'Sec-WebSocket-Version: 13'
      ];
      if (origin) lines.push('Origin: ' + origin);
      lines.push('', '');
      socket.write(lines.join('\r\n'));
    });

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (!settled) {
        const idx = buffer.indexOf('\r\n\r\n');
        if (idx === -1) return;
        const head = buffer.subarray(0, idx).toString('latin1');
        conn.status = head.split('\r\n')[0];
        conn.ms = Date.now() - started;
        buffer = buffer.subarray(idx + 4);
        const m = head.match(/sec-websocket-accept:\s*(\S+)/i);
        if (!/ 101 /.test(conn.status)) { fail('handshake recusado: ' + conn.status); return; }
        if (!m || m[1] !== expected) { fail('Sec-WebSocket-Accept inválido'); return; }
        finish();
        return;
      }

      const res = decodeFrames(buffer, (text) => {
        let msg;
        try { msg = JSON.parse(text); } catch (e) { msg = { raw: String(text).slice(0, 160) }; }
        conn.messages.push(msg);
        conn.waiters = conn.waiters.filter((w) => {
          if (w.predicate(msg)) { w.resolve(msg); return false; }
          return true;
        });
      });
      buffer = res.rest;
      if (res.closed) { conn.closed = true; conn.closeCode = res.code; }
    });

    conn.waitFor = function (predicate, ms) {
      const existing = conn.messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve };
        conn.waiters.push(waiter);
        setTimeout(() => {
          conn.waiters = conn.waiters.filter((w) => w !== waiter);
          reject(new Error(conn.closed
            ? 'a TV fechou a conexão (código ' + (conn.closeCode || '?') + ')'
            : 'sem resposta da TV'));
        }, ms || HELLO_TIMEOUT);
      });
    };
  });
}

/* ---------------- testes ---------------- */

function pageOriginHint() {
  const addrs = [];
  Object.values(os.networkInterfaces()).forEach((list) => {
    (list || []).forEach((info) => { if (info.family === 'IPv4' && !info.internal) addrs.push(info.address); });
  });
  return addrs.length ? 'http://' + addrs[0] + ':8080' : 'http://localhost:8080';
}

async function probeHost(host, extraOrigin) {
  const origin = extraOrigin || pageOriginHint();
  const results = [];
  const transports = [{ port: 3000, secure: false }, { port: 3001, secure: true }];

  for (const t of transports) {
    for (const useOrigin of [false, true]) {
      const label = (t.secure ? 'wss' : 'ws') + '://' + host + ':' + t.port +
        (useOrigin ? '  (com Origin de navegador)' : '  (sem Origin)');
      try {
        const conn = await wsConnect(host, t.port, t.secure, useOrigin ? origin : null, 5000);
        conn.send(JSON.stringify({ id: 'hello', type: 'hello', payload: {} }));
        await conn.waitFor((m) => m.type === 'hello', 3000);
        conn.send(JSON.stringify({ id: 'sysinfo', type: 'request', uri: 'ssap://system/getSystemInfo', payload: {} }));
        let model = '?';
        try {
          const info = await conn.waitFor((m) => m.id === 'sysinfo', 3000);
          model = (info.payload && info.payload.modelName) || '?';
        } catch (e) { /* segue */ }
        conn.close();
        results.push({ label, ok: true, model, ms: conn.ms });
      } catch (e) {
        const c = e.conn || {};
        results.push({
          label, ok: false,
          detail: e.message,
          handshake: c.status || null,
          ms: c.ms || null
        });
      }
    }
  }
  return results;
}

function tcpCheck(host, port, timeout, useTls) {
  return new Promise((resolve) => {
    const socket = useTls
      ? tls.connect({ host, port, rejectUnauthorized: false, timeout })
      : net.connect({ host, port, timeout });
    let done = false;
    const finish = (ok, extra) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch (e) { /* ignora */ }
      resolve({ ok, extra });
    };
    socket.setTimeout(timeout, () => finish(false, 'timeout'));
    socket.on('error', () => finish(false));
    socket.on('close', () => finish(false));
    socket.on('connect', () => {
      socket.write('GET / HTTP/1.0\r\nHost: ' + host + '\r\n\r\n');
    });
    socket.on('data', (chunk) => {
      const text = chunk.toString('latin1');
      finish(true, /hello/i.test(text) ? 'hello' : text.split('\r\n')[0]);
    });
  });
}

function localSubnets() {
  const nets = [];
  Object.values(os.networkInterfaces()).forEach((list) => {
    (list || []).forEach((info) => {
      if (info.family === 'IPv4' && !info.internal) {
        const parts = info.address.split('.');
        nets.push(parts.slice(0, 3).join('.'));
      }
    });
  });
  return Array.from(new Set(nets));
}

async function scan() {
  const bases = localSubnets();
  console.log('Procurando TVs em: ' + bases.map((b) => b + '.0/24').join(', '));
  const found = [];

  for (const base of bases) {
    const hosts = [];
    for (let i = 1; i <= 254; i++) hosts.push(base + '.' + i);
    const queue = hosts.slice();
    const workers = new Array(64).fill(0).map(async () => {
      while (queue.length) {
        const ip = queue.shift();
        const plain = await tcpCheck(ip, 3000, 400, false);
        if (plain.ok) { found.push({ ip, port: 3000, kind: plain.extra }); continue; }
        const secure = await tcpCheck(ip, 3001, 400, true);
        if (secure.ok) found.push({ ip, port: 3001, kind: secure.extra });
      }
    });
    await Promise.all(workers);
  }

  if (!found.length) {
    console.log('Nenhum aparelho respondeu nas portas 3000/3001.');
    console.log('Verifique se o PC e a TV estão na mesma rede (e sem isolamento de clientes).');
    return;
  }
  console.log('');
  found.forEach((f) => {
    console.log('  ' + f.ip + '  porta ' + f.port + (f.kind === 'hello' ? '  -> resposta "hello" (TV LG webOS)' : '  -> ' + f.kind));
  });
  console.log('');
  console.log('Teste a TV com:  node probe.js ' + found[0].ip);
}

/* ---------------- principal ---------------- */

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args[0] === '--help' || args[0] === '-h') {
    console.log('Uso: node probe.js --scan');
    console.log('     node probe.js <ip-da-tv> [--origin <url>]');
    return;
  }
  if (args[0] === '--scan') { await scan(); return; }

  const host = args[0];
  const originIndex = args.indexOf('--origin');
  const origin = originIndex !== -1 ? args[originIndex + 1] : null;

  console.log('Testando a TV em ' + host + '…');
  console.log('');
  const results = await probeHost(host, origin);
  results.forEach((r) => {
    if (r.ok) {
      console.log('  OK    ' + r.label);
      console.log('        handshake ' + r.ms + 'ms · modelo: ' + r.model);
    } else {
      console.log('  FALHA ' + r.label);
      console.log('        ' + r.detail + (r.handshake ? ' · ' + r.handshake : '') + (r.ms !== null ? ' · ' + r.ms + 'ms' : ''));
    }
  });

  const anyOk = results.some((r) => r.ok);
  console.log('');
  if (anyOk) {
    console.log('A TV responde pelo Node — a rede está boa. Se o navegador falha, é restrição do navegador');
    console.log('(Local Network Access, conteúdo misto ou certificado). O modo local do app resolve.');
  } else {
    console.log('A TV não respondeu nem pelo Node. Verifique: IP correto, mesma rede/VLAN,');
    console.log('"LG Connect Apps"/Mobile TV On habilitado na TV e firewall do PC.');
  }
}

main().catch((e) => { console.error('Erro inesperado: ' + e.message); process.exit(1); });
