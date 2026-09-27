/* Controle TV — atalhos de apps usados antes de a TV enviar a lista real.
 * A lista verdadeira (com todos os apps instalados) vem da própria TV através
 * de ssap://com.webos.applicationManager/listLaunchPoints. */
(function () {
  'use strict';

  window.WTR = window.WTR || {};

  window.WTR.DEFAULT_APPS = [
    { id: 'netflix', title: 'Netflix' },
    { id: 'youtube.leanback.v4', title: 'YouTube' },
    { id: 'amazon', title: 'Prime Video' },
    { id: 'com.disney.disneyplus-prod', title: 'Disney+' },
    { id: 'com.wbd.stream', title: 'Max' },
    { id: 'com.globo.globoplay', title: 'Globoplay' },
    { id: 'spotify-beehive', title: 'Spotify' },
    { id: 'twitch', title: 'Twitch' },
    { id: 'com.webos.app.livetv', title: 'TV ao vivo' }
  ];
})();
