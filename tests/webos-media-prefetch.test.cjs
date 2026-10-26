'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

function makeDOM() {
  const body = {
    children: [],
    appendChild(node) { node.parentNode = this; this.children.push(node); return node; },
    replaceChild(next, current) {
      const index = this.children.indexOf(current);
      assert.notEqual(index, -1);
      this.children[index] = next;
      next.parentNode = this;
      current.parentNode = null;
      return current;
    }
  };
  function video() {
    const listeners = Object.create(null);
    return {
      nodeName: 'VIDEO', className: '', id: '', style: { cssText: '' }, parentNode: null,
      muted: false, autoplay: false, playsInline: false, preload: '', crossOrigin: '', src: '',
      addEventListener(name, handler) { (listeners[name] || (listeners[name] = [])).push(handler); },
      dispatch(name) { (listeners[name] || []).slice().forEach((handler) => handler({ type: name, target: this })); },
      dispatchEvent(event) { this.dispatch(event.type); return true; },
      pause() { this.paused = true; },
      removeAttribute(name) { if (name === 'src') this.src = ''; },
      load() { this.loadCount = (this.loadCount || 0) + 1; },
      remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((item) => item !== this); this.parentNode = null; }
    };
  }
  return { body, video };
}

function loadModule() {
  const dom = makeDOM();
  const context = {
    document: { body: dom.body, createElement: () => dom.video() },
    setTimeout,
    clearTimeout,
    Event: function Event(type) { this.type = type; },
    globalThis: null
  };
  context.globalThis = context;
  context.window = context;
  vm.runInNewContext(fs.readFileSync('core/cmd/hongguotv/ui/webos-media-prefetch.js', 'utf8'), context, { filename: 'webos-media-prefetch.js' });
  return { api: context.HongguoWebOSMediaPrefetch, dom };
}

test('webOS media prefetch adopts the warmed video without resetting it', async () => {
  const { api, dom } = loadModule();
  const current = dom.video();
  current.id = 'hero-video';
  current.className = 'hero-video has-source';
  dom.body.appendChild(current);
  let forwarded = 0;
  current.addEventListener('playing', () => { forwarded += 1; });

  const entry = await api.prepare('/minireel-proxy/media/abc.mp4');
  assert.equal(entry.video.src, '/minireel-proxy/media/abc.mp4');
  assert.equal(entry.video.preload, 'auto');
  const adopted = api.adopt('/minireel-proxy/media/abc.mp4', current);

  assert.equal(adopted.id, 'hero-video');
  assert.equal(adopted.__hongguoWebOSPrefetched, true);
  assert.equal(adopted.src, '/minireel-proxy/media/abc.mp4');
  assert.equal(dom.body.children[0], adopted);
  adopted.dispatch('playing');
  assert.equal(forwarded, 1);
  assert.equal(adopted.loadCount, 1, 'adoption itself must not call load again');
});

test('failed speculative media is removed from the hidden pool', async () => {
  const { api, dom } = loadModule();
  const entry = await api.prepare('/minireel-proxy/media/def.mp4');
  assert.equal(dom.body.children.length, 1);
  entry.video.dispatch('error');
  assert.equal(dom.body.children.length, 0);
  assert.equal(entry.video.src, '');
});
