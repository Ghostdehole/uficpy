# 2.2.0 审查与验证

日期：2026-10-11。环境：Linux、Go 1.27.2、Chrome Headless Shell 155.0.8059.39、Playwright 1.62.1。

## 逐文件覆盖

| 文件范围 | 检查内容 |
| --- | --- |
| 全部 Go 源码及测试、config.json | 采集协议、配置、权限、并发、输入释放、TLS、显示恢复、HTTP/WebSocket |
| web/ 全部文件 | 播放链路、画面封装、控制报文、存储受限、桌面及窄屏布局 |
| uficpy_plugin.js、tests/plugin.cjs | 原始宿主工具规范、登录、Root 超时、弹窗、分层设置、音量确认、原子写入自启脚本 |
| 全部 Shell、scripts/、Python 测试、两份工作流 | 安装/回滚/卸载、证书保留、发布触发、核心校验及完整归档 |
| Node/浏览器测试及媒体夹具 | JSON 错误、控制状态、媒体逐帧一致、真实浏览器链路 |
| 版本、依赖、锁定文件、repo.json、文档及许可证 | 版本一致、有效源地址、摘要、说明与实现对应、署名完整 |

JAR 按官方资产 SHA-256 核验，并审查锁定的上游协议源码；没有把二进制逐字节浏览称作源码审查。保留运行、构建、验证与署名所需文件；删除重复路线图及未被 CI 发现的旧服务测试。

## 验证通过

- Go 测试与竞态检测、`go vet`；包括多客户端触点隔离、10 点上限、按键持有、短写失败、音量开关与只读权限、绝对 TLS 路径及真实证书加载。
- 15 项 JavaScript/媒体测试通过；fMP4 与原始 H.264 经 FFmpeg 解码后，30 帧像素哈希一致，封装不重新压缩画面。
- 13 项 Python 测试通过：7 项安装、2 项插件源、4 项发布测试。服务生命周期测试类因本环境不允许读取跨进程 `/proc/PID/exe` 明确跳过，保留在 Linux CI 运行。
- Chrome + 真实 Go HTTP/WebSocket + 模拟采集：MSE、WebCodecs、晚加入、真实浏览器双指事件及独立后端 ID、滚轮、键盘失焦释放、中文粘贴、深层音量解锁和复锁；关闭全部页面后停止采集，无未捕获脚本错误。
- 原始用户 `utils.js` 兼容测试：登录前无 Root 查询、JSON/URL/导入错误、存储受限、弹窗关闭、危险配置取消无写入、确认后单次保存、关闭无需短语、安装分段不超过 90 秒。
- 使用官方 `runShellWithRoot` 函数，在 Chrome 以空响应复现 JSON 错误传播；没有据此认定用户原始故障原因。自启脚本测试实际执行生成的 Shell，确认失败不截断原文件且保留其他插件内容与权限。
- ARM64 静态编译、Release 摘要/大小、归档完整性及实际插件归档校验规则；有效包被接受，路径穿越与符号链接被拒绝。
- 工作流 YAML、Shell 语法、Python 编译、桌面及 390px 手机宽度布局检查。

配套官方 scrcpy **5.0.1**：`764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536`。工作流检查 latest；核心协议变化时停止发布，避免只换 JAR 造成损坏。

## 尚未验证

- 用户尚未创建 GitHub 仓库，未在目标仓库运行 Actions、发布 Release 或从该 Release 安装到设备。
- Root 接口和 Android 安装路径在隔离环境中模拟；没有验证用户设备 SELinux、app_process、编码器或特殊音量键行为。
- iPhone Safari 真机、实际硬解、长时间温度/耗电未测试；iOS pattern 报错仅作为错误输入回归，未复现原始触发条件。
- 测试素材不等于 Android 真机视频；FPS、缓存和 RTT 不等于端到端画面延迟。没有虚构性能提升百分比。
- 音频、HEVC/AV1、HDR、WebRTC、录屏尚未实现；高码率 H.264 也不等于数学无损。

## 首次设备验收

按 [发布指南](GITHUB_SETUP.md) 上传项目并完成第一次 Build and Release，再导入插件、安装后端。先验证画面、触控、文字、重连和自启；然后按设备能力调整画质，并检查关闭所有页面后停止采集。音量功能仅在确认固件行为后单独验证，不列入默认安装自动执行内容。

## 官方资料

- [scrcpy Releases](https://github.com/Genymobile/scrcpy/releases)、[视频](https://github.com/Genymobile/scrcpy/blob/master/doc/video.md)、[控制](https://github.com/Genymobile/scrcpy/blob/master/doc/control.md)
- [WebKit Safari 17.1 ManagedMediaSource](https://webkit.org/blog/14735/webkit-features-in-safari-17-1/)
- [WebCodecs 规范](https://w3c.github.io/webcodecs/)
- UFI-TOOLS 规范与接口来源见 [兼容性说明](UFI_COMPATIBILITY.md)。
