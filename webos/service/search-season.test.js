'use strict';

var assert = require('assert');
var EventEmitter = require('events');
var PassThrough = require('stream').PassThrough;
var https = require('https');

var originalRequest = https.request;
var appMode = 'success';
var calls = [];

function appRows() {
  return [{
    video_data: [{ series_id: '1234567890123456789', series_title: 'App 搜索剧', episode_cnt: 12, vid: '2234567890123456789' }]
  }];
}
function webRows(title) {
  return [{ video_data: { series_id: '3234567890123456789', series_title: title, episode_cnt: 8, vid: '4234567890123456789' } }];
}
function planRows(bookID) {
  if (bookID === '1234567890123456789') {
    return [{ video_data: [{ series_id: '5234567890123456789', series_title: '第二季', episode_cnt: 10, vid: '6234567890123456789', secondary_info_list: [{ content: '第2季' }] }] }];
  }
  return [{ video_data: [
    { series_id: '1234567890123456789', series_title: '第一季', episode_cnt: 10, vid: '2234567890123456789', secondary_info_list: [{ content: '第1季' }] },
    { series_id: '5234567890123456789', series_title: '第二季', episode_cnt: 10, vid: '6234567890123456789', secondary_info_list: [{ content: '第2季' }] }
  ] }];
}

https.request = function (options) {
  var request = new EventEmitter();
  var chunks = [];
  request.write = function (chunk) { chunks.push(Buffer.from(chunk)); };
  request.destroy = function (error) { if (error) process.nextTick(function () { request.emit('error', error); }); };
  request.end = function () {
    var parsed = new URL('https://fixture.test' + options.path);
    calls.push({ path: parsed.pathname, query: parsed.searchParams, body: Buffer.concat(chunks).toString('utf8') });
    var status = 200;
    var body = '{}';
    if (parsed.pathname.indexOf('/reading/bookapi/search/tab/v') >= 0) {
      if (appMode === 'failure') status = 502;
      else body = JSON.stringify({ data: { search_tabs: [{ tab_type: 11, has_more: true, next_offset: '20', search_id: 'search-session', passback: 'page-token', data: appRows() }] } });
    } else if (parsed.pathname === '/api/search/result') {
      var page = Number(parsed.searchParams.get('page') || '1');
      body = JSON.stringify({ searchList: webRows(page === 1 ? '官网第一页' : '官网第二页'), hasMore: page === 1, pageNum: page, totalPages: 2 });
    } else if (parsed.pathname.indexOf('/reading/bookapi/plan/v') >= 0) {
      body = JSON.stringify({ code: 0, data: planRows(parsed.searchParams.get('book_id')) });
    }
    process.nextTick(function () {
      var response = new PassThrough();
      response.statusCode = status;
      response.headers = { 'content-type': 'application/json' };
      request.emit('response', response);
      response.end(body);
    });
  };
  return request;
};

var provider = require('./provider');

async function run() {
  try {
    var app = await provider.search({ q: '测试', offset: 0 });
    assert.strictEqual(app.source, 'app');
    assert.strictEqual(app.items[0].title, 'App 搜索剧');
    assert.strictEqual(app.search_id, 'search-session');
    assert.strictEqual(app.passback, 'page-token');
    var appNext = await provider.search({ q: '测试', offset: 20, source: 'app', search_id: app.search_id, passback: app.passback });
    assert.strictEqual(appNext.source, 'app');
    var appCall = calls.filter(function (call) { return call.path.indexOf('/reading/bookapi/search/tab/v') >= 0; })[1];
    assert.strictEqual(appCall.query.get('offset'), '20');
    assert.strictEqual(appCall.query.get('search_id'), 'search-session');
    assert.strictEqual(appCall.query.get('passback'), 'page-token');

    appMode = 'failure';
    var fallback = await provider.search({ q: '官网回退', offset: 0 });
    assert.strictEqual(fallback.source, 'web');
    assert.strictEqual(fallback.items[0].title, '官网第一页');
    var webNext = await provider.search({ q: '官网回退', offset: 1, source: 'web' });
    assert.strictEqual(webNext.source, 'web');
    assert.strictEqual(webNext.items[0].title, '官网第二页');
    var webCall = calls.filter(function (call) { return call.path === '/api/search/result'; })[1];
    assert.strictEqual(webCall.query.get('page'), '2');
    await assert.rejects(provider.search({ q: '缺失来源', offset: 1 }), function (error) { return error.code === 'SEARCH_SOURCE_REQUIRED'; });
    await assert.rejects(provider.search({ q: '错误来源', source: 'other' }), function (error) { return error.code === 'SEARCH_SOURCE_INVALID'; });

    var next = await provider.nextSeason('1234567890123456789');
    assert.strictEqual(next.current_season, 1);
    assert(next.next);
    assert.strictEqual(next.next.series_id, '5234567890123456789');
    var planCalls = calls.filter(function (call) { return call.path.indexOf('/reading/bookapi/plan/v') >= 0; });
    assert.strictEqual(planCalls.length, 2, 'missing current season is confirmed through a reciprocal request');
    console.log('webOS App/web search source locking and reciprocal season relation: PASS');
  } finally {
    provider.closeCache();
    https.request = originalRequest;
  }
}

run().catch(function (error) {
  https.request = originalRequest;
  console.error(error.stack || error);
  process.exitCode = 1;
});
