/* Controle TV — cliente do protocolo SSAP (LG webOS).
 *
 * Responsabilidades:
 *  - abrir o WebSocket (direto ou via proxy Origin:null)
 *  - handshake: hello -> system/getSystemInfo -> register (client-key)
 *  - pareamento (aviso na TV) e armazenamento da chave
 *  - abrir o "pointer input socket" usado para pressionar botões
 *  - request/response com id, assinaturas (subscribe) e reconexão automática
 */
(function () {
  'use strict';

  window.WTR = window.WTR || {};
  var NS = window.WTR;

  var PAIRING_TIMEOUT = 180000;

  NS.SSAP_MANIFEST = {
    manifestVersion: 1,
    appVersion: '1.1',
    permissions: [
      'APP_TO_APP', 'CLOSE', 'CONTROL_AUDIO', 'CONTROL_DISPLAY',
      'CONTROL_INPUT_JUMP', 'CONTROL_INPUT_JOYSTICK', 'CONTROL_INPUT_MEDIA_PLAYBACK',
      'CONTROL_INPUT_MEDIA_RECORDING', 'CONTROL_INPUT_TEXT', 'CONTROL_INPUT_TV',
      'CONTROL_MOUSE_AND_KEYBOARD', 'CONTROL_POWER', 'CONTROL_TV_SCREEN',
      'LAUNCH', 'LAUNCH_WEBAPP', 'READ_APP_STATUS', 'READ_COUNTRY_INFO',
      'READ_CURRENT_CHANNEL', 'READ_INPUT_DEVICE_LIST', 'READ_INSTALLED_APPS',
      'READ_LGE_SDX', 'READ_LGE_TV_INPUT_EVENTS', 'READ_NETWORK_STATE',
      'READ_NOTIFICATIONS', 'READ_POWER_STATE', 'READ_RUNNING_APPS',
      'READ_SETTINGS', 'READ_TV_CHANNEL_LIST', 'READ_TV_CURRENT_TIME',
      'READ_UPDATE_INFO', 'SEARCH', 'TEST_OPEN', 'TEST_PROTECTED', 'TEST_SECURE',
      'UPDATE_FROM_REMOTE_APP', 'WRITE_NOTIFICATION_ALERT',
      'WRITE_NOTIFICATION_TOAST', 'WRITE_SETTINGS'
    ]
  };

  function SSAPClient(options) {
    var o = options || {};
    this.host = o.host;
    this.port = o.port || null;
    this.secure = o.secure !== false;
    this.clientKey = o.clientKey || null;
    this.useProxy = !!o.useProxy;
    this.tvInfo = o.tvInfo || {};

    this.onState = o.onState || function () {};
    this.onPairing = o.onPairing || function () {};
    this.onKey = o.onKey || function () {};
    this.onLog = o.onLog || function () {};
    this.onAttempt = o.onAttempt || function () {};
    this.onInfo = o.onInfo || function () {};

    this.state = 'idle';
    this.inputSocket = false;

    this._ws = null;
    this._input = null;
    this._idCounter = 0;
    this._pending = new Map();
    this._subsById = new Map();
    this._subsByUri = new Map();
    this._waiters = [];
    this._registered = false;
    this._closedByUser = false;
    this._connectPromise = null;
    this._reconnectTimer = null;
    this._reconnectDelay = 1000;
    this._keepalive = null;
    this._attempts = [];
  }

  SSAPClient.prototype._log = function (msg, level) {
    this.onLog(msg, level || 'debug');
  };

  SSAPClient.prototype._setState = function (state) {
    this.state = state;
    this.onState(state);
  };

  SSAPClient.prototype.isConnected = function () {
    return this._registered && this._ws && this._ws.readyState === 1;
  };

  SSAPClient.prototype.url = function (secure, port) {
    var s = (secure === undefined ? this.secure : secure);
    var p = port || this.port || (s ? 3001 : 3000);
    return (s ? 'wss://' : 'ws://') + this.host + ':' + p;
  };

  /* ---------------- conexão ---------------- */

  SSAPClient.prototype._transportCandidates = function () {
    var pageSecure = typeof location !== 'undefined' && location.protocol === 'https:';
    var transports;
    if (this.port) {
      transports = [{ secure: !!this.secure, port: this.port }];
    } else if (pageSecure) {
      // Página em HTTPS: ws:// seria bloqueado como conteúdo misto.
      transports = [{ secure: true, port: 3001 }];
    } else {
      // Página local em HTTP: tenta a porta sem TLS (mais compatível, sem
      // certificado) e depois a TLS.
      transports = [{ secure: false, port: 3000 }, { secure: true, port: 3001 }];
    }

    var list = [];
    for (var i = 0; i < transports.length; i++) {
      var t = transports[i];
      var pair = [
        { secure: t.secure, port: t.port, proxy: false },
        { secure: t.secure, port: t.port, proxy: true }
      ];
      if (this.useProxy) pair.reverse();
      list = list.concat(pair);
    }
    return list;
  };

  SSAPClient.prototype._openSocket = function (url, useProxy, timeoutMs, handlers) {
    var self = this;
    return new Promise(function (resolve, reject) {
      var ws;
      try {
        ws = NS.openWebSocket(url, useProxy);
      } catch (e) {
        reject(new Error('Endereço inválido: ' + url));
        return;
      }

      var settled = false;
      var timer = setTimeout(function () {
        finish(false, new Error('Tempo esgotado ao conectar em ' + url));
      }, timeoutMs || 8000);

      function finish(ok, err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (ok) {
          resolve(ws);
        } else {
          detach();
          try { ws.close(); } catch (e) { /* ignora */ }
          reject(err);
        }
      }

      function detach() {
        ws.onopen = null;
        ws.onerror = null;
        ws.onmessage = null;
        ws.onclose = null;
      }

      ws.onopen = function () { finish(true); };
      ws.onerror = function () {
        finish(false, new Error('Conexão recusada pelo navegador ou pela TV (rede/certificado).'));
      };
      ws.onclose = function (ev) {
        if (!settled) {
          finish(false, new Error('A conexão foi encerrada (código ' + ((ev && ev.code) || 1006) + ').'));
          return;
        }
        if (handlers && handlers.onClose) handlers.onClose(ev);
      };
      ws.onmessage = function (ev) {
        if (handlers && handlers.onMessage) handlers.onMessage(ev);
      };
    });
  };

  SSAPClient.prototype._openMain = function (secure, port, useProxy) {
    var self = this;
    var url = this.url(secure, port);
    var t0 = Date.now();
    return this._openSocket(url, useProxy, 9000, {
      onMessage: function (ev) { self._onMessage(ev); },
      onClose: function (ev) { self._onClose(ev); }
    }).catch(function (err) {
      self._attempts.push({
        url: url,
        proxy: useProxy,
        elapsed: Date.now() - t0,
        error: err.message,
        certSuspected: (Date.now() - t0) < 1600
      });
      self.onAttempt(self._attempts[self._attempts.length - 1]);
      throw err;
    });
  };

  SSAPClient.prototype.connect = function () {
    var self = this;
    if (this._connectPromise) return this._connectPromise;
    this._closedByUser = false;
    this._attempts = [];
    this._connectPromise = this._establish()
      .then(function () {
        self._setState('connected');
        self._startKeepalive();
        return true;
      })
      .catch(function (err) {
        self._setState(self._closedByUser ? 'closed' : 'error');
        throw err;
      })
      .finally(function () {
        self._connectPromise = null;
      });
    return this._connectPromise;
  };

  SSAPClient.prototype._establish = async function () {
    var candidates = this._transportCandidates();
    var lastErr = null;

    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      this._setState('connecting');
      var label = (c.secure ? 'wss' : 'ws') + '://' + this.host + ':' + c.port + (c.proxy ? ' (proxy Origin:null)' : '');
      try {
        this._log('Conectando em ' + label + '…');
        var ws = await this._openMain(c.secure, c.port, c.proxy);
        this._ws = ws;
        this.secure = c.secure;
        this.port = c.port;
        this.useProxy = !!c.proxy;

        await this._handshake();
        try {
          await this._openInput();
        } catch (e) {
          this._log('Canal de botões indisponível: ' + e.message, 'warn');
        }

        this._reconnectDelay = 1000;
        return;
      } catch (err) {
        lastErr = err;
        this._log('Falhou em ' + label + ': ' + err.message, 'warn');
        this._teardown();
        if (this._closedByUser) throw err;
      }
    }

    var e2 = lastErr || new Error('Não foi possível conectar à TV.');
    e2.attempts = this._attempts.slice();
    throw e2;
  };

  SSAPClient.prototype._teardown = function () {
    if (this._ws) {
      try {
        this._ws.onclose = null;
        this._ws.onerror = null;
        this._ws.onmessage = null;
        this._ws.close();
      } catch (e) { /* ignora */ }
    }
    if (this._input) {
      try {
        this._input.onclose = null;
        this._input.onerror = null;
        this._input.close();
      } catch (e) { /* ignora */ }
    }
    this._ws = null;
    this._input = null;
    this._registered = false;
    this.inputSocket = false;
  };

  SSAPClient.prototype._onClose = function (ev) {
    var wasRegistered = this._registered;
    this._registered = false;
    this.inputSocket = false;
    this._rejectPending('A conexão com a TV foi encerrada.');

    if (this._closedByUser) {
      this._setState('closed');
      return;
    }
    this._log('Conexão perdida' + (ev && ev.code ? ' (código ' + ev.code + ')' : '') + '.', 'warn');
    this._setState('disconnected');
    this._scheduleReconnect(wasRegistered);
  };

  SSAPClient.prototype._scheduleReconnect = function () {
    var self = this;
    if (this._reconnectTimer || this._closedByUser) return;
    var delay = this._reconnectDelay;
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, 30000);
    this._log('Nova tentativa em ' + Math.round(delay / 1000) + 's…');
    this._reconnectTimer = setTimeout(function () {
      self._reconnectTimer = null;
      if (self._closedByUser) return;
      if (self.isConnected() || self._connectPromise) return;
      self.connect()
        .then(function () {
          self._log('Reconectado.', 'ok');
          return self._resubscribeAll();
        })
        .catch(function (err) {
          self._log('Reconexão falhou: ' + err.message, 'warn');
          self._scheduleReconnect();
        });
    }, delay);
  };

  SSAPClient.prototype.close = function () {
    this._closedByUser = true;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    this._stopKeepalive();
    this._rejectPending('Conexão encerrada.');
    this._teardown();
    this._setState('closed');
  };

  /* ---------------- handshake ---------------- */

  SSAPClient.prototype._createWaiter = function (predicate, timeoutMs, label) {
    var self = this;
    return new Promise(function (resolve, reject) {
      var waiter = {
        predicate: predicate,
        resolve: function (msg) { done(); resolve(msg); },
        reject: function (err) { done(); reject(err); }
      };
      var timer = setTimeout(function () {
        drop();
        reject(new Error('Tempo esgotado aguardando ' + label + '.'));
      }, timeoutMs);
      function drop() {
        self._waiters = self._waiters.filter(function (w) { return w !== waiter; });
      }
      function done() {
        clearTimeout(timer);
        drop();
      }
      self._waiters.push(waiter);
    });
  };

  SSAPClient.prototype._send = function (obj) {
    if (!this._ws || this._ws.readyState !== 1) throw new Error('Sem conexão com a TV.');
    this._log('→ ' + (obj.type === 'subscribe' ? 'subscribe ' : '') + (obj.uri || obj.type), 'debug');
    this._ws.send(JSON.stringify(obj));
  };

  SSAPClient.prototype._handshake = async function () {
    var self = this;

    try {
      var helloWait = this._createWaiter(function (m) { return m.type === 'hello'; }, 4000, 'hello');
      this._send({ id: 'hello', type: 'hello', payload: {} });
      await helloWait;
    } catch (e) {
      this._log('Sem resposta ao hello (normal em TVs mais antigas).', 'debug');
    }

    try {
      var info = await this.request('system/getSystemInfo', {}, 5000);
      if (info) {
        this.tvInfo = Object.assign(this.tvInfo || {}, info);
        this.onInfo(info);
      }
    } catch (e) {
      this._log('getSystemInfo indisponível antes do pareamento (TV antiga).', 'debug');
    }

    var payload = { forcePairing: false, pairingType: 'PROMPT', manifest: NS.SSAP_MANIFEST };
    if (this.clientKey) payload['client-key'] = this.clientKey;

    var regWait = this._createWaiter(function (m) {
      return m.type === 'registered' ||
        m.type === 'error' ||
        (m.type === 'response' && m.payload && m.payload.pairingType);
    }, 30000, 'registro');

    this._log(this.clientKey ? 'Registrando com a chave salva…' : 'Registrando (a TV vai pedir confirmação)…');
    this._send({ id: 'register_0', type: 'register', payload: payload });
    var msg = await regWait;

    if (msg.type === 'response' && msg.payload && msg.payload.pairingType) {
      this._log('A TV está mostrando o aviso de pareamento.', 'warn');
      this.onPairing(true);
      try {
        msg = await this._createWaiter(function (m) {
          return m.type === 'registered' || m.type === 'error';
        }, PAIRING_TIMEOUT, 'pareamento');
      } finally {
        this.onPairing(false);
      }
    }

    if (msg.type === 'error') {
      throw new Error('A TV recusou a conexão: ' + (msg.error || 'erro desconhecido'));
    }

    var key = msg.payload && msg.payload['client-key'];
    if (key && key !== this.clientKey) {
      this.clientKey = key;
      this.onKey(key);
    }
    if (!this.clientKey) throw new Error('A TV não devolveu a chave de pareamento (client-key).');

    this._registered = true;
    this._log('Pareado e registrado na TV.', 'ok');
    return true;
  };

  SSAPClient.prototype._normalizeSocketPath = function (path) {
    var u;
    try { u = new URL(path); } catch (e) { return path; }
    if (this.secure && u.protocol === 'ws:') {
      u.protocol = 'wss:';
      u.port = String(this.port || 3001);
    } else if (!this.secure && u.protocol === 'wss:') {
      u.protocol = 'ws:';
      u.port = String(this.port || 3000);
    }
    return u.toString();
  };

  SSAPClient.prototype._openInput = async function () {
    var self = this;
    var res = await this.request('com.webos.service.networkinput/getPointerInputSocket', {}, 9000);
    var path = res && res.socketPath;
    if (!path) throw new Error('a TV não retornou socketPath');

    var url = this._normalizeSocketPath(path);
    var input = await this._openSocket(url, this.useProxy, 9000, {
      onClose: function () {
        self.inputSocket = false;
        self._log('Canal de botões caiu.', 'warn');
      }
    });
    this._input = input;
    this.inputSocket = true;
    this._log('Canal de botões aberto.', 'debug');
  };

  /* ---------------- mensagens ---------------- */

  SSAPClient.prototype._onMessage = function (ev) {
    var msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (!msg || typeof msg !== 'object') return;

    this._log('← ' + (msg.type || '?') + ' ' + (msg.id || '') + (msg.error ? ' ' + msg.error : ''), 'debug');

    for (var i = 0; i < this._waiters.length; i++) {
      var w = this._waiters[i];
      var ok = false;
      try { ok = w.predicate(msg); } catch (e) { ok = false; }
      if (ok) {
        this._waiters.splice(i, 1);
        w.resolve(msg);
        return;
      }
    }

    var id = msg.id === undefined || msg.id === null ? null : String(msg.id);

    if (id !== null && this._pending.has(id)) {
      var p = this._pending.get(id);
      this._pending.delete(id);
      if (msg.type === 'error') {
        p.reject(Object.assign(new Error(msg.error || 'A TV retornou um erro.'), { response: msg }));
        return;
      }
      var payload = msg.payload || {};
      if (payload.returnValue === false) {
        p.reject(Object.assign(new Error(payload.errorText || payload.errorString || 'A TV recusou o comando.'), { payload: payload }));
        return;
      }
      p.resolve(payload);
      return;
    }

    if (id !== null && this._subsById.has(id)) {
      var entry = this._subsByUri.get(this._subsById.get(id));
      if (entry && typeof entry.callback === 'function') {
        try { entry.callback(msg.payload || {}, msg); } catch (e) { this._log('Erro em callback: ' + e.message, 'error'); }
      }
      return;
    }
  };

  SSAPClient.prototype._rejectPending = function (reason) {
    var self = this;
    this._pending.forEach(function (p) {
      p.reject(new Error(reason));
    });
    this._pending.clear();
    if (this._waiters.length) {
      var waiters = this._waiters.slice();
      this._waiters = [];
      waiters.forEach(function (w) { w.reject(new Error(reason)); });
    }
    this._log(reason, 'debug');
  };

  /* ---------------- API ---------------- */

  SSAPClient.prototype.request = function (uri, payload, timeoutMs) {
    var self = this;
    var full = /^ssap:\/\//.test(uri) ? uri : 'ssap://' + uri;
    if (!this._ws || this._ws.readyState !== 1) {
      return Promise.reject(new Error('Sem conexão com a TV.'));
    }
    var id = String(++this._idCounter);
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        if (self._pending.has(id)) {
          self._pending.delete(id);
          reject(new Error('Tempo esgotado: ' + full));
        }
      }, timeoutMs || 10000);

      self._pending.set(id, {
        resolve: function (p) { clearTimeout(timer); resolve(p); },
        reject: function (e) { clearTimeout(timer); reject(e); }
      });

      try {
        self._send({ id: id, type: 'request', uri: full, payload: payload || {} });
      } catch (e) {
        clearTimeout(timer);
        self._pending.delete(id);
        reject(e);
      }
    });
  };

  SSAPClient.prototype.subscribe = function (uri, callback, payload, timeoutMs) {
    var self = this;
    var full = /^ssap:\/\//.test(uri) ? uri : 'ssap://' + uri;
    if (!this._ws || this._ws.readyState !== 1) {
      return Promise.reject(new Error('Sem conexão com a TV.'));
    }
    var id = String(++this._idCounter);
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        if (self._pending.has(id)) {
          self._pending.delete(id);
          self._subsByUri.delete(full);
          reject(new Error('Tempo esgotado ao assinar ' + full));
        }
      }, timeoutMs || 10000);

      self._pending.set(id, {
        resolve: function (p) { clearTimeout(timer); self._subsById.set(id, full); resolve(p); },
        reject: function (e) { clearTimeout(timer); self._subsByUri.delete(full); reject(e); }
      });

      self._subsByUri.set(full, { id: id, uri: full, callback: callback, payload: payload || {} });

      try {
        self._send({ id: id, type: 'subscribe', uri: full, payload: payload || {} });
      } catch (e) {
        clearTimeout(timer);
        self._pending.delete(id);
        self._subsByUri.delete(full);
        reject(e);
      }
    });
  };

  SSAPClient.prototype._resubscribeAll = async function () {
    var list = Array.from(this._subsByUri.values());
    this._subsByUri.clear();
    this._subsById.clear();
    for (var i = 0; i < list.length; i++) {
      try {
        await this.subscribe(list[i].uri, list[i].callback, list[i].payload, 8000);
      } catch (e) {
        this._log('Não foi possível reassinar ' + list[i].uri + ': ' + e.message, 'warn');
      }
    }
  };

  SSAPClient.prototype.sendButton = function (name) {
    if (!this._input || this._input.readyState !== 1) throw new Error('Canal de botões indisponível.');
    this._input.send('type:button\nname:' + name + '\n\n');
  };

  SSAPClient.prototype.sendClick = function () {
    if (!this._input || this._input.readyState !== 1) throw new Error('Canal de botões indisponível.');
    this._input.send('type:click\n\n');
  };

  SSAPClient.prototype.sendMove = function (dx, dy, down) {
    if (!this._input || this._input.readyState !== 1) throw new Error('Canal de botões indisponível.');
    this._input.send('type:move\ndx:' + dx + '\ndy:' + dy + '\ndown:' + (down ? 1 : 0) + '\n\n');
  };

  SSAPClient.prototype.sendScroll = function (dx, dy) {
    if (!this._input || this._input.readyState !== 1) throw new Error('Canal de botões indisponível.');
    this._input.send('type:scroll\ndx:' + dx + '\ndy:' + dy + '\n\n');
  };

  SSAPClient.prototype._startKeepalive = function () {
    var self = this;
    this._stopKeepalive();
    this._keepalive = setInterval(function () {
      if (!self.isConnected()) return;
      self.request('api/getServiceList', {}, 6000).catch(function () { /* apenas keepalive */ });
    }, 60000);
  };

  SSAPClient.prototype._stopKeepalive = function () {
    if (this._keepalive) clearInterval(this._keepalive);
    this._keepalive = null;
  };

  NS.SSAPClient = SSAPClient;

  /* Endereços considerados "rede local" (mesma faixa da TV). Usado para avisar
   * sobre o Local Network Access do Chrome, que bloqueia conexões de sites
   * públicos para IPs privados. */
  NS.hostIsLocal = function (host) {
    if (!host) return false;
    var h = String(host).toLowerCase();
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]') return true;
    if (/\.local$/.test(h) || /\.lan$/.test(h) || /\.home\.arpa$/.test(h)) return true;
    if (/^127\./.test(h)) return true;
    if (/^10\./.test(h)) return true;
    if (/^192\.168\./.test(h)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
    if (/^169\.254\./.test(h)) return true;
    return false;
  };
})();
