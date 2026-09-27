/* Controle TV — interface e orquestração.
 *
 * Cuida da tela de conexão, do controle remoto, das abas (teclado/apps),
 * dos ajustes, da ajuda/diagnóstico e da persistência (localStorage).
 */
(function () {
  'use strict';

  var NS = window.WTR;
  var STORAGE_KEY = 'wtr.v1';
  var APP_LIVETV = 'com.webos.app.livetv';

  var COLOR_PALETTE = ['#3b82f6', '#8b5cf6', '#ec4899', '#f97316', '#14b8a6', '#eab308', '#ef4444', '#22c55e'];
  var KNOWN_COLORS = {
    'netflix': '#e50914',
    'youtube.leanback.v4': '#ff0000',
    'amazon': '#00a8e1',
    'com.disney.disneyplus-prod': '#113ccf',
    'com.wbd.stream': '#5b2bd9',
    'spotify-beehive': '#1db954',
    'twitch': '#9146ff',
    'com.webos.app.livetv': '#d81a3c'
  };

  var state = {
    config: loadConfig(),
    tv: null,
    client: null,
    webos: null,
    connected: false,
    lastAttempt: null,
    numpadBuffer: '',
    showDebug: false,
    wasConnected: false
  };

  /* ================= persistência ================= */

  function loadConfig() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      var cfg = raw ? JSON.parse(raw) : null;
      if (!cfg || !Array.isArray(cfg.tvs)) return { tvs: [], last: null };
      return cfg;
    } catch (e) {
      return { tvs: [], last: null };
    }
  }

  function saveConfig() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.config)); } catch (e) { /* ignora */ }
  }

  function findTv(id) {
    for (var i = 0; i < state.config.tvs.length; i++) {
      if (state.config.tvs[i].id === id) return state.config.tvs[i];
    }
    return null;
  }

  function tvId(host, port) {
    return String(host).trim().toLowerCase() + ':' + (port || 'auto');
  }

  /* ================= utilidades de DOM ================= */

  function $(sel) { return document.querySelector(sel); }

  function el(tag, props, children) {
    var node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2).toLowerCase(), v);
        else if (v === true) node.setAttribute(k, '');
        else if (v !== false && v !== null && v !== undefined) node.setAttribute(k, v);
      });
    }
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  var SVG_NS = 'http://www.w3.org/2000/svg';
  function icon(name, cls) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'ic' + (cls ? ' ' + cls : ''));
    var use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', '#i-' + name);
    svg.appendChild(use);
    return svg;
  }

  function vibrate(ms) {
    if (navigator.vibrate) { try { navigator.vibrate(ms); } catch (e) { /* ignora */ } }
  }

  function toast(msg, kind) {
    var box = $('#toasts');
    var node = el('div', { class: 'toast ' + (kind || ''), text: msg });
    box.appendChild(node);
    while (box.children.length > 3) box.removeChild(box.firstChild);
    setTimeout(function () {
      node.style.opacity = '0';
      node.style.transition = 'opacity .25s';
      setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 260);
    }, kind === 'err' ? 4600 : 3000);
  }

  function log(msg, level) {
    level = level || 'info';
    var line = { t: Date.now(), level: level, msg: String(msg) };
    NS.logBuffer.push(line);
    if (NS.logBuffer.length > 400) NS.logBuffer.shift();
    if (level === 'error') console.error('[ControleTV]', msg);
    else if (level === 'debug') console.debug('[ControleTV]', msg);
    else console.log('[ControleTV]', msg);
    window.dispatchEvent(new CustomEvent('wtr-log', { detail: line }));
  }

  NS.logBuffer = NS.logBuffer || [];
  NS.log = log;

  function levelVisible(level) {
    return state.showDebug || (level !== 'debug');
  }

  function fmtTime(ts) {
    var d = new Date(ts);
    function p(n) { return n < 10 ? '0' + n : String(n); }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  /* ================= telas ================= */

  function showScreen(name) {
    $('#screen-connect').classList.toggle('hidden', name !== 'connect');
    $('#screen-remote').classList.toggle('hidden', name !== 'remote');
  }

  function showTab(name) {
    ['remote', 'keyboard', 'apps'].forEach(function (t) {
      var panel = $('#tab-' + t);
      if (panel) panel.classList.toggle('hidden', t !== name);
    });
    var buttons = document.querySelectorAll('.tabbar button');
    for (var i = 0; i < buttons.length; i++) buttons[i].classList.toggle('active', buttons[i].getAttribute('data-tab') === name);
    if (name === 'apps') ensureAppsData();
  }

  function setStatus(dotClass, subText) {
    var dot = $('#status-dot');
    dot.className = 'dot ' + (dotClass || 'idle');
    if (subText !== undefined) $('#tv-sub').textContent = subText;
  }

  function updateHeaderName() {
    if (state.tv) $('#tv-name').textContent = state.tv.name || state.tv.host;
  }

  /* ================= lista de TVs ================= */

  function renderConnectList() {
    var box = $('#connect-tvs');
    box.innerHTML = '';
    if (!state.config.tvs.length) {
      box.appendChild(el('p', { class: 'muted small', text: 'Nenhuma TV cadastrada ainda. Toque em “Adicionar TV” para começar.' }));
      return;
    }
    state.config.tvs.forEach(function (tv) {
      var item = el('button', { class: 'tv-item' + (state.tv && state.tv.id === tv.id ? ' active' : '') }, [
        el('span', { class: 'tv-ico' }, [icon('tv')]),
        el('span', { class: 'tv-meta' }, [
          el('strong', { text: tv.name || tv.host }),
          el('span', { text: tv.host + (tv.model ? ' · ' + tv.model : '') })
        ]),
        el('span', { class: 'tv-go' }, [icon(tv.key ? 'link' : 'unlink')])
      ]);
      item.addEventListener('click', function () { connectTv(tv); });
      var edit = el('span', { class: 'icon-btn', title: 'Editar' }, [icon('settings')]);
      edit.addEventListener('click', function (ev) {
        ev.stopPropagation();
        openTvForm(tv);
      });
      item.appendChild(edit);
      box.appendChild(item);
    });
  }

  /* ================= conexão ================= */

  function disconnect() {
    if (state.client) {
      try { state.client.close(); } catch (e) { /* ignora */ }
    }
    state.client = null;
    state.webos = null;
    state.connected = false;
    state.wasConnected = false;
    state.numpadBuffer = '';
  }

  function showPairingOverlay(active, customMsg) {
    var ov = $('#pairing-overlay');
    if (active) {
      if (customMsg) $('#pairing-msg').innerHTML = customMsg;
      ov.classList.remove('hidden');
    } else {
      ov.classList.add('hidden');
    }
  }

  async function connectTv(tv) {
    disconnect();
    state.tv = tv;
    state.config.last = tv.id;
    saveConfig();
    showScreen('remote');
    updateHeaderName();
    renderConnectList();
    showTab('remote');
    setStatus('warn', 'Conectando…');

    var pageSecure = location.protocol === 'https:';
    var secure = tv.port ? String(tv.port).indexOf('3000') !== 0 : true;

    var client = new NS.SSAPClient({
      host: tv.host,
      port: tv.port || null,
      secure: secure,
      clientKey: tv.key || null,
      useProxy: !!tv.proxy,
      onLog: function (m, l) { log('[' + tv.host + '] ' + m, l); },
      onState: function (s) { handleClientState(s); },
      onPairing: function (active) { showPairingOverlay(active); },
      onKey: function (k) { tv.key = k; saveConfig(); renderConnectList(); log('Chave de pareamento salva.', 'ok'); },
      onAttempt: function (info) { state.lastAttempt = info; },
      onInfo: function (info) {
        if (info && info.modelName) {
          tv.model = info.modelName;
          saveConfig();
          renderConnectList();
        }
      }
    });

    state.client = client;
    log('Iniciando conexão com ' + tv.host + (pageSecure ? ' (página HTTPS)' : ''));

    try {
      await client.connect();
      tv.secure = client.secure;
      tv.port = client.port;
      tv.proxy = client.useProxy;
      tv.certOk = true;
      saveConfig();

      var webos = new NS.WebOS(client);
      state.webos = webos;
      webos.on('state', renderRemoteState);
      await webos.start();

      state.connected = true;
      setStatus('ok', describeState());
      renderRemoteState(webos.state);
      showPairingOverlay(false);
      toast('Conectado a ' + (tv.name || tv.host), 'ok');
      log('Conectado usando ' + client.url() + (client.useProxy ? ' via proxy Origin:null' : ' direto'), 'ok');
    } catch (err) {
      showPairingOverlay(false);
      handleConnectError(err, tv);
    }
  }

  function describeState() {
    var w = state.webos;
    if (!w) return 'Conectado';
    var s = w.state;
    var parts = [];
    if (s.appId === APP_LIVETV && s.channel && s.channel.number) parts.push('Canal ' + s.channel.number);
    else if (s.appName) parts.push(s.appName);
    else if (s.appId) parts.push(shortAppName(s.appId));
    if (typeof s.volume === 'number') parts.push(s.muted ? 'mudo' : 'vol ' + s.volume);
    return parts.join(' · ') || 'Conectado';
  }

  function shortAppName(appId) {
    return String(appId).replace(/^com\.webos\.app\./, '').replace(/\.leanback.*$/, '');
  }

  function handleClientState(s) {
    if (s === 'connecting') setStatus('warn', 'Conectando…');
    else if (s === 'connected') {
      setStatus('ok', describeState());
      state.tvOff = false;
      if (!state.connected) {
        state.connected = true;
        if (state.wasConnected) {
          toast('Reconectado', 'ok');
          if (state.webos) { state.webos.loadApps(); state.webos.loadChannels(); state.webos.loadInputs(); }
        }
      }
      state.wasConnected = true;
    } else if (s === 'disconnected') {
      state.connected = false;
      if (state.tvOff) setStatus('idle', 'TV desligada — tentando reconectar…');
      else setStatus('warn', 'Conexão perdida — reconectando…');
    } else if (s === 'error' || s === 'closed') {
      state.connected = false;
      setStatus('err', 'Desconectado');
    }
  }

  function handleConnectError(err, tv) {
    state.connected = false;
    setStatus('err', 'Falha na conexão');
    log('Falha ao conectar: ' + err.message, 'error');
    showConnectErrorModal(err, tv);
  }

  function certUrl(tv) {
    var port = tv.port && String(tv.port).indexOf('3000') === 0 ? '3001' : (tv.port || '3001');
    return 'https://' + tv.host + ':' + port + '/';
  }

  function pageOriginIsLocal() {
    if (location.protocol === 'file:') return true;
    return NS.hostIsLocal(location.hostname);
  }

  /* Se a página está sendo servida de um IP privado, usa a mesma faixa para
   * completar IPs digitados só com o último número (ex.: "10" -> 192.168.1.10). */
  function smartSubnetPrefix() {
    var host = location.hostname;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host) && NS.hostIsLocal(host)) {
      return host.split('.').slice(0, 3).join('.') + '.';
    }
    return '192.168.0.';
  }

  /* Permite abrir o app já conectando: /?tv=192.168.1.10  (ou ?tv=10 em modo local) */
  function readTvFromUrl() {
    var params;
    try { params = new URLSearchParams(location.search); } catch (e) { return null; }
    var tv = (params.get('tv') || '').trim();
    if (!tv) return null;
    if (/^\d{1,3}$/.test(tv)) tv = smartSubnetPrefix() + tv;
    var port = parseInt(params.get('port') || '', 10) || null;
    var name = (params.get('name') || '').trim();
    return { host: tv, port: port, name: name || ('TV ' + tv) };
  }

  /* Aviso fixo na tela inicial quando o app está publicado (origem pública) e
   * o navegador tem chance de bloquear o acesso à rede local. */
  function maybeShowLnaWarning() {
    if (!lnaBlockLikely()) return;
    var screen = $('#screen-connect');
    var hero = screen.querySelector('.hero');
    var card = el('div', { class: 'warn-card' }, [
      el('strong', { text: 'Atenção: esta página publicada não controla a TV no Chrome/Edge' }),
      el('p', { text: 'Chrome/Edge bloqueiam conexões de páginas públicas (GitHub Pages) para a rede local, e a própria TV recusa conexões diretas vindas de páginas web (filtro de origem, código 1008). Não existe ajuste no navegador que resolva as duas coisas — o caminho é o modo local.' }),
      el('p', { text: 'Modo local: rode “node serve.js” na pasta do projeto e abra o endereço http://SEU-IP:8080 no computador ou no celular.' })
    ]);
    if (hero && hero.nextSibling) screen.insertBefore(card, hero.nextSibling);
    else screen.insertBefore(card, screen.firstChild);
  }

  function chromiumMajor() {
    var m = navigator.userAgent.match(/(?:Chrom(?:e|ium)|Edg|OPR|Brave)\/(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  }

  /* O Chrome/Edge restringem conexões de páginas públicas para IPs da rede
   * local (Local Network Access). Para WebSocket não existe prompt: falha mudo. */
  function lnaBlockLikely() {
    return location.protocol === 'https:' && !pageOriginIsLocal() && chromiumMajor() >= 142;
  }

  function showConnectErrorModal(err, tv) {
    var pageSecure = location.protocol === 'https:';
    var attempts = err.attempts || [];
    var fastFail = attempts.some(function (a) { return a.certSuspected; });
    var isApple = /iPad|iPhone|iPod/.test(navigator.userAgent);
    var lna = lnaBlockLikely();

    openModal({
      title: 'Não foi possível conectar',
      build: function (body, foot) {
        body.appendChild(el('p', { text: 'Erro: ' + err.message }));

        if (lna) {
          body.appendChild(el('p', {
            text: 'Causa provável: o Chrome/Edge 142+ bloqueia conexões de sites públicos (como o GitHub Pages) para aparelhos da sua rede local — é o recurso "Local Network Access". Para WebSocket não aparece aviso de permissão: a conexão simplesmente falha.'
          }));
          body.appendChild(localModeInstructions());
          body.appendChild(el('p', {
            class: 'hint muted small',
            text: 'Não existe ajuste no navegador que libere esta página publicada para TVs LG: autorizar a rede local (política LocalNetworkAllowedForUrls) faz o Chrome permitir a conexão, mas a TV a recusa por causa do cabeçalho Origin (1008); o proxy que resolveria isso é bloqueado pelo navegador (verificado no net-log: ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS).'
          }));
          body.appendChild(el('p', { class: 'hint', text: 'Se você já está no modo local e ainda falha, o motivo mais provável é o certificado da TV:' }));
          body.appendChild(certSteps(tv));
        } else if (pageSecure || fastFail) {
          body.appendChild(el('p', {
            text: 'A causa mais comum é o certificado da TV: se ela exige conexão segura (porta 3001), usa um certificado próprio que o navegador precisa confirmar uma vez neste aparelho.'
          }));
          body.appendChild(certSteps(tv));
          if (isApple) {
            body.appendChild(el('p', {
              class: 'hint muted small',
              text: 'No iPhone/iPad o Safari normalmente não permite aceitar esse certificado. Use Chrome/Edge em um computador ou Android, ou rode o modo local (node serve.js) e abra pelo endereço da rede.'
            }));
          }
        } else if (isApple) {
          body.appendChild(el('p', {
            class: 'hint muted small',
            text: 'No iPhone/iPad o Safari bloqueia conexões com certificado próprio. Para TVs que aceitam ws:// (porta 3000) funciona; para as que exigem TLS, use Chrome/Edge no Android ou no computador.'
          }));
        }

        if (tv.key) {
          body.appendChild(el('p', { class: 'hint muted small', text: 'Já existe uma chave de pareamento salva. Se você restaurou a TV ou ela recusou a conexão, use “Esquecer pareamento” nos ajustes e conecte de novo.' }));
        }

        body.appendChild(el('p', { class: 'hint muted small', text: 'Detalhes técnicos: ' + attempts.map(function (a) { return a.url + ' (' + (a.proxy ? 'proxy' : 'direto') + ', ' + a.elapsed + 'ms)'; }).join(' · ') }));

        foot.appendChild(el('button', { class: 'btn primary', text: 'Abrir certificado da TV', onclick: function () { window.open(certUrl(tv), '_blank', 'noopener'); } }));
        foot.appendChild(el('button', { class: 'btn', text: 'Tentar de novo', onclick: function () { closeModal(); connectTv(tv); } }));
        foot.appendChild(el('button', { class: 'btn ghost', text: 'Editar TV', onclick: function () { closeModal(); openTvForm(tv); } }));
        foot.appendChild(el('button', { class: 'btn ghost', text: 'Escolher outra TV', onclick: function () { closeModal(); disconnect(); showScreen('connect'); renderConnectList(); } }));
      }
    });
  }

  function certSteps(tv) {
    return el('ol', { class: 'hint' }, [
      el('li', { text: 'Toque em “Abrir certificado da TV” (abre https://' + tv.host + ':3001).' }),
      el('li', { text: 'No aviso do navegador, escolha “Avançado” → “Continuar mesmo assim” (a TV mostra uma página com “Hello World” — é normal).' }),
      el('li', { text: 'Volte para esta aba e toque em “Tentar de novo”.' })
    ]);
  }

  function localModeInstructions() {
    return el('div', {}, [
      el('p', { class: 'hint', text: 'Como usar o modo local (recomendado):' }),
      el('ol', { class: 'hint' }, [
        el('li', { text: 'No computador que está na mesma rede da TV, abra a pasta do projeto.' }),
        el('li', { text: 'Rode “node serve.js” — ou dê dois cliques em “iniciar-servidor.cmd”.' }),
        el('li', { text: 'O script mostra um endereço como http://192.168.0.10:8080. Abra esse endereço no computador ou no celular (mesma rede).' }),
        el('li', { text: 'Adicione a TV pelo IP e conecte. Se a TV aceitar a porta 3000, nem é preciso mexer com certificado.' })
      ])
    ]);
  }

  /* ================= controle remoto ================= */

  function currentWebos() {
    if (!state.webos || !state.webos.client.isConnected()) {
      toast('Sem conexão com a TV.', 'warn');
      return null;
    }
    return state.webos;
  }

  async function doButton(name) {
    var w = state.webos;
    if (!w) { toast('Sem conexão com a TV.', 'warn'); return; }
    try {
      await w.button(name);
    } catch (e) {
      toast(e.message || 'Comando falhou', 'warn');
    }
  }

  async function doAction(action) {
    // ações que não falam com a TV
    if (action === 'numpad') { $('#numpad').classList.toggle('hidden'); return; }
    if (action === 'num-back') {
      state.numpadBuffer = state.numpadBuffer.slice(0, -1);
      renderNumpad();
      return;
    }
    if (action === 'inputs') { openInputsModal(); return; }

    if (action === 'power' && !state.webos) {
      if (state.tv) connectTv(state.tv);
      toast('TV inacessível agora. Para ligar, use o controle físico — o navegador não envia Wake-on-LAN.', 'warn');
      return;
    }

    var w = state.webos;
    if (!w) { toast('Sem conexão com a TV.', 'warn'); return; }
    try {
      switch (action) {
        case 'power': {
          if (w.state.power === 'Screen Off') { await w.screenOn(); toast('Tela ligada', 'ok'); }
          else {
            state.tvOff = true;
            setStatus('idle', 'TV desligada — reconectarei quando ela voltar');
            await w.powerOff();
            toast('TV desligada', 'ok');
          }
          break;
        }
        case 'screen': {
          if (w.state.power === 'Screen Off') { await w.screenOn(); toast('Tela ligada', 'ok'); }
          else { await w.screenOff(); toast('Tela desligada (som continua)', 'ok'); }
          break;
        }
        case 'mute': await w.toggleMute(); break;
        case 'ok': await w.click(); break;
        case 'send-text': await sendText(); break;
        case 'enter-key': await sendEnterKey(); break;
        case 'del-1': await sendDelete(1); break;
        case 'del-10': await sendDelete(10); break;
        case 'del-all': await sendDelete(40, true); break;
        case 'num-ok':
          await tuneNumpad();
          break;
        default:
          toast('Ação desconhecida: ' + action, 'warn');
      }
    } catch (e) {
      toast(e.message || 'Comando falhou', 'warn');
    }
  }

  function renderNumpad() {
    var box = $('#numpad-display');
    box.innerHTML = '';
    if (!state.numpadBuffer) box.appendChild(el('span', { class: 'muted', text: 'canal…' }));
    else box.appendChild(el('span', { text: state.numpadBuffer }));
  }

  async function tuneNumpad() {
    var w = currentWebos();
    if (!w) return;
    var ch = state.numpadBuffer;
    if (!ch) { toast('Digite o número do canal primeiro.', 'warn'); return; }
    try {
      await w.openChannel(ch);
      toast('Trocando para o canal ' + ch, 'ok');
      state.numpadBuffer = '';
      renderNumpad();
    } catch (e) {
      toast('Não foi possível trocar de canal (' + e.message + '). Tente pela lista em Apps → Canais.', 'err');
    }
  }

  function renderRemoteState(s) {
    if (!s) return;

    var volEl = $('#volume-readout');
    if (typeof s.volume === 'number') volEl.textContent = s.muted ? 'mudo' : String(s.volume);
    else volEl.textContent = '–';
    volEl.classList.toggle('dim', typeof s.volume !== 'number');

    var muteBtn = document.querySelector('[data-action="mute"]');
    if (muteBtn) muteBtn.classList.toggle('on', !!s.muted);

    var chEl = $('#channel-readout');
    if (s.channel && s.channel.number) { chEl.textContent = s.channel.number; chEl.classList.remove('dim'); }
    else { chEl.textContent = '–'; chEl.classList.add('dim'); }

    if (state.connected) {
      setStatus('ok', describeState());
      $('#tv-name').textContent = state.tv.name || state.tv.host;
    }

    renderApps(s);
    renderChannels(s);
    renderInputs(s);
  }

  /* ================= abas: dados ================= */

  function ensureAppsData() {
    var w = state.webos;
    if (!w) return;
    if (w.state.apps === null) w.loadApps();
    if (w.state.channels === null) w.loadChannels();
    if (w.state.inputs === null) w.loadInputs();
  }

  function appInitial(title) {
    var clean = String(title || '?').replace(/[^\p{L}\p{N} ]/gu, ' ').trim();
    if (!clean) return '?';
    var parts = clean.split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  function appColor(app) {
    if (KNOWN_COLORS[app.id]) return KNOWN_COLORS[app.id];
    var hash = 0;
    var s = String(app.id || app.title || '');
    for (var i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) | 0;
    return COLOR_PALETTE[Math.abs(hash) % COLOR_PALETTE.length];
  }

  function tile(app, onClick) {
    var initial = el('span', { class: 'tile-initial', text: appInitial(app.title) });
    initial.style.background = appColor(app);
    var node = el('button', { class: 'app-tile' }, [initial, el('span', { class: 'tile-title', text: app.title })]);
    node.addEventListener('click', onClick);
    return node;
  }

  function renderApps(s) {
    if (!s || (s.apps === null && !NS.DEFAULT_APPS)) return;
    var box = $('#apps-grid');
    if (!box) return;
    var list = (s.apps && s.apps.length) ? s.apps : NS.DEFAULT_APPS;
    if (state._appsRef === list && state._appsQuery === (getAppQuery())) return;
    state._appsRef = list;
    state._appsQuery = getAppQuery();

    var note = $('#apps-note');
    if (s.apps && s.apps.length) {
      note.textContent = s.apps.length + ' app(s) encontrados na TV.';
    } else if (s.apps === null) {
      note.textContent = 'Carregando apps da TV… mostrando atalhos padrão.';
    } else {
      note.textContent = 'A TV não liberou a lista de apps. Mostrando atalhos padrão.';
    }

    var query = (state._appsQuery || '').toLowerCase();
    var filtered = list.filter(function (a) { return !query || String(a.title || '').toLowerCase().indexOf(query) !== -1; });

    box.innerHTML = '';
    if (!filtered.length) {
      box.appendChild(el('p', { class: 'muted small list-empty', text: 'Nenhum app encontrado.' }));
      return;
    }
    filtered.slice(0, 80).forEach(function (app) {
      box.appendChild(tile(app, async function () {
        try {
          await state.webos.launchApp(app.id);
          toast('Abrindo ' + app.title, 'ok');
        } catch (e) {
          toast('Não foi possível abrir ' + app.title + ': ' + e.message, 'err');
        }
      }));
    });
  }

  function getAppQuery() {
    var input = $('#app-search');
    return input ? input.value : '';
  }

  function renderChannels(s) {
    if (!s) return;
    var box = $('#channels-list');
    if (!box) return;
    var list = s.channels;
    var count = $('#channels-count');
    if (list === null) {
      box.innerHTML = '';
      box.appendChild(el('p', { class: 'muted small list-empty', text: 'Carregando canais da TV…' }));
      count.textContent = '';
      return;
    }
    if (!list.length) {
      box.innerHTML = '';
      box.appendChild(el('p', { class: 'muted small list-empty', text: 'Nenhum canal encontrado (a TV precisa ter canais sintonizados).' }));
      count.textContent = '';
      return;
    }

    var query = ($('#ch-search').value || '').toLowerCase().trim();
    var filtered = list.filter(function (c) {
      if (!query) return true;
      var number = String((c.channelNumber || '') + ' ' + (c.majorNumber || '') + '-' + (c.minorNumber || '') + ' ' + (c.channelId || ''));
      return number.toLowerCase().indexOf(query) !== -1 || String(c.channelName || '').toLowerCase().indexOf(query) !== -1;
    });

    count.textContent = filtered.length + ' de ' + list.length;
    if (state._chRef !== list || state._chQuery !== query || state._chCurrent !== (s.channel && s.channel.id)) {
      state._chRef = list;
      state._chQuery = query;
      state._chCurrent = s.channel && s.channel.id;
      box.innerHTML = '';
      var limited = filtered.slice(0, 150);
      limited.forEach(function (ch) {
        var num = ch.channelNumber || (ch.majorNumber !== undefined ? String(ch.majorNumber) + (ch.minorNumber !== undefined ? '-' + ch.minorNumber : '') : ch.channelId);
        var item = el('button', { class: 'list-item' + (s.channel && s.channel.id === ch.channelId ? ' current' : '') }, [
          el('span', { class: 'ch-num', text: String(num) }),
          el('span', { class: 'ch-name', text: ch.channelName || 'Canal ' + num })
        ]);
        item.addEventListener('click', async function () {
          try {
            await state.webos.openChannel(ch.channelId || num);
            toast('Trocando para ' + (ch.channelName || num), 'ok');
          } catch (e) {
            toast('Falha ao trocar de canal: ' + e.message, 'err');
          }
        });
        box.appendChild(item);
      });
      if (filtered.length > limited.length) {
        box.appendChild(el('p', { class: 'muted small list-empty', text: 'Mostrando os primeiros ' + limited.length + ' canais. Use a busca para filtrar.' }));
      }
    }
  }

  function renderInputs(s) {
    if (!s) return;
    var box = $('#inputs-grid');
    if (!box) return;
    var list = s.inputs;
    if (state._inpRef === list) return;
    state._inpRef = list;
    box.innerHTML = '';
    if (list === null) {
      box.appendChild(el('p', { class: 'muted small list-empty', text: 'Carregando entradas…' }));
      return;
    }
    if (!list.length) {
      box.appendChild(el('p', { class: 'muted small list-empty', text: 'Nenhuma entrada externa detectada.' }));
      return;
    }
    list.forEach(function (input) {
      var title = input.label || input.appId || 'Entrada';
      box.appendChild(tile({ id: input.appId, title: title }, async function () {
        try {
          await state.webos.switchInput(input.appId);
          toast('Trocando para ' + title, 'ok');
        } catch (e) {
          toast('Falha ao trocar de entrada: ' + e.message, 'err');
        }
      }));
    });
  }

  function openInputsModal() {
    var list = (state.webos && state.webos.state.inputs) || [];
    openModal({
      title: 'Entradas',
      build: function (body) {
        if (!list.length) {
          body.appendChild(el('p', { class: 'muted', text: state.webos ? 'Nenhuma entrada encontrada. Abra a aba Apps para recarregar.' : 'Conecte-se à TV para listar as entradas.' }));
          return;
        }
        var wrap = el('div', { class: 'apps-grid' });
        list.forEach(function (input) {
          var title = input.label || input.appId;
          wrap.appendChild(tile({ id: input.appId, title: title }, async function () {
            try {
              await state.webos.switchInput(input.appId);
              toast('Trocando para ' + title, 'ok');
              closeModal();
            } catch (e) {
              toast('Falha: ' + e.message, 'err');
            }
          }));
        });
        body.appendChild(wrap);
      }
    });
  }

  /* ================= teclado ================= */

  async function sendText() {
    var w = currentWebos();
    if (!w) return;
    var input = $('#text-input');
    var text = input.value;
    if (!text) { toast('Digite algum texto primeiro.', 'warn'); return; }
    try {
      await w.insertText(text);
      toast('Texto enviado para a TV', 'ok');
      input.value = '';
    } catch (e) {
      toast('Falha ao enviar texto: ' + e.message + ' (deixe um campo de texto aberto na TV)', 'err');
    }
  }

  async function sendDelete(count, silent) {
    var w = currentWebos();
    if (!w) return;
    try {
      await w.deleteChars(count);
    } catch (e) {
      if (!silent) toast('Nada para apagar ou comando recusado.', 'warn');
    }
  }

  async function sendEnterKey() {
    var w = currentWebos();
    if (!w) return;
    try {
      await w.sendEnter();
    } catch (e) {
      toast('Falha ao enviar Enter: ' + e.message, 'warn');
    }
  }

  /* ================= modais ================= */

  function openModal(opts) {
    $('#modal-title').textContent = opts.title || '';
    var body = $('#modal-body');
    var foot = $('#modal-foot');
    body.innerHTML = '';
    foot.innerHTML = '';
    if (opts.build) opts.build(body, foot);
    $('#modal').classList.remove('hidden');
  }

  function closeModal() {
    $('#modal').classList.add('hidden');
  }

  function openTvForm(existing) {
    var tv = existing || null;
    openModal({
      title: tv ? 'Editar TV' : 'Adicionar TV',
      build: function (body, foot) {
        body.appendChild(el('p', { class: 'hint muted small', text: 'Informe o nome (opcional) e o endereço IP da TV na sua rede. Para ajustes finos, defina a porta manualmente.' }));

        var nameInput = el('input', { type: 'text', value: tv ? tv.name : '', placeholder: 'TV da sala', autocomplete: 'off' });
        body.appendChild(el('label', { class: 'field' }, [el('span', { text: 'Nome' }), nameInput]));

        var hostInput = el('input', { type: 'text', value: tv ? tv.host : '', placeholder: '192.168.0.123', inputmode: 'decimal', autocomplete: 'off' });
        body.appendChild(el('label', { class: 'field' }, [el('span', { text: 'Endereço IP' }), hostInput]));

        var portInput = el('input', { type: 'text', value: tv && tv.port ? String(tv.port) : '', placeholder: 'detectar (3001/3000)', inputmode: 'numeric', autocomplete: 'off' });
        body.appendChild(el('label', { class: 'field' }, [el('span', { text: 'Porta (avançado, opcional)' }), portInput]));

        body.appendChild(el('p', { class: 'hint muted small', text: 'Deixe a porta vazia para tentar automaticamente wss://IP:3001 (seguro) e ws://IP:3000 (sem TLS, TVs antigas).' }));

        if (tv) {
          var forget = el('button', {
            class: 'btn ghost',
            text: 'Esquecer pareamento',
            onclick: function () { forgetKey(tv); closeModal(); }
          });
          body.appendChild(el('div', { class: 'kb-row' }, [forget]));
        }

        var removeBtn = null;
        if (tv) {
          removeBtn = el('button', {
            class: 'btn ghost',
            text: 'Remover TV',
            onclick: function () {
              state.config.tvs = state.config.tvs.filter(function (t) { return t.id !== tv.id; });
              if (state.config.last === tv.id) state.config.last = null;
              saveConfig();
              disconnect();
              closeModal();
              showScreen('connect');
              renderConnectList();
            }
          });
        }

        foot.appendChild(el('button', {
          class: 'btn primary',
          text: tv ? 'Salvar e conectar' : 'Salvar e conectar',
          onclick: async function () {
            var host = hostInput.value.trim();
            if (!host) { toast('Informe o endereço IP da TV.', 'warn'); return; }
            if (/^\d{1,3}$/.test(host)) host = smartSubnetPrefix() + host;
            var port = portInput.value.trim() ? parseInt(portInput.value.trim(), 10) : null;
            if (port !== null && (!port || port < 1 || port > 65535)) { toast('Porta inválida.', 'warn'); return; }

            var record = {
              id: tvId(host, null),
              name: nameInput.value.trim() || ('TV ' + host),
              host: host,
              port: port,
              secure: port ? port !== 3000 : true,
              key: tv ? tv.key : null,
              proxy: tv ? tv.proxy : false,
              certOk: tv ? tv.certOk : false,
              model: tv ? tv.model : ''
            };

            var idx = -1;
            for (var i = 0; i < state.config.tvs.length; i++) {
              if (state.config.tvs[i].id === (tv ? tv.id : record.id)) { idx = i; break; }
            }
            if (idx >= 0) state.config.tvs[idx] = Object.assign(state.config.tvs[idx], record);
            else state.config.tvs.push(record);
            saveConfig();
            closeModal();
            await connectTv(findTv(record.id));
          }
        }));
        foot.appendChild(el('button', { class: 'btn ghost', text: 'Cancelar', onclick: closeModal }));
        if (removeBtn) foot.appendChild(removeBtn);
      }
    });
  }

  function forgetKey(tv) {
    tv.key = null;
    saveConfig();
    renderConnectList();
    toast('Pareamento esquecido. A TV vai pedir permissão de novo.', 'warn');
  }

  function openSettings() {
    var tv = state.tv;
    if (!tv) return;
    var client = state.client;
    openModal({
      title: 'Ajustes',
      build: function (body, foot) {
        body.appendChild(el('dl', { class: 'kv' }, [
          el('dt', { text: 'Nome' }), el('dd', { text: tv.name || '—' }),
          el('dt', { text: 'Endereço' }), el('dd', { text: tv.host }),
          el('dt', { text: 'Modelo' }), el('dd', { text: tv.model || '—' }),
          el('dt', { text: 'Conexão' }), el('dd', { text: client ? client.url() + (client.useProxy ? ' · proxy Origin:null' : ' · direto') : '—' }),
          el('dt', { text: 'Pareamento' }), el('dd', { text: tv.key ? 'salvo (client-key ' + String(tv.key).slice(0, 6) + '…)' : 'não pareado' }),
          el('dt', { text: 'Página' }), el('dd', { text: location.protocol + ' · ' + (pageOriginIsLocal() ? 'origem local' : 'origem pública') + (lnaBlockLikely() ? ' · Chrome/Edge podem bloquear a rede local' : '') })
        ]));

        var toggle = el('input', { type: 'checkbox' });
        toggle.checked = state.showDebug;
        toggle.addEventListener('change', function () { state.showDebug = toggle.checked; });
        body.appendChild(el('label', { class: 'check' }, [toggle, el('span', { text: 'Mostrar detalhes técnicos no diagnóstico' })]));

        foot.appendChild(el('button', { class: 'btn', text: 'Reconectar', onclick: function () { closeModal(); connectTv(tv); } }));
        foot.appendChild(el('button', { class: 'btn ghost', text: 'Editar TV', onclick: function () { closeModal(); openTvForm(tv); } }));
        foot.appendChild(el('button', {
          class: 'btn ghost',
          text: 'Esquecer pareamento',
          onclick: function () {
            forgetKey(tv);
            closeModal();
            connectTv(tv);
          }
        }));
      }
    });
  }

  function openHelp() {
    openModal({
      title: 'Ajuda e diagnóstico',
      build: function (body) {
        body.appendChild(el('details', { class: 'help' }, [
          el('summary', { text: 'O site publicado (GitHub Pages) não conecta no Chrome/Edge' }),
          el('p', { text: 'Desde o Chrome 142 (out/2025) o navegador bloqueia conexões de sites públicos para a rede local ("Local Network Access"). Em WebSocket não existe aviso de permissão: a conexão falha em silêncio. Isso não é um problema da TV nem do app.' }),
          el('p', { text: 'Solução recomendada: usar o app em modo local — na pasta do projeto rode "node serve.js" (ou dê dois cliques em iniciar-servidor.cmd) e abra o endereço http://SEU-IP:8080 no computador ou celular. A página passa a ser local, então o navegador permite falar com a TV.' }),
          el('p', { text: 'Alternativas: usar Firefox (ainda não aplica essa regra) ou a política abaixo — que só ajuda se a sua TV aceitar conexões diretas do navegador.' })
        ]));
        body.appendChild(el('details', { class: 'help' }, [
          el('summary', { text: 'Liberar o site publicado no Chrome/Edge (avançado)' }),
          el('p', { text: 'IMPORTANTE: na maioria das TVs LG isto não resolve — a TV recusa conexões diretas de páginas web com o erro 1008 (filtro de Origin) e o proxy necessário é bloqueado pelo navegador. Só vale a pena se você já viu a conexão direta funcionar (TVs que não filtram a origem).' }),
          el('p', { text: 'No Windows, abra o Prompt de Comando como Administrador, rode os comandos abaixo e feche todas as janelas do navegador:' }),
          el('pre', { class: 'code-block', text: 'reg add "HKLM\\SOFTWARE\\Policies\\Google\\Chrome\\LocalNetworkAllowedForUrls" /v 1 /t REG_SZ /d "' + location.origin + '" /f\nreg add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge\\LocalNetworkAllowedForUrls" /v 1 /t REG_SZ /d "' + location.origin + '" /f' }),
          el('p', { text: 'Confira em chrome://policy (ou edge://policy). O navegador passa a mostrar “gerenciado pela sua organização” — é só o efeito da política. Para remover: reg delete "HKLM\\SOFTWARE\\Policies\\Google\\Chrome" /f (e o equivalente do Edge), como Administrador. No Chrome do Android isso não é configurável pelo usuário.' })
        ]));
        body.appendChild(el('details', { class: 'help' }, [
          el('summary', { text: 'A TV não conecta / erro de certificado' }),
          el('p', { text: 'Abra https://' + (state.tv ? state.tv.host : 'IP-DA-TV') + ':3001 no navegador, aceite o certificado (Avançado → Continuar mesmo assim) e volte aqui para reconectar. A TV mostra uma página com “Hello World” — isso é normal e confirma que o serviço está ativo. No iPhone o Safari costuma não permitir esse aceite; use Chrome/Edge no computador/Android.' })
        ]));
        body.appendChild(el('details', { class: 'help' }, [
          el('summary', { text: 'Modo local, sem certificado e sem servidor de verdade' }),
          el('p', { text: 'Se a sua TV aceita conexões sem TLS (firmware mais antigo), basta servir esta pasta por HTTP: rode "node serve.js" (ou "npx serve", ou python -m http.server) e abra o endereço local — o app tenta ws://IP:3000 automaticamente. Também funciona abrindo o index.html direto do disco (file://).' })
        ]));
        body.appendChild(el('details', { class: 'help' }, [
          el('summary', { text: 'Alguns botões não respondem (setas, OK, voltar)' }),
          el('p', { text: 'As setas e o OK dependem do “canal de entrada” da TV, liberado junto com o emparelhamento. Se a TV negou (firmwares novos exigem permissões específicas), tente: Ajustes → Esquecer pareamento → conectar e aceitar o pedido na TV novamente.' })
        ]));
        body.appendChild(el('details', { class: 'help' }, [
          el('summary', { text: 'Não consigo ligar a TV' }),
          el('p', { text: 'Navegadores não enviam Wake-on-LAN (UDP). Com “Quick Start+” ativo a TV pode aceitar o comando de ligar; senão, use o controle físico. Desligar sempre funciona.' })
        ]));

        body.appendChild(el('h3', { class: 'panel-title', text: 'Diagnóstico' }));
        var logBox = el('div', { class: 'log-box' });
        function append(line) {
          if (!levelVisible(line.level)) return;
          logBox.appendChild(el('div', { class: 'log-line ' + line.level, text: fmtTime(line.t) + '  ' + line.msg }));
          while (logBox.children.length > 250) logBox.removeChild(logBox.firstChild);
          logBox.scrollTop = logBox.scrollHeight;
        }
        NS.logBuffer.forEach(append);
        if (state._helpLogHandler) window.removeEventListener('wtr-log', state._helpLogHandler);
        state._helpLogHandler = function (ev) { append(ev.detail); };
        window.addEventListener('wtr-log', state._helpLogHandler);
        body.appendChild(logBox);

        var foot = $('#modal-foot');
        foot.appendChild(el('button', {
          class: 'btn',
          text: 'Copiar log',
          onclick: function () {
            var text = NS.logBuffer.map(function (l) { return fmtTime(l.t) + ' [' + l.level + '] ' + l.msg; }).join('\n');
            var info = 'Controle TV — diagnóstico\n' + 'URL: ' + location.href + '\nSHA: ' + (document.documentElement.getAttribute('data-build') || 'dev') + '\nUA: ' + navigator.userAgent + '\n\n';
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(info + text).then(function () { toast('Log copiado', 'ok'); }, function () { toast('Não foi possível copiar', 'warn'); });
            } else {
              toast('Cópia não suportada neste navegador', 'warn');
            }
          }
        }));
        foot.appendChild(el('button', { class: 'btn ghost', text: 'Limpar log', onclick: function () { NS.logBuffer.length = 0; logBox.innerHTML = ''; } }));
        foot.appendChild(el('button', { class: 'btn primary', text: 'Fechar', onclick: closeModal }));
      }
    });
  }

  /* ================= ligação de eventos ================= */

  function bindPress(element, fn, repeat) {
    var holdTimer = null;
    var repeatTimer = null;
    var active = false;

    function start(ev) {
      if (active) return;
      if (ev && typeof ev.button === 'number' && ev.button !== 0) return;
      active = true;
      vibrate(8);
      fn();
      if (repeat) {
        holdTimer = setTimeout(function () {
          repeatTimer = setInterval(fn, 170);
        }, 450);
      }
    }

    function stop() {
      if (!active) return;
      active = false;
      clearTimeout(holdTimer);
      clearInterval(repeatTimer);
      holdTimer = null;
      repeatTimer = null;
    }

    element.addEventListener('pointerdown', start);
    element.addEventListener('pointerup', stop);
    element.addEventListener('pointercancel', stop);
    element.addEventListener('pointerleave', stop);
    element.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });
    element.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        fn();
      }
    });
  }

  function bindUI() {
    $('#btn-add-tv').addEventListener('click', function () { openTvForm(null); });
    $('#btn-change-tv').addEventListener('click', function () {
      disconnect();
      showScreen('connect');
      renderConnectList();
    });
    $('#btn-settings').addEventListener('click', openSettings);
    $('#btn-help').addEventListener('click', openHelp);
    $('#btn-cancel-pair').addEventListener('click', function () {
      showPairingOverlay(false);
      if (state.client) state.client.close();
      toast('Pareamento cancelado.', 'warn');
    });

    var modal = $('#modal');
    modal.addEventListener('click', function (ev) {
      if (ev.target.hasAttribute && ev.target.hasAttribute('data-modal-close')) closeModal();
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && !modal.classList.contains('hidden')) closeModal();
    });

    document.querySelectorAll('.tabbar button, [data-tab]').forEach(function (btn) {
      btn.addEventListener('click', function () { showTab(btn.getAttribute('data-tab')); });
    });

    document.querySelectorAll('[data-cmd]').forEach(function (btn) {
      bindPress(btn, function () { doButton(btn.getAttribute('data-cmd')); }, btn.hasAttribute('data-repeat'));
    });

    document.querySelectorAll('[data-action]').forEach(function (btn) {
      bindPress(btn, function () { doAction(btn.getAttribute('data-action')); }, false);
    });

    document.querySelectorAll('[data-digit]').forEach(function (btn) {
      bindPress(btn, function () {
        var digit = btn.getAttribute('data-digit');
        if (state.numpadBuffer.length >= 6) return;
        if (digit === '-' && (state.numpadBuffer.indexOf('-') !== -1 || !state.numpadBuffer)) return;
        state.numpadBuffer += digit;
        renderNumpad();
      }, false);
    });

    $('#btn-install').addEventListener('click', function () {
      if (state.installPrompt) {
        state.installPrompt.prompt();
        state.installPrompt = null;
        $('#btn-install').classList.add('hidden');
      }
    });

    var appSearch = $('#app-search');
    appSearch.addEventListener('input', function () {
      state._appsRef = null;
      renderApps(state.webos ? state.webos.state : null);
    });

    var chSearch = $('#ch-search');
    chSearch.addEventListener('input', function () {
      state._chRef = null;
      renderChannels(state.webos ? state.webos.state : null);
    });

    document.addEventListener('keydown', function (ev) {
      if (ev.target.matches('textarea, input')) return;
      var map = {
        ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT',
        Enter: 'ENTER', Backspace: 'BACK', Escape: 'BACK', h: 'HOME', m: 'MUTE'
      };
      var cmd = map[ev.key];
      if (cmd) {
        ev.preventDefault();
        if (cmd === 'ENTER') doAction('ok');
        else doButton(cmd);
      }
    });
  }

  /* ================= PWA ================= */

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function (e) { log('Service worker não registrou: ' + e.message, 'warn'); });
    });
  }

  /* ================= inicialização ================= */

  function init() {
    bindUI();
    renderNumpad();
    renderConnectList();
    maybeShowLnaWarning();
    registerServiceWorker();
    log('Controle TV iniciado em ' + location.href, 'debug');

    window.addEventListener('beforeinstallprompt', function (ev) {
      ev.preventDefault();
      state.installPrompt = ev;
      $('#btn-install').classList.remove('hidden');
    });

    var fromUrl = readTvFromUrl();
    if (fromUrl) {
      var id = tvId(fromUrl.host, null);
      var existing = findTv(id);
      if (!existing) {
        existing = {
          id: id,
          name: fromUrl.name,
          host: fromUrl.host,
          port: fromUrl.port,
          secure: fromUrl.port ? fromUrl.port !== 3000 : true,
          key: null,
          proxy: false,
          certOk: false,
          model: ''
        };
        state.config.tvs.push(existing);
        saveConfig();
      }
      log('TV recebida pela URL: ' + fromUrl.host, 'info');
      connectTv(findTv(id));
      return;
    }

    var last = state.config.last ? findTv(state.config.last) : null;
    if (last) {
      connectTv(last);
    } else {
      showScreen('connect');
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
