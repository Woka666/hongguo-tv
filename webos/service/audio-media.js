'use strict';
var fs = require('fs');
var cancel = require('./audio-cancel');

// Export the existing decrypted AAC track only. Video bytes are never needed
// here, and this module does not resolve media URLs or own decryption keys.
var MAX_BYTES = 8 * 1024 * 1024;
var MAX_SAMPLES = 100000;
var MAX_CHUNKS = 100000;
function fail(message) { var e = new Error(message); e.code = 'WEBOS_AUDIO_FORMAT'; e.status = 422; return e; }
function boxes(data, start, end) {
  var result = [];
  for (var at = start; at < end;) {
    if (at + 8 > end) throw fail('音轨 MP4 结构不完整');
    var size = data.readUInt32BE(at), header = 8;
    if (size === 1) { if (at + 16 > end) throw fail('音轨 MP4 长度无效'); size = data.readUInt32BE(at + 8) * 4294967296 + data.readUInt32BE(at + 12); header = 16; }
    if (!size) size = end - at;
    if (!Number.isSafeInteger(size) || size < header || at + size > end) throw fail('音轨 MP4 长度无效');
    result.push({ start: at, payload: at + header, end: at + size, type: data.toString('ascii', at + 4, at + 8) }); at += size;
  }
  return result;
}
function child(data, parent, type) { return boxes(data, parent.payload, parent.end).filter(function (item) { return item.type === type; })[0]; }
function required(value) { if (!value) throw fail('音轨 MP4 缺少采样信息'); return value; }
function box(type, payload) { var b = Buffer.alloc(8 + payload.length); b.writeUInt32BE(b.length, 0); b.write(type, 4, 4, 'ascii'); payload.copy(b, 8); return b; }
function count(data, table, width) {
  if (table.payload + 8 > table.end) throw fail('音轨采样表不完整');
  var n = data.readUInt32BE(table.payload + 4);
  if (!n || n > MAX_SAMPLES || table.payload + 8 + n * width > table.end) throw fail('音轨采样表过大或不完整');
  return n;
}
function inspect(data, total) {
  var roots = boxes(data, 0, data.length), ftyp = roots.filter(function (b) { return b.type === 'ftyp'; })[0];
  var moov = required(roots.filter(function (b) { return b.type === 'moov'; })[0]);
  var children = boxes(data, moov.payload, moov.end), track, mdia;
  children.some(function (b) {
    if (b.type !== 'trak') return false;
    var m = child(data, b, 'mdia'), h = m && child(data, m, 'hdlr');
    if (h && h.payload + 12 <= h.end && data.toString('ascii', h.payload + 8, h.payload + 12) === 'soun') { track = b; mdia = m; return true; }
    return false;
  });
  required(track);
  var mdhd = required(child(data, mdia, 'mdhd')), v1 = data[mdhd.payload] === 1;
  var timeAt = mdhd.payload + (v1 ? 20 : 12), durationAt = timeAt + 4;
  if (durationAt + (v1 ? 8 : 4) > mdhd.end) throw fail('音轨时长缺失');
  var timescale = data.readUInt32BE(timeAt);
  var units = v1 ? data.readUInt32BE(durationAt) * 4294967296 + data.readUInt32BE(durationAt + 4) : data.readUInt32BE(durationAt);
  var duration = units / timescale;
  if (!timescale || !isFinite(duration) || duration <= 0 || duration > 600) throw fail('音轨时长超出处理范围');
  var minf = required(child(data, mdia, 'minf')), stbl = required(child(data, minf, 'stbl'));
  var stsd = required(child(data, stbl, 'stsd'));
  var entries = boxes(data, stsd.payload + 8, stsd.end);
  if (entries.length !== 1 || entries[0].type !== 'mp4a' || entries[0].payload + 28 > entries[0].end) throw fail('当前音轨不是受支持的 AAC');
  var channels = data.readUInt16BE(entries[0].payload + 16);
  if (channels < 1 || channels > 2) throw fail('当前音轨声道数不支持有声倍速');
  if (duration * channels * 24000 * 4 > 64 * 1024 * 1024) {
    var memoryError = fail('当前音轨超出倍速声音内存预算'); memoryError.code = 'AUDIO_MEMORY_LIMIT'; throw memoryError;
  }
  var offsets = child(data, stbl, 'stco') || required(child(data, stbl, 'co64'));
  var wide = offsets.type === 'co64', chunks = count(data, offsets, wide ? 8 : 4);
  if (chunks > MAX_CHUNKS) throw fail('音轨分块过多');
  var stsz = required(child(data, stbl, 'stsz'));
  if (stsz.payload + 12 > stsz.end) throw fail('音轨采样大小缺失');
  var fixed = data.readUInt32BE(stsz.payload + 4), samples = data.readUInt32BE(stsz.payload + 8);
  if (!samples || samples > MAX_SAMPLES || !fixed && stsz.payload + 12 + samples * 4 > stsz.end) throw fail('音轨采样数量无效');
  var stsc = required(child(data, stbl, 'stsc')), groups = count(data, stsc, 12), mapping = [];
  for (var i = 0; i < groups; i++) {
    var at = stsc.payload + 8 + i * 12;
    var first = data.readUInt32BE(at), per = data.readUInt32BE(at + 4), description = data.readUInt32BE(at + 8);
    if (!first || first > chunks || !per || description !== 1 || i === 0 && first !== 1 || i && first <= mapping[i - 1].first) throw fail('音轨分块映射无效');
    mapping.push({ first: first, count: per });
  }
  var spans = [], sample = 0, group = 0, size = 0;
  for (i = 0; i < chunks; i++) {
    while (group + 1 < mapping.length && mapping[group + 1].first <= i + 1) group++;
    var offsetAt = offsets.payload + 8 + i * (wide ? 8 : 4);
    var offset = wide ? data.readUInt32BE(offsetAt) * 4294967296 + data.readUInt32BE(offsetAt + 4) : data.readUInt32BE(offsetAt);
    var bytes = 0;
    for (var j = 0; j < mapping[group].count; j++) {
      if (sample >= samples) throw fail('音轨采样映射不一致');
      var length = fixed || data.readUInt32BE(stsz.payload + 12 + sample * 4); sample++;
      if (!length) throw fail('音轨采样大小无效'); bytes += length;
    }
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + bytes > total || size + bytes > MAX_BYTES) throw fail('音轨采样范围超限');
    spans.push({ start: offset, end: offset + bytes - 1, output: size, patch: offsetAt - track.start }); size += bytes;
  }
  if (sample !== samples) throw fail('音轨采样映射不完整');
  var mvhd = child(data, moov, 'mvhd'), trackBytes = Buffer.from(data.slice(track.start, track.end));
  var typeBytes = ftyp ? data.slice(ftyp.start, ftyp.end) : box('ftyp', Buffer.from('isom\u0000\u0000\u0002\u0000isommp42', 'binary'));
  var movieHeader = mvhd ? data.slice(mvhd.start, mvhd.end) : Buffer.alloc(0);
  var base = typeBytes.length + 8 + movieHeader.length + trackBytes.length + 8;
  spans.forEach(function (span) {
    var address = base + span.output;
    if (wide) { trackBytes.writeUInt32BE(0, span.patch); trackBytes.writeUInt32BE(address, span.patch + 4); }
    else trackBytes.writeUInt32BE(address, span.patch);
  });
  var prefix = Buffer.concat([typeBytes, box('moov', Buffer.concat([movieHeader, trackBytes]))]);
  if (prefix.length > 2 * 1024 * 1024) throw fail('音轨初始化信息过大');
  return { prefix: prefix, spans: spans, bytes: size,
    duration: duration, channels: channels, sample_rate: data.readUInt32BE(entries[0].payload + 24) >>> 16 };
}
function build(data, total, read) {
  return Promise.resolve().then(function () {
    var info = inspect(data, total), media = Buffer.alloc(info.bytes), next = 0;
    function worker() {
      if (next >= info.spans.length) return Promise.resolve();
      var span = info.spans[next++];
      return read(span.start, span.end).then(function (bytes) {
        if (!Buffer.isBuffer(bytes) || bytes.length !== span.end - span.start + 1) throw fail('音轨读取不完整');
        bytes.copy(media, span.output); return worker();
      });
    }
    var workers = [];
    for (var i = 0; i < Math.min(4, info.spans.length); i++) workers.push(worker());
    return Promise.all(workers).then(function () {
      return { body: Buffer.concat([info.prefix, box('mdat', media)]), duration: info.duration, channels: info.channels, sample_rate: info.sample_rate };
    });
  });
}
function buildBatched(data, total, read, signal) {
  return Promise.resolve().then(function () {
    cancel.check(signal);
    var info = inspect(data, total), media = Buffer.alloc(info.bytes), next = 0;
    function worker() {
      cancel.check(signal);
      if (next >= info.spans.length) return Promise.resolve();
      var group = [], bytes = 0;
      while (next < info.spans.length && group.length < 128) {
        var span = info.spans[next], size = span.end - span.start + 1;
        if (size > 512 * 1024) throw fail('音频分块过大');
        if (group.length && bytes + size > 512 * 1024) break;
        group.push(span); next++; bytes += size;
      }
      return read(group, signal).then(function (parts) {
        cancel.check(signal);
        if (!Array.isArray(parts) || parts.length !== group.length) throw fail('音轨读取不完整');
        parts.forEach(function (part, index) {
          var span = group[index];
          if (!Buffer.isBuffer(part) || part.length !== span.end - span.start + 1) throw fail('音轨读取不完整');
          part.copy(media, span.output);
        });
        return worker();
      });
    }
    return Promise.all([Promise.resolve().then(worker), Promise.resolve().then(worker)]).then(function () {
      cancel.check(signal);
      return { body: Buffer.concat([info.prefix, box('mdat', media)]), duration: info.duration, channels: info.channels, sample_rate: info.sample_rate };
    });
  });
}
function fromFile(file, signal) {
  var fd;
  return Promise.resolve().then(function () {
    fd = fs.openSync(file, 'r');
    cancel.check(signal);
    var total = fs.fstatSync(fd).size, selected = [], moov = false;
    if (!total || total > 512 * 1024 * 1024) throw fail('媒体文件大小无效');
    for (var at = 0; at + 8 <= total;) {
      var header = Buffer.alloc(16), read = fs.readSync(fd, header, 0, Math.min(16, total - at), at);
      if (read < 8) throw fail('媒体文件不完整');
      var size = header.readUInt32BE(0), type = header.toString('ascii', 4, 8);
      if (size === 1) { if (read < 16) throw fail('媒体文件不完整'); size = header.readUInt32BE(8) * 4294967296 + header.readUInt32BE(12); }
      if (!size) size = total - at;
      if (!Number.isSafeInteger(size) || size < 8 || at + size > total) throw fail('媒体文件结构无效');
      if (type === 'ftyp' || type === 'moov') {
        if (size > 16 * 1024 * 1024) throw fail('媒体初始化信息过大');
        var bytes = Buffer.alloc(size); if (fs.readSync(fd, bytes, 0, size, at) !== size) throw fail('媒体初始化信息不完整');
        selected.push(bytes); if (type === 'moov') moov = true;
      }
      at += size;
    }
    if (!moov) throw fail('媒体文件缺少 moov');
    return build(Buffer.concat(selected), total, function (start, end) {
      return Promise.resolve().then(function () {
        cancel.check(signal);
        return new Promise(function (resolve, reject) {
          var bytes = Buffer.alloc(end - start + 1);
          fs.read(fd, bytes, 0, bytes.length, start, function (error, count) {
            if (error) reject(error);
            else if (count !== bytes.length) reject(fail('音轨读取不完整'));
            else resolve(bytes);
          });
        });
      });
    });
  }).then(function (result) { if (fd !== undefined) fs.closeSync(fd); return result; }, function (error) { if (fd !== undefined) fs.closeSync(fd); throw error; });
}
module.exports = { inspect: inspect, build: build, buildBatched: buildBatched, fromFile: fromFile, maxBytes: MAX_BYTES };
