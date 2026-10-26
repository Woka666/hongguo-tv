'use strict';
var http = require('http'), https = require('https'), url = require('url');
var multipart = require('./audio-multipart'), cancel = require('./audio-cancel'), media = require('./range-media');
var httpAgent = new http.Agent({ keepAlive: true, maxSockets: 2 });
var httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 2 });
function fail(code) { var e = new Error('当前片源无法准备倍速声音'); e.code = code; e.status = 422; return e; }
function request(target, spans, source, signal, redirects) {
  return new Promise(function (resolve, reject) {
    try { cancel.check(signal); } catch (e) { reject(e); return; }
    var parsed = url.parse(target), secure = parsed.protocol === 'https:';
    if ((!secure && parsed.protocol !== 'http:') || redirects > 5) { reject(fail('AUDIO_RANGE_REDIRECT')); return; }
    var transport = secure ? https : http, req, finished = false;
    function finish(error, result) {
      if (finished) return; finished = true;
      if (signal) signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(result);
    }
    function abort() { var e = cancel.error(signal); if (req) req.destroy(e); finish(e); }
    try {
      req = transport.request({ protocol: parsed.protocol, hostname: parsed.hostname, port: parsed.port,
        path: parsed.path, method: 'GET', agent: secure ? httpsAgent : httpAgent, timeout: 12000,
        headers: { 'User-Agent': 'com.phoenix.read/73532 (Linux; U; Android 16; zh_CN; 25053RT47C)',
          Accept: '*/*', 'Accept-Encoding': 'identity', Referer: 'https://novel.snssdk.com/', Origin: 'https://novel.snssdk.com',
          'If-Range': source.etag, Range: 'bytes=' + spans.map(function (s) { return s.start + '-' + s.end; }).join(',') }
      }, function (res) {
        if (finished) { res.destroy(); return; }
        if ([301, 302, 303, 307, 308].indexOf(res.statusCode) >= 0 && res.headers.location) {
          var next = url.resolve(target, res.headers.location);
          res.destroy();
          if (secure && url.parse(next).protocol !== 'https:') { finish(fail('AUDIO_RANGE_REDIRECT')); return; }
          request(next, spans, source, signal, redirects + 1).then(function (value) { finish(null, value); }, finish); return;
        }
        if (res.statusCode !== 206 || String(res.headers.etag || '').trim() !== source.etag) {
          res.destroy(); finish(fail(res.statusCode === 206 ? 'AUDIO_SOURCE_CHANGED' : 'AUDIO_RANGE_UNSUPPORTED')); return;
        }
        var chunks = [], bytes = 0;
        res.on('data', function (b) {
          bytes += b.length;
          if (bytes > 1024 * 1024) { req.destroy(fail('AUDIO_RANGE_LIMIT')); return; }
          chunks.push(b);
        });
        res.on('error', finish); res.on('aborted', function () { finish(fail('AUDIO_RANGE_INTERRUPTED')); });
        res.on('end', function () {
          if (finished) return;
          try {
            cancel.check(signal);
            var body = Buffer.concat(chunks), parts;
            if (spans.length === 1 && res.headers['content-range']) {
              var range = media.parseContentRange(res.headers['content-range']), span = spans[0];
              if (!range || range.total !== source.length || range.start !== span.start || range.end !== span.end || body.length !== span.end - span.start + 1) throw fail('AUDIO_RANGE_MISMATCH');
              parts = [body];
            } else parts = multipart.parse(body, res.headers['content-type'], spans, source.length).parts;
            parts = parts.map(function (part, j) {
              var span = spans[j], value = Buffer.from(part), low = 0, high = source.samples.length;
              while (low < high) { var mid = Math.floor((low + high) / 2); if (source.samples[mid].offset + source.samples[mid].size <= span.start) low = mid + 1; else high = mid; }
              for (var i = low; i < source.samples.length; i++) {
                var sample = source.samples[i]; if (sample.offset > span.end) break;
                var from = Math.max(span.start, sample.offset), to = Math.min(span.end + 1, sample.offset + sample.size);
                if (from < to) media.decryptFragment(value.slice(from - span.start, to - span.start), sample, source.key, from);
              }
              return value;
            });
            finish(null, parts);
          } catch (e) { finish(e); }
        });
      });
      req.on('error', finish); req.on('timeout', function () { req.destroy(fail('AUDIO_RANGE_TIMEOUT')); });
      if (signal) { signal.addEventListener('abort', abort); if (signal.aborted) { abort(); return; } }
      req.end();
    } catch (e) { finish(e); }
  });
}
function read(source, spans, signal) {
  if (!source || !media.strongETag(source.etag) || !Array.isArray(spans) || !spans.length || spans.length > 128) return Promise.reject(fail('AUDIO_RANGE_SOURCE'));
  var bytes = 0;
  for (var i = 0; i < spans.length; i++) {
    var s = spans[i]; bytes += s.end - s.start + 1;
    if (!Number.isSafeInteger(s.start) || !Number.isSafeInteger(s.end) || s.start < 0 || s.end < s.start || s.end >= source.length || bytes > 512 * 1024) return Promise.reject(fail('AUDIO_RANGE_LIMIT'));
  }
  return request(source.url, spans, source, signal, 0);
}
module.exports = { read: read, close: function () { httpAgent.destroy(); httpsAgent.destroy(); } };
