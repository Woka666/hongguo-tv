红果短剧桌面版 0.2.119（macOS / Windows）

- 同步统一主线版本，更新共享播放诊断的准备耗时与读取模式显示。
- 本轮主要改进位于独立 webOS 包：下一集预取重试、过期刷新、准备任务复用及旧版 Chrome 请求兼容。

macOS 通用 ZIP 支持 Intel / Apple Silicon，最低 macOS 11；Windows x64 需要 Microsoft Edge WebView2 Runtime。Windows 播放 HEVC 还需要安装 HEVC Video Extensions；商店无法获取时，可参考 https://github.com/Ayx03/HEVCVideoExtension。Linux x86_64 AppImage 测试版在独立的 `linux-v0.2.119-test.1` 预发行版中提供，依赖系统 WebKitGTK 和 GStreamer。
通过设置检查更新并下载 ZIP，退出后手动替换完整程序。账号及本地记录保存在独立用户目录。
未做 Apple 公证或 Windows 代码签名。Windows 实体播放仍待实测。
