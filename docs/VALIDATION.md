# 测试

测试环境需要 Go 1.27、Node.js 24、Python 3、FFmpeg 和 Chrome。

```sh
npm ci
npx playwright install --with-deps chrome
sh scripts/test.sh
```

## 覆盖范围

- Go：配置、HTTP / WebSocket、权限、触点隔离、按键释放、采集进程、TLS 和并发竞态。
- JavaScript：视频封装、控制报文、输入状态和浏览器存储。
- Python：安装、回滚、卸载、服务进程和发布包。
- Chrome：MSE / WebCodecs 播放、多客户端、触控、滚轮、键盘、文字粘贴，以及插件弹窗、配置操作和备用下载源。

媒体测试比较原始 H.264 与 fMP4 解码后的帧哈希，检查封装过程是否改变画面。浏览器测试使用真实 Go 服务和模拟采集进程，不依赖 Android 设备。

服务进程测试需要 Linux `/proc` 访问权限；受限环境会跳过对应测试。可以通过 `GO` 指定 Go 可执行文件，通过 `UFICPY_CHROME` 指定 Chrome 路径。

`UFICPY_UFI_UTILS` 和 `UFICPY_UFI_REQUESTS` 可分别指向 UFI-TOOLS 的 `utils.js` 和 `requests.js`，用于宿主接口兼容性测试。`UFICPY_UFI_MAIN` 可指向宿主 `main.js`，验证版本化文件仍按固定插件标识覆盖更新。

## 设备测试

自动测试不能覆盖 Android 固件、MediaCodec 编码器和 iPhone Safari 的全部差异。设备上需检查画面、控制、重连、自启、空闲停止采集，以及长时间运行的温度和耗电。

FPS、缓存和 RTT 各自反映局部状态，不能直接作为画面端到端延迟。音量键测试有恢复出厂风险，不包含在自动测试中。
