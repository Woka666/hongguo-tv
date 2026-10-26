# webOS 切集准备优化：#57 / #59

## 反馈与边界

- #59 在 webOS 6.5.3 / Chrome 79 测得切集约 6.9 秒，其中本机 play/info TTFB 6267ms，拿到源后约 0.5 秒 playing。这个接口内部包含上游取源、Range 初始化，必要时还包含整集回退；不能直接把整个 TTFB 归为某个上游 API 的耗时。
- #57 报告一次自动续集准备失败、其他剧可续播，以及两倍速声音问题。此次处理播放准备、预取和旧 Chrome 请求兼容；倍速音频需要单独验证。
- 当前 webOS 已优先使用 Range 按需下载、解密和回写，保留完整文件回退。没有采用 MSE、第二个 video 或下一集整集预下载。

## 本次规则

1. 共享 UI 仅在 webOS 启用预取一次重试，间隔至少 3 秒，仍需连续稳定播放条件。切剧、跳集、清晰度或账号变化、离开页面和后台沿用原有取消路径；无 AbortController 时也丢弃取消后的结果。
2. webOS 预取成功结果以完成时间计，2 分钟后拒绝直接接管。长集剩余 30 秒以内可提前刷新过期结果，与失败重试共用一次额外尝试的预算，避免整个播放过程反复取源；仍过期时由前台解析。服务端准备索引也超过 2 分钟后重新取源和校验。范围、解密索引和 ETag 校验不放宽。
3. 同一准备键在前台和预取间共用取源、Range 初始化；前台接管超过 1.2 秒后的请求也可加入该任务。失败的后台请求不会因为前台可回退而被当作整集预下载成功。
4. 只有前台在 Range 准备不兼容时才允许完整文件回退。上游 video_model 失败不启动没有播放源的整集回退。过期索引可在两个索引的预算内替换自己，并保留另一正在使用的源。
5. cache-session 的 open/update/close 不再传 keepalive，避免 Chrome 79 在跨域预检阶段拒绝。页面退出仍尽力关闭会话和服务，服务停止或新会话会清除旧的播放占用；暂停播放不会因空闲时限丢失保护。

## 可观测性

play/info 响应增加 preparation_timing 和 preparation_shared / preparation_cached。计时仅包含模式、阶段、毫秒数和回退原因，不记录视频地址、密钥、剧名或账号。

本机 player/diagnostics 提供 media_resolve_ms、media_range_init_ms、media_download_ms、media_decrypt_ms、media_preparation_stage；失败时保留 media_preparation_error_stage。最多保存 16 份小型准备报告，最近前台失败在没有媒体地址时仍可读取，后台预取不替换前台诊断。

共享诊断界面在准备中和失败后也显示已完成阶段的计时，完整文件回退时保留 Range 尝试耗时。当前源模式以已附加源或已准备媒体为依据，避免把“请求使用 Range”显示成“已经成功使用 Range”。

## 验证

- Node 行为测试：预取失败延迟重试、最多一次、暂停/后台/未稳定时不重试、成功接管、过期拒绝、切剧取消及无 AbortController 的迟到结果。
- provider 回归：前后台共用取源和在途 Range 初始化、后台失败与前台整集回退的独立策略、取源失败不下载、过期索引刷新、缓存预算与各阶段计时。
- adapter 回归：模拟不支持 keepalive 预检的浏览器，验证缓存会话与连续换源、服务重启、前后台和退出；验证本地绝对媒体地址的诊断还原。
- 独立 range-media 测试覆盖实际 HTTP Range、按需解密、拖动、断流重试和 URL 刷新。

这些验证不能替代 LG 真机上的延迟测量，也不承诺切集必定小于 1 秒。后续设备反馈应同时保留前台解析耗时、Range/完整文件模式、回退原因和实际起播耗时。

反馈链接：[issue #57](https://github.com/aston314/hongguo-tv-releases/issues/57)、[issue #59](https://github.com/aston314/hongguo-tv-releases/issues/59)。
