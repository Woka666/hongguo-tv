'use strict';
importScripts('webos-wsola.js');
var processor = null, epoch = 0, sampleRate = 0;
self.onmessage = function (event) {
  var data = event.data || {};
  try {
    if (data.type === 'load') {
      var channels = (data.channels || []).map(function (buffer) { return new Float32Array(buffer); });
      sampleRate = data.sampleRate; processor = self.HongguoWSOLA.create(channels, sampleRate); epoch = data.epoch;
      self.postMessage({ type: 'ready', epoch: epoch, sourceId: data.sourceId }); return;
    }
    if (!processor) return;
    if (data.type === 'reset') { epoch = data.epoch; processor.reset(data.position, data.rate); return; }
    if (data.type === 'render' && data.epoch === epoch) {
      var rendered = processor.render(data.frames), buffers = rendered.channels.map(function (channel) { return channel.buffer; });
      self.postMessage({ type: 'pcm', epoch: epoch, id: data.id, channels: buffers, inputPosition: rendered.inputPosition, sampleRate: sampleRate }, buffers);
    }
  } catch (error) { self.postMessage({ type: 'error', epoch: data.epoch, code: 'WSOLA_PROCESSING' }); }
};
