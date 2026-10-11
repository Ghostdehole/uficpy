# uficpy

基于 scrcpy 的 Android 网页投屏，配套 UFI-TOOLS 管理插件。后端运行在 **Android ARM64 + Root** 设备上，浏览器负责播放和控制，不需要在设备上安装 Node.js、FFmpeg 或开启网络 ADB。

## 功能

- H.264 视频，支持 WebCodecs、MSE 和 ManagedMediaSource，带重连、全屏和截图。
- 多指触控、鼠标滚轮、常用键盘按键和文字粘贴；失焦或断线时释放输入。
- 可调分辨率、帧率、码率、编码器、裁剪、屏幕方向及播放缓存。
- 多页面共用采集进程，无人观看时停止采集。
- 插件管理后端更新、卸载、自启、配置和日志，支持完整 JSON 编辑与导入导出。

音量加减和静音默认关闭。**部分 UFI 固件可能将音量键映射为恢复出厂设置，造成数据丢失。** 开关位于插件的“管理与诊断 → 高级 JSON → 危险功能”；播放器还需在“设置 → 高级控制 → 危险按键”中解锁当前会话。

## 支持条件

浏览器需要支持 H.264 解码。WebCodecs 需要安全上下文，局域网 HTTP 使用 MSE / ManagedMediaSource。实际画质、帧率和硬解能力取决于设备、浏览器及网络。

目前只有视频和控制，不支持音频、HEVC / AV1、HDR、WebRTC 或录屏。H.264 为有损编码。

## 开发

构建环境：Go 1.27、Node.js 24、Python 3、FFmpeg 和 Chrome。

```sh
npm ci
npx playwright install --with-deps chrome
sh scripts/test.sh
```

`sh build.sh` 会运行测试并生成 ARM64 发布包，输出到 `dist/`。更新 scrcpy 核心使用 `python3 scripts/sync_core.py --version latest`，版本和摘要记录在 `core-lock.json`；协议检查不通过时需要先完成适配。

## 文档

- [配置](docs/CONFIGURATION.md)
- [UFI-TOOLS 兼容性与排错](docs/UFI_COMPATIBILITY.md)
- [构建与发布](docs/GITHUB_SETUP.md)
- [测试](docs/VALIDATION.md)
- [安全](docs/SECURITY.md)
- [第三方项目](THIRD_PARTY_NOTICES.md)
