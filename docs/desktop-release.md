红果短剧桌面版 0.2.116（macOS / Windows）

- 修复首次设备注册或 App 搜索失败后无法继续搜索的问题：现在会尝试官网免登录 JSON 搜索，并支持连续翻页（Issue #52）。
- 翻页固定数据来源，失败保留已加载结果并重试同一页；官网网络或 HTTP 5xx 错误最多重试一次，验证要求和无效响应明确报错。联想建议、输入焦点和播放器逻辑保持原样。

macOS 通用 ZIP 支持 Intel / Apple Silicon，最低 macOS 11；Windows x64 需要 Microsoft Edge WebView2 Runtime。Windows 播放 HEVC 还需要安装 HEVC Video Extensions；商店无法获取时，可参考 https://github.com/Ayx03/HEVCVideoExtension。Linux x86_64 AppImage 测试版在独立的 `linux-v0.2.116-test.1` 预发行版中提供，依赖系统 WebKitGTK 和 GStreamer。
通过设置检查更新并下载 ZIP，退出后手动替换完整程序。账号及本地记录保存在独立用户目录。
未做 Apple 公证或 Windows 代码签名。Windows 实体播放仍待实测。
