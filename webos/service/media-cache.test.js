'use strict';
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var createCache = require('./media-cache');
var root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-cache-policy-'));
var time = 10000000, cache, tests = 0;
var a = 'a'.repeat(24), b = 'b'.repeat(24), c = 'c'.repeat(24);
function file(token, suffix) { return path.join(root, token, token + '.mp4' + (suffix || '')); }
function put(token, size, age, suffix) {
  fs.mkdirSync(path.join(root, token), { recursive: true });
  var target = file(token, suffix); fs.writeFileSync(target, Buffer.alloc(size || 1));
  fs.utimesSync(target, new Date(time - age), new Date(time - age));
  return target;
}
function exists(token) { return fs.existsSync(file(token)); }
function setup() {
  if (cache) cache.close();
  fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(root);
  cache = createCache(root, { now: function () { return time; }, maxBytes: 100, ttl: 2000, handoffMs: 200 });
}
function test(name, run) { setup(); run(); tests++; console.log('cache: ' + name + ' PASS'); }
try {
  test('legacy files expire; unrelated data and symlinks are preserved', function () {
    put(a, 10, 3000); put(b, 20, 1000);
    fs.writeFileSync(path.join(root, 'library.json'), 'private-data');
    var outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-cache-outside-'));
    try {
      fs.writeFileSync(path.join(outside, c + '.mp4'), 'preserve');
      fs.symlinkSync(outside, path.join(root, c));
      cache.prune(true);
      assert(!exists(a)); assert(exists(b));
      assert.strictEqual(fs.readFileSync(path.join(root, 'library.json'), 'utf8'), 'private-data');
      assert.strictEqual(fs.readFileSync(path.join(outside, c + '.mp4'), 'utf8'), 'preserve');
      cache.touch(c, true);
      assert(!fs.existsSync(path.join(outside, '.access')));
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  });
  test('capacity uses LRU across old directories', function () {
    put(a, 40, 1500); put(b, 40, 1000); put(c, 40, 500);
    assert.strictEqual(cache.prune(true).bytes, 80);
    assert(!exists(a)); assert(exists(b)); assert(exists(c));
  });
  test('reads extend TTL without changing the media validator; access survives restart', function () {
    put(a, 40, 1500); var modified = fs.statSync(file(a)).mtimeMs;
    cache.touch(a); time += 1000; cache.prune(true); assert(exists(a));
    assert.strictEqual(fs.statSync(file(a)).mtimeMs, modified);
    cache.close(); cache = createCache(root, { now: function () { return time; }, maxBytes: 100, ttl: 2000 });
    cache.prune(true); assert(exists(a));
    time += 1001; cache.prune(true); assert(!exists(a));
  });
  test('paused session survives TTL and capacity cleanup; release allows eviction', function () {
    put(a, 80, 0); put(b, 30, 10);
    var session = cache.updateSession({ action: 'open' }).session;
    cache.updateSession({ action: 'update', session: session, revision: 1, token: a });
    time += 10000; cache.prune(true); assert(exists(a)); assert(!exists(b));
    cache.updateSession({ action: 'update', session: session, revision: 2, token: '' });
    // Releasing is a use, so a later switch need not re-download this episode.
    time += 2001; cache.prune(true); assert(!exists(a));
  });
  test('download and stream leases are independent and release idempotently', function () {
    var release1 = cache.protect(a), release2 = cache.protect(a);
    put(a, 60, 3000); put(a, 20, 3000, '.part');
    cache.prune(true); assert(exists(a)); assert(fs.existsSync(file(a, '.part')));
    release1(); release1(); cache.prune(true); assert(exists(a));
    release2(); cache.prune(true); assert(!exists(a)); assert(!fs.existsSync(file(a, '.part')));
  });
  test('prepared handoff protects the file until a playback session can claim it', function () {
    put(a, 60, 3000); cache.touch(a, true); time += 100;
    put(b, 60, 0); cache.prune(true); assert(exists(a)); assert(!exists(b));
    time += 2100; cache.prune(true); assert(!exists(a));
  });
  test('concurrent writes share the budget; protected files cannot be deleted to admit a download', function () {
    put(a, 60, 0); var read = cache.protect(a), writeB = cache.protect(b), writeC = cache.protect(c);
    cache.reserve(b, 25); cache.reserve(c, 15);
    assert.throws(function () { cache.reserve(c, 16); }, function (error) { return error.code === 'MEDIA_CACHE_FULL' && error.status === 507; });
    assert(exists(a)); assert.strictEqual(cache.prune(true).bytes, 100);
    cache.finishDownload(b); writeB(); cache.reserve(c, 40); assert(exists(a));
    cache.finishDownload(c); writeC(); read();
  });
  test('startup removes orphan parts of any age and safely preserves unknown files', function () {
    put(a, 20, 0, '.part'); put(b, 20, 5000, '.part');
    fs.writeFileSync(path.join(root, b, 'user-note'), 'keep');
    cache.start(); assert(!fs.existsSync(file(a, '.part'))); assert(!fs.existsSync(file(b, '.part')));
    assert(fs.existsSync(path.join(root, b, 'user-note')));
  });
  test('unreadable cache cannot be mistaken for empty capacity', function () {
    var release = cache.protect(a), original = fs.readdirSync;
    fs.readdirSync = function () { var error = new Error('denied'); error.code = 'EACCES'; throw error; };
    try { assert.throws(function () { cache.reserve(a, 1); }, function (error) { return error.code === 'MEDIA_CACHE_FULL'; }); }
    finally { fs.readdirSync = original; cache.finishDownload(a); release(); }
  });
  test('late updates and previous app sessions cannot re-pin or release the new video', function () {
    var old = cache.updateSession({ action: 'open' }).session;
    cache.updateSession({ action: 'update', session: old, revision: 2, token: a });
    assert.strictEqual(cache.updateSession({ action: 'update', session: old, revision: 1, token: b }).accepted, false);
    assert(cache.isActive(a)); assert(!cache.isActive(b));
    var next = cache.updateSession({ action: 'open' }).session;
    cache.updateSession({ action: 'update', session: next, revision: 0, token: b });
    assert.strictEqual(cache.updateSession({ action: 'close', session: old }).accepted, false);
    assert(!cache.isActive(a)); assert(cache.isActive(b));
    assert.throws(function () { cache.updateSession({ action: 'update', session: next, revision: 3, token: '../data' }); });
  });
  console.log('webOS media cache: ' + tests + ' scenarios PASS');
} finally { if (cache) cache.close(); fs.rmSync(root, { recursive: true, force: true }); }
