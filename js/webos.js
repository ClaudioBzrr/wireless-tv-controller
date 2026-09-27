/* Controle TV — camada de alto nível sobre o SSAP.
 *
 * Traduz ações do controle (volume, canais, apps, texto…) em comandos da TV,
 * mantém o estado atual (volume, mudo, app em primeiro plano, canal) e
 * notifica a interface através de eventos.
 */
(function () {
  'use strict';

  window.WTR = window.WTR || {};
  var NS = window.WTR;
  if (!NS.log) NS.log = function () {};

  var APP_LIVETV = 'com.webos.app.livetv';

  function WebOS(client) {
    this.client = client;
    this.state = {
      volume: null,
      muted: null,
      appId: '',
      appName: '',
      power: null,
      channel: null,
      channels: null,
      apps: null,
      inputs: null
    };
    this._listeners = {};
    this._channelSub = null;
  }

  WebOS.prototype = {
    constructor: WebOS,

    on: function (evt, fn) {
      (this._listeners[evt] = this._listeners[evt] || []).push(fn);
      return this;
    },

    _emit: function (evt, data) {
      var list = this._listeners[evt] || [];
      for (var i = 0; i < list.length; i++) {
        try { list[i](data); } catch (e) { NS.log('Erro em listener: ' + e.message, 'error'); }
      }
    },

    _set: function (patch) {
      Object.assign(this.state, patch);
      this._emit('state', this.state);
    },

    /* ---------------- assinaturas de estado ---------------- */

    start: async function () {
      var self = this;

      await this._safeSubscribe('audio/getVolume', function (p) {
        var vs = (p && p.volumeStatus) || p || {};
        var patch = {};
        if (typeof vs.volume === 'number') patch.volume = vs.volume;
        if (typeof vs.muteStatus === 'boolean') patch.muted = vs.muteStatus;
        if (Object.keys(patch).length) self._set(patch);
      });

      await this._safeSubscribe('audio/getStatus', function (p) {
        var patch = {};
        if (p && typeof p.mute === 'boolean') patch.muted = p.mute;
        if (p && typeof p.volume === 'number') patch.volume = p.volume;
        if (Object.keys(patch).length) self._set(patch);
      });

      await this._safeSubscribe('com.webos.applicationManager/getForegroundAppInfo', function (p) {
        var appId = (p && p.appId) || '';
        self._set({ appId: appId, appName: (p && p.appName) || '' });
        if (appId === APP_LIVETV) {
          self._subscribeChannel();
        } else {
          self._set({ channel: null });
        }
      });

      await this._safeSubscribe('com.webos.service.tvpower/power/getPowerState', function (p) {
        self._set({ power: (p && p.state) || null });
      });

      // dados "pesados" — tolerantes a falha e carregados em paralelo
      this.loadApps();
      this.loadChannels();
      this.loadInputs();

      return this.state;
    },

    _safeSubscribe: async function (uri, cb) {
      try {
        var initial = await this.client.subscribe(uri, cb, {}, 8000);
        // O primeiro payload traz o estado atual; os demais chegam pelo callback.
        if (initial) {
          try { cb(initial); } catch (e) { NS.log('Erro ao aplicar estado inicial de ' + uri + ': ' + e.message, 'warn'); }
        }
        return initial;
      } catch (e) {
        NS.log('Assinatura indisponível: ' + uri + ' (' + e.message + ')', 'warn');
        return null;
      }
    },

    _subscribeChannel: function () {
      var self = this;
      if (this._channelSub) return this._channelSub;
      this._channelSub = this._safeSubscribe('tv/getCurrentChannel', function (p) {
        if (!p) return;
        var number = p.channelNumber || p.majorNumber || '';
        if (p.minorNumber && String(p.majorNumber) === String(number)) number = p.majorNumber + '-' + p.minorNumber;
        self._set({
          channel: {
            id: p.channelId || number,
            number: number,
            name: p.channelName || p.programName || ''
          }
        });
      }).then(function (r) {
        if (!r) self._channelSub = null;
        return r;
      });
      return this._channelSub;
    },

    /* ---------------- carregamento sob demanda ---------------- */

    loadApps: async function () {
      try {
        var p = await this.client.request('com.webos.applicationManager/listLaunchPoints', {}, 20000);
        var list = (p && p.launchPoints) || [];
        list = list.filter(function (a) { return a && a.id && a.visible !== false; });
        this._set({ apps: list });
        return list;
      } catch (e) {
        NS.log('Não foi possível listar os apps instalados: ' + e.message, 'warn');
        this._set({ apps: [] });
        return [];
      }
    },

    loadChannels: async function () {
      try {
        var p = await this.client.request('tv/getChannelList', {}, 25000);
        var list = (p && p.channelList) || [];
        this._set({ channels: list });
        return list;
      } catch (e) {
        NS.log('Lista de canais indisponível: ' + e.message, 'warn');
        this._set({ channels: [] });
        return [];
      }
    },

    loadInputs: async function () {
      try {
        var p = await this.client.request('tv/getExternalInputList', {}, 12000);
        var list = (p && p.devices) || [];
        this._set({ inputs: list });
        return list;
      } catch (e) {
        this._set({ inputs: [] });
        return [];
      }
    },

    /* ---------------- utilidades ---------------- */

    _try: async function (steps) {
      var lastErr = null;
      for (var i = 0; i < steps.length; i++) {
        try {
          return await steps[i]();
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr || new Error('Nenhuma forma de executar o comando funcionou.');
    },

    /* ---------------- botões ---------------- */

    button: async function (name) {
      var self = this;
      var viaSocket = function () {
        self.client.sendButton(name);
        return Promise.resolve(true);
      };
      var viaRequest = function () { return self._fallbackButton(name); };
      return this.client.inputSocket ? this._try([viaSocket, viaRequest]) : viaRequest();
    },

    click: async function () {
      var self = this;
      var viaSocket = function () { self.client.sendClick(); return Promise.resolve(true); };
      return this.client.inputSocket ? this._try([viaSocket]) : Promise.reject(new Error('OK indisponível: a TV não liberou o canal de botões.'));
    },

    _fallbackButton: function (name) {
      var c = this.client;
      switch (name) {
        case 'VOLUMEUP': return c.request('audio/volumeUp');
        case 'VOLUMEDOWN': return c.request('audio/volumeDown');
        case 'MUTE': return this.toggleMute();
        case 'CHANNELUP': return c.request('tv/channelUp');
        case 'CHANNELDOWN': return c.request('tv/channelDown');
        case 'PLAY': return this.play();
        case 'PAUSE': return this.pause();
        case 'STOP': return this.stop();
        case 'REWIND': return this.rewind();
        case 'FASTFORWARD': return this.fastForward();
        default:
          return Promise.reject(new Error('Botão "' + name + '" exige o canal de entrada, que esta TV não liberou.'));
      }
    },

    /* ---------------- energia / tela ---------------- */

    powerOff: function () {
      // A TV desliga e derruba o socket; não esperamos resposta.
      return this.client.request('system/turnOff', {}, 2500).catch(function () { return true; });
    },

    powerOn: function () {
      return this.client.request('system/turnOn', {}, 5000);
    },

    screenOff: function () {
      return this.client.request('com.webos.service.tvpower/power/turnOffScreen', {}, 6000);
    },

    screenOn: function () {
      return this.client.request('com.webos.service.tvpower/power/turnOnScreen', {}, 6000);
    },

    /* ---------------- áudio ---------------- */

    volumeUp: function () { return this.client.request('audio/volumeUp'); },
    volumeDown: function () { return this.client.request('audio/volumeDown'); },
    setVolume: function (v) { return this.client.request('audio/setVolume', { volume: Math.max(0, Math.round(v)) }); },
    setMute: function (mute) { return this.client.request('audio/setMute', { mute: !!mute }); },
    toggleMute: function () { return this.setMute(!this.state.muted); },

    /* ---------------- canal ---------------- */

    channelUp: function () {
      var self = this;
      return this._try([
        function () { return self.client.request('tv/channelUp'); },
        function () { self.client.sendButton('CHANNELUP'); return Promise.resolve(true); }
      ]);
    },

    channelDown: function () {
      var self = this;
      return this._try([
        function () { return self.client.request('tv/channelDown'); },
        function () { self.client.sendButton('CHANNELDOWN'); return Promise.resolve(true); }
      ]);
    },

    openChannel: function (channelId) {
      return this.client.request('tv/openChannel', { channelId: String(channelId).trim() }, 12000);
    },

    /* ---------------- mídia ---------------- */

    play: function () { return this.client.request('media.controls/play'); },
    pause: function () { return this.client.request('media.controls/pause'); },
    stop: function () { return this.client.request('media.controls/stop'); },
    rewind: function () { return this.client.request('media.controls/rewind'); },
    fastForward: function () { return this.client.request('media.controls/fastForward'); },

    /* ---------------- apps / entradas ---------------- */

    launchApp: async function (appId) {
      var c = this.client;
      return this._try([
        function () { return c.request('system.launcher/launch', { id: appId }, 15000); },
        function () { return c.request('com.webos.applicationManager/launch', { id: appId }, 15000); }
      ]);
    },

    closeApp: function (appId) {
      return this.client.request('system.launcher/close', { id: appId });
    },

    switchInput: function (inputId) {
      return this.client.request('tv/switchInput', { inputId: inputId }, 12000);
    },

    /* ---------------- texto ---------------- */

    insertText: function (text) {
      return this.client.request('com.webos.service.ime/insertText', { text: String(text), replace: false }, 10000);
    },

    deleteChars: function (count) {
      return this.client.request('com.webos.service.ime/deleteCharacters', { count: Math.max(1, count | 0) }, 10000);
    },

    sendEnter: function () {
      return this.client.request('com.webos.service.ime/sendEnterKey', {}, 10000);
    }
  };

  NS.WebOS = WebOS;
})();
