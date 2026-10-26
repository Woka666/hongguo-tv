(function (root, document) {
  'use strict';

  // webOS uses the same HTML5 media path as the desktop player. Keep one
  // muted, off-screen video warming the next local proxy URL. On adoption,
  // its buffered state is retained and the old element's listeners forward
  // the media lifecycle to the shared UI.
  function create() {
    var entries = Object.create(null);
    var forwardedEvents = ['abort', 'canplay', 'durationchange', 'emptied', 'ended', 'error', 'loadeddata',
      'loadedmetadata', 'pause', 'playing', 'progress', 'ratechange', 'seeking', 'seeked', 'stalled',
      'suspend', 'timeupdate', 'volumechange', 'waiting'];

    function localPath(path) { return typeof path === 'string' && path.indexOf('/minireel-proxy/media/') === 0; }
    function removeEntry(path, entry) {
      if (entries[path] !== entry) return;
      delete entries[path];
      clearTimeout(entry.timer);
      try { entry.video.pause(); entry.video.removeAttribute('src'); entry.video.load(); entry.video.remove(); } catch (ignored) {}
    }
    function prepare(path, signal) {
      if (!localPath(path) || !document || !document.createElement) return Promise.resolve(null);
      var previous = entries[path];
      if (previous) return Promise.resolve(previous);
      var video = document.createElement('video');
      video.muted = true;
      video.autoplay = false;
      video.playsInline = true;
      video.preload = 'auto';
      video.crossOrigin = 'anonymous';
      video.className = 'hero-video webos-preloaded-video';
      video.style.cssText = 'position:fixed;left:-8px;top:-8px;width:2px;height:2px;opacity:0;pointer-events:none;z-index:-1;';
      var entry = { path: path, video: video, adopted: false, abort: null, signal: signal || null, timer: 0 };
      entries[path] = entry;
      entry.abort = function () { removeEntry(path, entry); };
      if (signal) {
        if (signal.aborted) { entry.abort(); return Promise.resolve(null); }
        signal.addEventListener('abort', entry.abort, { once: true });
      }
      video.addEventListener('error', function () {
        if (!entry.adopted) removeEntry(path, entry);
      });
      document.body.appendChild(video);
      video.src = path;
      video.load();
      // Do not keep speculative media elements forever if the user leaves the
      // player without selecting the next episode.
      entry.timer = setTimeout(function () { if (!entry.adopted) removeEntry(path, entry); }, 10 * 60 * 1000);
      return Promise.resolve(entry);
    }
    function adopt(path, current) {
      var entry = entries[path];
      if (!entry || entry.adopted || !entry.video || !current || !current.parentNode) return current;
      entry.adopted = true;
      clearTimeout(entry.timer);
      delete entries[path];
      if (entry.abort && entry.signal) entry.signal.removeEventListener('abort', entry.abort);
      var next = entry.video;
      next.muted = false;
      next.autoplay = false;
      next.__hongguoWebOSPrefetched = true;
      next.className = current.className;
      next.id = current.id;
      next.style.cssText = current.style.cssText;
      // The application registered its handlers on the original element. The
      // forwarding bridge lets those handlers observe the adopted element
      // while their shared `media` reference is updated by app.js.
      forwardedEvents.forEach(function (name) {
        next.addEventListener(name, function () {
          var event;
          try { event = new Event(name); } catch (ignored) { event = document.createEvent('Event'); event.initEvent(name, false, false); }
          current.dispatchEvent(event);
        });
      });
      current.parentNode.replaceChild(next, current);
      return next;
    }
    function drop(path) {
      var entry = entries[path];
      if (entry) removeEntry(path, entry);
    }
    return { prepare: prepare, adopt: adopt, drop: drop };
  }

  root.HongguoWebOSMediaPrefetch = create();
})(typeof window !== 'undefined' ? window : globalThis, typeof document !== 'undefined' ? document : null);
