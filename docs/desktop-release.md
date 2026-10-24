红果短剧桌面版 0.2.112（macOS / Windows）

- 本次桌面版随统一发布线更新；搜索页改用已注册设备调用红果 App 搜索接口，兼容新的顶层 `search_tabs` 响应，修复结果请求返回“页面缺少 `_ROUTER_DATA`”的问题。搜索联想接口和联想浮层行为保持不变。

macOS 通用 ZIP 支持 Intel / Apple Silicon，最低 macOS 11；Windows x64 需要 Microsoft Edge WebView2 Runtime。Windows 播放 HEVC 还需要安装 HEVC Video Extensions；商店无法获取时，可参考 https://github.com/Ayx03/HEVCVideoExtension。Linux x86_64 AppImage 测试版在独立的 `linux-v0.2.112-test.1` 预发行版中提供，依赖系统 WebKitGTK 和 GStreamer。
通过设置检查更新并下载 ZIP，退出后手动替换完整程序。账号及本地记录保存在独立用户目录。
未做 Apple 公证或 Windows 代码签名。Windows 实体播放仍待实测。
