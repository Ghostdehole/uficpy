# uficpy 2.2

在浏览器中查看和控制 Android 设备，配套 UFI-TOOLS 管理插件。后端面向 **Android ARM64 + Root**；播放器随程序内置，设备上不需要 Node.js、FFmpeg 或网络 ADB。

## 首次发布与安装

1. 创建公开仓库 `Ghostdehole/uficpy`，将解压后 `uficpy/` 内的全部内容上传到仓库根目录，包含 `.github/`。不要只上传 ZIP，也不要多套一层目录。
2. 推送到 `main` 后，Actions 的 **Build and Release** 自动测试、编译并发布；也可手动运行，`scrcpy_version` 保持 `latest`。
3. 首次 Release 成功后，在 UFI-TOOLS 导入 `uficpy_plugin.js`，登录并开启高级功能。
4. 展开 **管理与诊断 → 服务管理 → 安装 / 更新**。插件校验下载包后自动安装并启动。

首次创建仓库、插件商店源及离线部署详见 [发布指南](docs/GITHUB_SETUP.md)。仓库未创建或没有成功发布时，在线安装不可用；本压缩包是完整源码，不是可直接在 Android 执行的程序。

## 功能

- **画面**：H.264、WebCodecs / MSE / ManagedMediaSource、自动重连、全屏、PNG 截图。
- **控制**：最多 10 个触点、鼠标滚轮、常用键盘按键、导航与文字粘贴；失焦和断线释放触点、按键。
- **画质**：原生尺寸、不限帧率、码率、编码器、MediaCodec 参数、裁剪、显示屏及方向可调。
- **播放**：目标缓存、追赶阈值、解码队列、硬件偏好独立设置；诊断信息按需展开。
- **部署**：自动安装、更新、卸载，自启管理；表单和完整 JSON 编辑、导入、导出。
- **维护**：配置校验、设备能力、日志、显示参数恢复、只读与控制白名单。

Go 只转发编码数据，多页面共享采集；无人观看时停止采集。默认不允许编码失败时自动降低分辨率。参数范围、预设及控制行为见 [配置说明](docs/CONFIGURATION.md)。

### 音量键

音量加、音量减、静音均保留。入口为 **管理与诊断 → 高级 JSON → 危险功能**，开启时必须阅读警告并手动输入确认短语。播放器另有会话确认，普通工具栏和键盘快捷键不触发这些按键。

**部分 UFI 固件可能将音量键映射为恢复出厂设置，造成数据丢失。** 没有可靠的完整机型名单；确认设备行为后再开启。后端仍执行 `allow_volume_keys` 权限校验，关闭时拒绝音量命令。

## 更新、卸载与显示设置

- 更新默认保留配置及 token，旧代码整体移到备份目录。全新安装重置配置，但保留项目已有的显示恢复备份及 `certs/` 证书目录。
- 安装先预检再替换。新服务启动失败会保留现场并恢复旧目录，不自动运行旧脚本。
- 卸载清理后端、旧备份、本插件自启行，并恢复已备份的显示参数。移除管理插件请用 UFI-TOOLS 插件管理。
- 系统分辨率 / DPI 仅在点击“应用系统显示”后修改；编码尺寸不会改变 Android 全系统显示设置。

## 构建与验证

需要 Go（工作流使用 1.27.x）、Node.js 24、Python 3、FFmpeg、Chrome：

```sh
npm ci
npx playwright install --with-deps chrome
python3 scripts/sync_core.py --version latest
sh build.sh
```

输出在 `dist/`，包括 ARM64 运行包、源码快照、插件、插件源和校验清单。只跑测试：`sh scripts/test.sh`。本地 `-local` 标签不表示线上已有相应 Release。

工作流自动检查官方最新稳定 scrcpy，核对资产摘要及已审查的协议文件；上游协议变化时停止发布，待适配后再更新。当前配套核心 **5.0.1**。

## 能力与验证范围

画质、帧率、码率和硬解受设备及浏览器限制；高码率 H.264 仍为有损编码。音频、HEVC / AV1、HDR、WebRTC 和录屏链路尚未实现，不能仅替换 JAR 获得这些能力。WebCodecs 需要安全上下文；局域网 HTTP 使用 MSE / ManagedMediaSource。iPhone 和 Android 真机验收情况见 [验证记录](docs/VALIDATION.md)。

接口报错排查见 [UFI 兼容性说明](docs/UFI_COMPATIBILITY.md)，访问控制见 [安全说明](docs/SECURITY.md)，第三方署名见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
