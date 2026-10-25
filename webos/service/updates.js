'use strict';
var https = require('https');
var url = require('url');
var manifest = require('./update-manifest');
var CHANNEL = 'https://raw.githubusercontent.com/aston314/hongguo-tv-releases/main/webos-update.json';
var ROUTES = ['https://gh-proxy.com/', 'https://v4.gh-proxy.org/', 'https://gh-proxy.org/', 'https://ghfast.top/', ''];

function requestJSON(target, redirects, deadline) {
  redirects = redirects || 0;
  deadline = deadline || Date.now() + 4000;
  if (redirects > 3 || url.parse(target).protocol !== 'https:') return Promise.reject(new Error('Unsafe update redirect'));
  return new Promise(function (resolve, reject) {
    var settled = false, request;
    var timer = setTimeout(function () { finish(new Error('Update request timed out')); if (request) request.destroy(); }, Math.max(1, deadline - Date.now()));
    function finish(error, value) {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    }
    try {
      var parsed = url.parse(target);
      request = https.get({ protocol: parsed.protocol, hostname: parsed.hostname, port: parsed.port || 443, path: parsed.path || '/',
        headers: { Accept: 'application/json', 'User-Agent': 'Hongguo-webOS-update-check' } }, function (response) {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume(); clearTimeout(timer);
          requestJSON(url.resolve(target, response.headers.location), redirects + 1, deadline).then(function (value) { finish(null, value); }, finish);
          return;
        }
        if (response.statusCode !== 200) { response.resume(); finish(new Error('Update HTTP ' + response.statusCode)); return; }
        var chunks = [], size = 0;
        response.on('data', function (chunk) {
          size += chunk.length;
          if (size > 65536) { finish(new Error('Update manifest too large')); response.destroy(); return; }
          chunks.push(chunk);
        });
        response.on('error', finish);
        response.on('end', function () {
          try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch (error) { finish(error); }
        });
      });
      request.on('error', finish);
    } catch (error) { finish(error); }
  });
}

module.exports = function (options) {
  options = options || {};
  var read = options.requestJSON || requestJSON, pending = null;
  function check() {
    if (pending) return pending;
    var index = 0;
    var address = CHANNEL + '?check=' + Date.now();
    function next() {
      if (index >= ROUTES.length) {
        var error = new Error('webOS 更新检查失败，请稍后重试'); error.code = 'WEBOS_UPDATE_CHECK_FAILED'; error.status = 502;
        return Promise.reject(error);
      }
      var target = ROUTES[index++] + address;
      return Promise.resolve().then(function () { return read(target); }).then(manifest.validate).catch(next);
    }
    pending = next().then(function (value) { pending = null; return value; }, function (error) { pending = null; throw error; });
    return pending;
  }
  return { check: check };
};
