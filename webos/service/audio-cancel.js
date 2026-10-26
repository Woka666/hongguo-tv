'use strict';
function error(signal) {
  var e = new Error(signal && signal.reason === 'WEBOS_AUDIO_TIMEOUT' ? '音频准备超时' : '音频准备已取消');
  e.code = signal && signal.reason || 'WEBOS_AUDIO_CANCELLED'; e.status = 499; return e;
}
function check(signal) { if (signal && signal.aborted) throw error(signal); }
function create() {
  var listeners = [];
  var signal = { aborted: false, reason: '',
    addEventListener: function (name, callback) { if (name === 'abort' && listeners.indexOf(callback) < 0) listeners.push(callback); },
    removeEventListener: function (name, callback) { var i = listeners.indexOf(callback); if (name === 'abort' && i >= 0) listeners.splice(i, 1); }
  };
  return { signal: signal, abort: function (reason) {
    if (signal.aborted) return;
    signal.aborted = true; signal.reason = reason || 'WEBOS_AUDIO_CANCELLED';
    var pending = listeners.slice(); listeners = [];
    pending.forEach(function (callback) { callback(); });
  } };
}
module.exports = { create: create, check: check, error: error };
