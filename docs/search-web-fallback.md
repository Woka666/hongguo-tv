# 官网 JSON 搜索备用

针对公开下载仓库 Issue #52：首次搜索所需的 App 设备注册连接失败时，
原实现提前返回，进入不到后面的 Web 备用逻辑。

## 接口与来源

共享 Go 核心仍优先使用已注册设备的 App 搜索。首屏的注册或 App 请求失败时，
独立请求 `GET https://hongguoduanju.com/api/search/result?query=关键词`。
第二页起加 `&page=N`。不发送账号 Cookie、Token、设备身份或 App 签名，
不再从搜索 HTML 提取 `_ROUTER_DATA`，也不把联想建议当作完整搜索结果。
联想接口和输入焦点代码保持原样。

官网响应包含 `searchList`、`pageNum`、`totalPages`、`hasMore`，
`totalCount` 在实测中是字符串。只将有合法剧集 ID 的 `video_data` 转为剧集卡片，
保留 19 位字符串 ID，过滤演员/关键词条目和单页重复结果。

返回 `source=web` 后，已有分页器会继续携带此来源。
Web 的 `next_offset` 表示已读页数：首屏返回 1，下一次 `offset=1` 请求第 2 页。
App 则继续使用自己的 `next_offset/search_id/passback`。
一个结果集的后续页不会自动切换来源；翻页失败保留已加载卡片，重试同一页。
更换关键词会清空原来源和游标。账号代次改变仍会拒绝旧结果。

## 连接与错误

官网 JSON 搜索单独克隆 HTTP transport，使用独立的 HTTP/1.1 连接。
此设置不修改共享客户端，不影响 App、联想或媒体请求，也不降低 TLS 证书校验。
这是针对实测中默认传输的续页超时采取的局部策略，不能证明所有超时均由 HTTP/2 引起。

整个备用请求最多 12 秒，每次尝试最多 5 秒。
仅网络/读取失败及 HTTP 5xx 最多重试一次，间隔 200ms；用户取消立即停止。
403 `search_verification_required` 明确提示需要图形验证，不自动处理验证，
也不把验证页、HTML、错误 JSON 或错误页码当成“没有结果”。
注册和官网同时失败时，保留两条失败原因；不再误报为需要登录的 HTTP 401。

## 验证（2026-10-25）

- 官网当前前端 `static/js/async/t.d1c39a18e1.js` 的 `dH` 模块使用上述 JSON 接口。
- 匿名请求“万妖”第 1、2 页均 HTTP 200，各 10 条、ID 无重叠。
- 最终 Go 搜索入口测试：模拟 `log.snssdk.com` DNS 连接失败，
  通过 `/api/v1/lists/search` 读取官网真实两页；各 10 条新剧集，注册仅调用一次。
- 隔离回归覆盖首屏回退、来源固定、同页重试、空列表、ID 精度、账号切换、取消、
  HTTP 5xx、HTML、错误 JSON、错误页码、403 验证及客户端传输/账号 Cookie 隔离。
- 前端分页回归覆盖失败续页保留卡片、携带 Web 来源重试、更换关键词清空游标。

真实接口探针需要显式启用（只发匿名 GET，不使用生产账号或发送短信）：

```sh
HONGGUO_LIVE_WEB_SEARCH=1 go test ./core/cmd/hongguotv \
  -run '^TestLiveWebSearchJSONPagination$' -count=1 -v -timeout 40s
```

官网在本次重复探测中也发生过超时，不能把一次成功作为持续可用保证。
当前证据是共用 Go 核心和官网接口验证，尚非 Issue #52 用户机器上的 AppImage 实测。
