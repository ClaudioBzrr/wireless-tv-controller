/* Controle TV — proxy de WebSocket via iframe data:
 *
 * O servidor SSAP das TVs LG recusa conexões WebSocket vindas de páginas web
 * (filtro de Origin). Clientes nativos funcionam porque não enviam esse
 * cabeçalho; páginas abertas via file:// funcionam porque enviam "Origin: null".
 *
 * Este módulo recria esse cenário: um iframe com URL data: tem origem opaca,
 * ou seja, envia "Origin: null" — que a TV aceita. O iframe abre o WebSocket
 * real e repassa as mensagens para a página principal via postMessage.
 *
 * Obs.: a origem data: é considerada "segura" pelos navegadores, então só é
 * possível usar wss:// (TLS). Para ws:// sem TLS, sirva a página por HTTP.
 */
(function () {
  'use strict';

  window.WTR = window.WTR || {};
  var NS = window.WTR;

  function buildDocument(url) {
    var safeUrl = JSON.stringify(url).replace(/</g, '\\u003c');
    var code = [
      '(function(){',
      'var U=' + safeUrl + ';',
      'function f(t,d){try{window.parent.postMessage(JSON.stringify({t:t,d:d}),"*");}catch(e){}}',
      'window.onerror=function(m,s,l){f("error",{message:"iframe: "+m+" (linha "+l+")"});return false;};',
      'var w=null;',
      'try{w=new WebSocket(U);}catch(e){f("error",{message:"URL invalida: "+String(e)});return;}',
      'w.onopen=function(){f("open",{});};',
      'w.onclose=function(e){f("close",{code:e.code||1006,reason:e.reason||""});};',
      'w.onerror=function(){f("error",{message:"falha no websocket do proxy"});};',
      'w.onmessage=function(e){f("message",{data:e.data});};',
      'window.addEventListener("message",function(ev){',
      'try{var m=JSON.parse(ev.data);',
      'if(m.t==="send"){if(w&&w.readyState===1)w.send(m.d);}',
      'else if(m.t==="close"){try{w&&w.close();}catch(e){}}',
      '}catch(e){}} ,false);',
      '})();'
    ].join('');
    return '<!doctype html><meta charset="utf-8"><title>proxy</title>' +
      '<script>' + code + '<\/script>';
  }

  function ProxyWebSocket(url) {
    var self = this;
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.onopen = null;
    this.onclose = null;
    this.onerror = null;
    this.onmessage = null;

    this._closed = false;
    this._settled = false;

    this._iframe = document.createElement('iframe');
    this._iframe.style.display = 'none';
    this._iframe.setAttribute('aria-hidden', 'true');
    this._iframe.setAttribute('sandbox', 'allow-scripts');
    this._iframe.src = 'data:text/html;charset=utf-8,' + encodeURIComponent(buildDocument(url));

    this._listener = function (ev) {
      if (!self._iframe || ev.source !== self._iframe.contentWindow) return;
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (!msg || typeof msg.t !== 'string') return;

      if (msg.t === 'open') {
        clearTimeout(self._timer);
        self._settled = true;
        self.readyState = 1; // OPEN
        if (self.onopen) self.onopen({ type: 'open' });
      } else if (msg.t === 'message') {
        if (self.onmessage) self.onmessage({ type: 'message', data: msg.d && msg.d.data });
      } else if (msg.t === 'error') {
        self._fail((msg.d && msg.d.message) || 'erro no proxy');
      } else if (msg.t === 'close') {
        self._finish(msg.d ? msg.d.code : 1006, (msg.d && msg.d.reason) || '');
      }
    };

    window.addEventListener('message', this._listener, false);

    this._timer = setTimeout(function () {
      self._fail('o proxy não respondeu (timeout)');
    }, 6000);

    // O iframe precisa estar no DOM para o navegador criar a janela dele
    // (contentWindow fica nulo enquanto o elemento está solto).
    document.body.appendChild(this._iframe);
  }

  ProxyWebSocket.prototype._fail = function (message) {
    if (this._closed) return;
    if (this.readyState === 1) {
      if (this.onerror) this.onerror({ type: 'error', message: message });
      return;
    }
    if (this.onerror) this.onerror({ type: 'error', message: message });
    this._finish(1006, message);
  };

  ProxyWebSocket.prototype._finish = function (code, reason) {
    if (this._closed) return;
    this._closed = true;
    this.readyState = 3; // CLOSED
    clearTimeout(this._timer);
    window.removeEventListener('message', this._listener, false);
    if (this.onclose) this.onclose({ type: 'close', code: code, reason: reason, wasClean: code === 1000 });
    var self = this;
    setTimeout(function () {
      if (self._iframe && self._iframe.parentNode) self._iframe.parentNode.removeChild(self._iframe);
    }, 0);
  };

  ProxyWebSocket.prototype.send = function (data) {
    if (this.readyState !== 1) throw new Error('WebSocket não está aberto');
    this._iframe.contentWindow.postMessage(JSON.stringify({ t: 'send', d: data }), '*');
  };

  ProxyWebSocket.prototype.close = function () {
    if (this.readyState === 3) return;
    try { this._iframe.contentWindow.postMessage(JSON.stringify({ t: 'close' }), '*'); } catch (e) { /* ignora */ }
    this._finish(1000, 'fechado pelo cliente');
  };

  NS.WebSocketProxy = ProxyWebSocket;

  NS.openWebSocket = function (url, useProxy) {
    if (useProxy && typeof ProxyWebSocket === 'function') return new ProxyWebSocket(url);
    return new WebSocket(url);
  };
})();
