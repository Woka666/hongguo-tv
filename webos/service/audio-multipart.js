'use strict';
function bad(code) { var e = new Error('音频分段响应无效'); e.code = code; e.status = 422; throw e; }
function parse(body, contentType, spans, total) {
  if (!Buffer.isBuffer(body) || body.length > 1024 * 1024 || !spans.length || spans.length > 128) bad('BATCH_LIMIT');
  var declared = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType || '');
  var cursor = body[0] === 13 && body[1] === 10 ? 2 : 0;
  var lineEnd = body.indexOf('\r\n', cursor);
  var first = body.toString('ascii', cursor, lineEnd < 0 ? cursor : lineEnd);
  var inferred = /^--([A-Za-z0-9_+'.,:=?()\/-]{1,70})$/.exec(first);
  var boundary = declared ? declared[1] || declared[2] : inferred && inferred[1];
  if (!boundary || boundary.length > 70) bad('BATCH_BOUNDARY');
  var marker = Buffer.from('--' + boundary), result = Object.create(null), expected = Object.create(null), count = 0;
  spans.forEach(function (span) {
    var key = span.start + '-' + span.end;
    if (expected[key]) bad('BATCH_DUPLICATE_REQUEST');
    expected[key] = true;
  });
  // Some CDN nodes mislabel multipart as video/mp4. The boundary alone is
  // never trusted: every part must match the requested offsets and object size.
  for (;;) {
    if (!body.slice(cursor, cursor + marker.length).equals(marker)) bad('BATCH_MARKER');
    cursor += marker.length;
    if (body.toString('ascii', cursor, cursor + 2) === '--') {
      cursor += 2;
      if (body.toString('ascii', cursor) === '\r\n') cursor += 2;
      if (cursor !== body.length || count !== spans.length) bad('BATCH_INCOMPLETE');
      return { parts: spans.map(function (s) { return result[s.start + '-' + s.end]; }), boundary_source: declared ? 'CONTENT_TYPE' : 'BODY_FIRST_LINE' };
    }
    if (body.toString('ascii', cursor, cursor + 2) !== '\r\n') bad('BATCH_CRLF');
    cursor += 2;
    var headerEnd = body.indexOf('\r\n\r\n', cursor);
    if (headerEnd < 0 || headerEnd - cursor > 4096) bad('BATCH_HEADERS');
    var headers = body.toString('ascii', cursor, headerEnd), pattern = /^content-range:\s*bytes\s+(\d+)-(\d+)\/(\d+)[ \t]*$/gim;
    var match = pattern.exec(headers);
    if (!match || pattern.exec(headers)) bad('BATCH_CONTENT_RANGE');
    var start = Number(match[1]), end = Number(match[2]), size = Number(match[3]), key = start + '-' + end;
    if (!expected[key] || result[key] || size !== total || end < start || end >= total) bad('BATCH_UNEXPECTED_RANGE');
    cursor = headerEnd + 4;
    var after = cursor + end - start + 1;
    if (after > body.length || body.toString('ascii', after, after + 2) !== '\r\n') bad('BATCH_TRUNCATED');
    result[key] = body.slice(cursor, after); count++; cursor = after + 2;
  }
}
module.exports = { parse: parse };
