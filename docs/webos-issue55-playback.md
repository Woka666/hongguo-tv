# Issue #55：webOS 服务启动与播放显示修复

本次修复基于 v0.2.116。此前已发布的 IPK 不会自动获得源码修复，需在下一次发布中重新构建。

## 已确认并修复的阻断

1. **服务入口依赖 `require.main`。** 电视由 bootstrap `require()` 加载服务时，旧入口只导出工厂，没有实例化，因而未注册 `ping/getDiagnostics/shutdown`。新增独立的 `service-entry.js`，由 `package.json.main` 指向，在加载时立即创建服务。HTTP 仍在收到 ping 后启动；工厂保持可注入，HTTP 直连和测试导入不产生额外服务实例。
2. **播放源身份比较失配。** adapter 把本地媒体路径改为 Service 的绝对地址，共享页面仍比较原相对路径，导致首帧/时间进展不能解除遮罩和音频保持。新增 webOS 专用 `sameMediaSource` 比较，只将该 Service 的本地媒体路径归一。DOM 中保留真实地址，不覆盖 `getAttribute()`；不同集、不同主机及不同查询参数仍不相等。其他平台保留原来的精确字符串比较。

## 验证

- 修复前的两个回归均先复现失败：bootstrap 加载注册数为 0；已播放媒体仍保留加载层与静音。
- 修复后，package 入口在 bootstrap 环境注册三个方法；并发 ping 共用同一实例，可通过真实本地 HTTP health。
- 播放状态回归覆盖相对/绝对媒体地址、错误主机、旧集事件，以及遮罩与音频释放。Android/桌面/原生播放转换回归保持通过。
- 2026-10-25，Mac Chrome 加载由最新共享 UI 构建的 file 应用，通过独立 HTTP Service 和真实 provider 播放《灵葫仙缘：葫中藏尽世间粮》：第 1、2 集均有视频尺寸、帧数及音频解码字节增长，遮罩退出、静音解除；第二集 seek 到 30 秒、暂停和恢复均成功。未使用 Big Buck Bunny 或替代红果数据。
- 已构建本地 IPK，验证 package main、Service 工厂、应用/Service 版本和压缩后的入口内容。
- 主线 CI 新增 webOS 完整 verify；Simulator 探针新增可见性、加载层和静音证据，校验器会拒绝仅播放时钟增长的后台播放报告。

### 重新安装后的 Simulator 实测（2026-10-25）

已移除缺少 `Contents/Info.plist` 的损坏副本，从 LG 开发者网站重新下载 Simulator 1.5.0 macOS ARM64 包。安装包为 111268559 字节，SHA-256 为 `f09068359f5cbab4da6fae3faac6239da17ea63ee34560df2471e469becf1cd4`，ZIP CRC 与解压后的完整 macOS 签名均通过。新安装位于 `~/Applications/webOS-Simulator/`，不再使用 `/tmp` 中的副本。

以 `e9629a4` 修复源码生成独立 `.issue55-retry` staging，通过开发机 HTTP Service 播放与浏览器对照相同的真实剧集：

| 项目 | 结果 |
| --- | --- |
| 第 1 集 | 720×1282；2.08 → 6.08 秒；187 解码帧、182 呈现帧 |
| seek | 已完成，采样位置 17.27 秒 |
| 方向键切第 2 集 | 720×1280；2.11 → 6.10 秒；188 解码帧 |
| 呈现状态 | 两集均 `visible=true`、`loading=false`、`muted=false`，没有 MediaError |
| 音频辅助证据 | 两集音频解码字节持续增长；不等于实体扬声器验收 |

`verify_webos_simulator_playback.py` 校验为 PASS。报告保存在 `~/webos-validation-20261025-issue55-reinstalled/report.json`，同目录 `verification.json` 记录安装包与验证模式；测试包的临时服务配置没有写回正式源码。

**本轮证明 Simulator 的 HTTP 直连播放通过；Luna IPC 与 LG 真机仍未验证。** 首屏服务注册已另由 bootstrap 加载回归覆盖，但不能代替电视端 Luna 调用结果。

## 保持独立跟进

- 无强 ETag 时仍保留安全的整集回退。没有取消媒体身份校验，也没有把失败的预取自动变为整集后台下载。
- 已有整集缓存的提前复用、媒体缓存限额/清理，以及 `player/stats` 上游错误需另行处理。
- 非 1 倍速声音属于平台能力验证项，本次未更改倍速功能或宣称已解决。

8080 的旧测试目录是一份独立复制且开启测试模式的环境，不能代表当前源码或电视 Luna 验证；本次未修改该目录或停止其服务。
