(function (root, factory) {
  'use strict';
  var api = factory(typeof module === 'object' && module.exports ? require('../service/update-manifest') : root.HongguoWebOSUpdateManifest);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HongguoWebOSUpdates = api;
}(typeof window !== 'undefined' ? window : this, function (manifest) {
  'use strict';
  function create(options) {
    var key = 'hongguo-webos-update-notice-v1', saved = {}, pending = false, allowed = false;
    var now = options.now || Date.now, storage = options.storage;
    try { saved = JSON.parse(storage.getItem(key)) || {}; } catch (ignored) {}
    var lastAttempt = Number(saved.last_attempt) || 0, notified = String(saved.notified || '');
    var failedLastCheck = !!saved.failed;
    var latest = null;
    try { if (saved.manifest) latest = manifest.validate(saved.manifest); } catch (ignoredManifest) {}
    var status = { supported: true, manual_install: true, state: 'idle', current_version: options.version };
    function save() {
      try { storage.setItem(key, JSON.stringify({ last_attempt: lastAttempt, manifest: latest, notified: notified, failed: failedLastCheck })); } catch (ignored) {}
    }
    function applyLatest() {
      if (latest && manifest.compare(latest.version_name, options.version) > 0) status.state = 'available';
      else status.state = 'current';
    }
    if (latest) applyLatest();
    if (failedLastCheck) status.state = 'error';
    function check(automatic) {
      if (pending || automatic && lastAttempt > 0 && now() - lastAttempt >= 0 && now() - lastAttempt < 86400000) return;
      pending = true; lastAttempt = now(); failedLastCheck = true; save(); status.state = 'checking';
      return Promise.resolve().then(options.check).then(function (value) {
        var candidate = manifest.validate(value);
        if (latest && manifest.compare(candidate.version_name, latest.version_name) < 0) throw new Error('Stale update catalog');
        latest = candidate; failedLastCheck = false; applyLatest(); save();
      }).catch(function () { status.state = 'error'; save(); }).then(function () { pending = false; });
    }
    function text(key, fallback, params) { return options.text ? options.text(key, fallback, params) : fallback.replace(/\{version\}/g, params && params.version || ''); }
    return {
      check: function () { return check(false); },
      automatic: function () { return check(true); },
      setPromptAllowed: function (value) { allowed = !!value; },
      markNotified: function (version) {
        if (status.state === 'available' && latest && latest.version_name === version) { notified = version; save(); }
      },
      getStatus: function () {
        var value = Object.assign({}, status);
        value.prompt_allowed = allowed;
        value.message = text('ui.webosUpdateIdle', '每天检查一次新版本；请使用 webOS Dev Manager 手动安装。');
        if (status.state === 'checking') value.message = text('ui.checking', '检查中…');
        if (status.state === 'error') value.message = text('ui.webosUpdateFailed', '检查更新失败，请重试；正常使用不受影响。');
        if (status.state === 'current') value.message = text('ui.webosUpdateCurrent', '当前已是最新版本。webOS 更新需手动安装。');
        if (latest && manifest.compare(latest.version_name, options.version) > 0) {
          value.latest_version = latest.version_name; value.release_notes = latest.release_notes; value.release_url = latest.release_url;
          value.notified = notified === latest.version_name;
          if (status.state === 'available') value.message = text('ui.webosUpdateAvailable', '发现新版本 {version}，请使用 webOS Dev Manager 手动安装。', { version: latest.version_name });
        }
        return JSON.stringify(value);
      }
    };
  }
  return { create: create };
}));
