(function (root) {
  'use strict';
  // First-party WSOLA: bounded waveform alignment around the ideal analysis
  // clock, followed by equal-gain overlap. No resampling/pitch shift for tempo.
  function create(channels, sampleRate) {
    if (!channels || channels.length < 1 || channels.length > 2 || !(sampleRate >= 8000 && sampleRate <= 96000)) throw new Error('Invalid PCM');
    var length = channels[0].length;
    for (var c = 0; c < channels.length; c++) if (channels[c].length !== length) throw new Error('Invalid channel length');
    var hop = Math.max(128, Math.round(sampleRate * .02)), search = Math.max(32, Math.round(sampleRate * .008));
    var position = 0, rate = 1, tail = null, pending = null, pendingAt = 0, emitted = 0;
    function sample(channel, index) { return index >= 0 && index < length ? channels[channel][index] : 0; }
    function score(at, stride) {
      var xy = 0, xx = 0, yy = 0;
      for (var i = 0; i < hop; i += stride) {
        for (var k = 0; k < tail.length; k++) {
          var x = tail[k][i], y = sample(k, at + i);
          xy += x * y; xx += x * x; yy += y * y;
        }
      }
      return xx * yy > 1e-16 ? xy / Math.sqrt(xx * yy) : -Math.abs(at - position) / (search + 1);
    }
    function block() {
      var at = Math.round(position), best = -Infinity;
      if (tail && rate !== 1) {
        var low = Math.max(0, at - search), high = Math.min(Math.max(0, length - hop * 2), at + search), chosen = Math.min(low, length);
        for (var candidate = low; candidate <= high; candidate += 8) {
          var value = score(candidate, 8); if (value > best) { best = value; chosen = candidate; }
        }
        low = Math.max(0, chosen - 8); high = Math.min(Math.max(0, length - hop * 2), chosen + 8); best = -Infinity;
        for (candidate = low; candidate <= high; candidate++) {
          value = score(candidate, 4); if (value > best) { best = value; at = candidate; }
        }
      }
      var output = [], nextTail = [];
      for (var c = 0; c < channels.length; c++) {
        var values = new Float32Array(hop), next = new Float32Array(hop);
        for (var i = 0; i < hop; i++) {
          var mix = i / hop;
          values[i] = tail ? tail[c][i] * (1 - mix) + sample(c, at + i) * mix : sample(c, at + i);
          next[i] = sample(c, at + hop + i);
        }
        output.push(values); nextTail.push(next);
      }
      tail = nextTail; position += hop * rate; return output;
    }
    function reset(seconds, speed) {
      if (!(speed >= .5 && speed <= 2) || !isFinite(seconds) || seconds < 0) throw new Error('Invalid tempo');
      position = Math.min(length, seconds * sampleRate); rate = speed; tail = null; pending = null; pendingAt = 0; emitted = 0;
    }
    function render(frames) {
      if (!(frames > 0 && frames <= sampleRate * 2) || Math.floor(frames) !== frames) throw new Error('Invalid output size');
      var result = [], written = 0;
      for (var c = 0; c < channels.length; c++) result.push(new Float32Array(frames));
      while (written < frames) {
        if (!pending || pendingAt >= hop) { pending = block(); pendingAt = 0; }
        var count = Math.min(frames - written, hop - pendingAt);
        for (c = 0; c < result.length; c++) result[c].set(pending[c].subarray(pendingAt, pendingAt + count), written);
        written += count; pendingAt += count;
      }
      emitted += frames;
      return { channels: result, inputPosition: (position - (pending ? hop - pendingAt : 0) * rate) / sampleRate, frames: emitted };
    }
    return { reset: reset, render: render };
  }
  root.HongguoWSOLA = { create: create };
  if (typeof module === 'object' && module.exports) module.exports = root.HongguoWSOLA;
}(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this));
