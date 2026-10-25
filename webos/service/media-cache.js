'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var TOKEN = /^[a-f0-9]{24}$/;

// Only this service's <token>/<token>.mp4[.part] entries belong to this cache.
// A playback session deliberately has no idle timeout: pausing is still use.
module.exports = function (root, options) {
  options = options || {};
  var now = options.now || Date.now;
  var maxBytes = options.maxBytes || 512 * 1024 * 1024;
  var ttl = options.ttl || 2 * 60 * 60 * 1000;
  var handoffMs = options.handoffMs || 2 * 60 * 1000;
  var blockBytes = Math.max(1, Math.min(4 * 1024 * 1024, Math.floor(maxBytes / 128)));
  var locks = Object.create(null), reservations = Object.create(null);
  var handoffs = Object.create(null), accessed = Object.create(null);
  var session = '', revision = -1, playing = '', timer = null;
  var lastScan = -Infinity, lastError = '';
  var partialBytes = 0, scanOK = false;
  var snapshot = { bytes: 0, files: 0, protected_files: 0, max_bytes: maxBytes, ttl_seconds: ttl / 1000 };

  function regular(file) {
    try { var stat = fs.lstatSync(file); return stat.isFile() && !stat.isSymbolicLink() ? stat : null; }
    catch (error) { if (error.code !== 'ENOENT') lastError = error.code || 'CACHE_STAT'; return null; }
  }
  function protectedToken(token) {
    return !!locks[token] || playing === token || Number(handoffs[token] || 0) > now();
  }
  function touch(token, handoff) {
    if (!TOKEN.test(token)) return;
    var time = now(), previous = accessed[token] || 0;
    accessed[token] = time;
    if (handoff) handoffs[token] = time + handoffMs;
    // Never change the MP4 mtime: it is also its HTTP If-Range validator.
    var dir = path.join(root, token), file = path.join(dir, token + '.mp4');
    try { if (fs.lstatSync(dir).isSymbolicLink()) return; } catch (ignoredDir) { return; }
    if (time - previous < 30000 || !regular(file)) return;
    try {
      var marker = path.join(dir, '.access');
      try { if (!fs.lstatSync(marker).isFile()) return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      fs.writeFileSync(marker, '', { mode: 384 });
      fs.utimesSync(marker, new Date(time), new Date(time));
    } catch (error) { lastError = error.code || 'CACHE_TOUCH'; }
  }
  function unlink(file) {
    if (!regular(file)) return false;
    try { fs.unlinkSync(file); return true; }
    catch (error) { lastError = error.code || 'CACHE_UNLINK'; return false; }
  }
  function scan() {
    partialBytes = 0; scanOK = false;
    var entries = [], names;
    try {
      var rootStat = fs.lstatSync(root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('unsafe cache root');
      names = fs.readdirSync(root);
      scanOK = true;
    } catch (error) { lastError = error.code || 'CACHE_ROOT'; return entries; }
    names.forEach(function (token) {
      if (!TOKEN.test(token)) return;
      var dir = path.join(root, token), stat;
      try { stat = fs.lstatSync(dir); } catch (ignored) { return; }
      if (!stat.isDirectory() || stat.isSymbolicLink()) return;
      var partial = path.join(dir, token + '.mp4.part');
      if (!locks[token]) unlink(partial); // crashed download, including old releases
      var partStat = regular(partial);
      if (partStat && !reservations[token]) partialBytes += partStat.size;
      var file = path.join(dir, token + '.mp4'), media = regular(file);
      var access = regular(path.join(dir, '.access'));
      if (media) entries.push({ token: token, file: file, bytes: media.size,
        used: Math.max(Number(accessed[token] || 0), access ? access.mtime.getTime() : media.mtime.getTime()) });
      else if (!locks[token]) {
        unlink(path.join(dir, '.access'));
        try { fs.rmdirSync(dir); } catch (ignoredDir) {}
      }
    });
    return entries;
  }
  function prune(force) {
    if (!force && now() - lastScan < 30000) return snapshot;
    lastScan = now();
    Object.keys(handoffs).forEach(function (token) { if (handoffs[token] <= now()) delete handoffs[token]; });
    var entries = scan(), reserved = Object.keys(reservations).reduce(function (sum, token) { return sum + reservations[token]; }, 0);
    var bytes = entries.reduce(function (sum, item) { return sum + item.bytes; }, reserved + partialBytes);
    var files = entries.length;
    entries.sort(function (a, b) { return a.used - b.used; });
    entries.forEach(function (item) {
      if (protectedToken(item.token) || now() - item.used < ttl && bytes <= maxBytes) return;
      if (unlink(item.file)) {
        bytes -= item.bytes; files--;
        unlink(path.join(root, item.token, '.access'));
        try { fs.rmdirSync(path.join(root, item.token)); } catch (ignored) {}
        delete accessed[item.token]; delete handoffs[item.token];
      }
    });
    Object.keys(accessed).forEach(function (token) {
      if (!protectedToken(token) && !entries.some(function (entry) { return entry.token === token; })) delete accessed[token];
    });
    snapshot = { bytes: bytes, files: files, protected_files: entries.filter(function (item) { return protectedToken(item.token); }).length,
      max_bytes: maxBytes, reserved_bytes: reserved, ttl_seconds: ttl / 1000, scan_ok: scanOK, last_error: lastError };
    return snapshot;
  }
  function protect(token) {
    if (!TOKEN.test(token)) throw new Error('invalid media cache token');
    locks[token] = (locks[token] || 0) + 1;
    var released = false;
    return function () {
      if (released) return;
      released = true;
      if (--locks[token] <= 0) delete locks[token];
      prune(false);
    };
  }
  function fullError() {
    var error = new Error('媒体缓存空间不足，当前播放文件已保留；请稍后重试或释放设备存储空间');
    error.code = 'MEDIA_CACHE_FULL'; error.status = 507;
    return error;
  }
  function reserve(token, size) {
    if (!locks[token]) throw new Error('download must hold a cache lease');
    var before = reservations[token] || 0;
    if (size <= before) return;
    // Check a small block before writing, including downloads of unknown size.
    reservations[token] = Math.min(maxBytes, Math.ceil(size / blockBytes) * blockBytes);
    var checked = prune(true);
    if (size > maxBytes || !checked.scan_ok || checked.bytes > maxBytes) {
      reservations[token] = before;
      prune(true);
      throw fullError();
    }
  }
  function finishDownload(token) { delete reservations[token]; }
  function updateSession(body) {
    body = body || {};
    if (body.action === 'open') {
      if (playing) touch(playing);
      session = crypto.randomBytes(16).toString('hex'); revision = -1; playing = '';
      prune(true);
      return { session: session, accepted: true };
    }
    if (!session || body.session !== session) return { accepted: false };
    if (body.action === 'close') { if (playing) touch(playing); session = ''; playing = ''; prune(true); return { accepted: true }; }
    var token = String(body.token || ''), seq = Number(body.revision);
    if (body.action !== 'update' || token && !TOKEN.test(token) || !isFinite(seq) || Math.floor(seq) !== seq || seq < 0) {
      var error = new Error('媒体缓存会话参数无效'); error.status = 400; error.code = 'CACHE_SESSION_INVALID'; throw error;
    }
    if (seq <= revision) return { accepted: false };
    if (playing && playing !== token) touch(playing);
    revision = seq; playing = token;
    if (token) { delete handoffs[token]; touch(token); }
    prune(true);
    return { accepted: true };
  }
  function start() {
    prune(!timer);
    if (!timer) { timer = setInterval(function () { prune(false); }, 60000); if (timer.unref) timer.unref(); }
  }
  function close() {
    if (timer) clearInterval(timer);
    if (playing) touch(playing);
    timer = null; session = ''; playing = '';
    prune(true);
  }
  return { start: start, close: close, touch: touch, prune: prune, protect: protect,
    isProtected: protectedToken, isActive: function (token) { return !!locks[token] || playing === token; }, reserve: reserve, finishDownload: finishDownload,
    updateSession: updateSession, fullError: fullError, diagnostics: function () { return Object.assign({}, prune(false)); } };
};
