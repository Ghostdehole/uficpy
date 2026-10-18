# 与桌面 scrcpy 的功能对照

uficpy 使用官方 scrcpy 的 Android 服务端，观看和操作界面运行在浏览器中。两者共享采集与控制协议，但桌面客户端的播放器、录制器、USB 驱动和窗口功能不会随着 JAR 一起获得。

以下对照以 [scrcpy 5.0.1](https://github.com/Genymobile/scrcpy/tree/v5.0.1) 和本分支的 **uficpy 2.3.0** 为准。2.3.0 尚待审阅发布，新增功能的自动测试不代替 Android 真机测试。

## 已实现

| 功能 | uficpy 的范围 |
| --- | --- |
| 屏幕投屏 | H.264；WebCodecs、MSE、ManagedMediaSource；多个浏览器共用采集进程 |
| 画质参数 | 原生尺寸或缩放、帧率上限、码率、H.264 编码器与编码器选项、裁剪、采集方向、已有显示屏选择 |
| 播放参数 | 浏览器解码偏好、缓存、追赶阈值；硬件解码偏好不保证硬件解码一定可用 |
| 输入 | 多指触控、鼠标滚轮、常用键盘按键、导航键、文字粘贴；断线或失焦释放输入 |
| 剪贴板 | 手动读取 Android 剪贴板、设置和粘贴文本；系统剪贴板接口不可用时通过页面文本框交换 |
| 屏幕与面板 | 临时关闭或开启物理屏幕、请求横竖屏切换、打开通知栏或快捷设置、收起面板 |
| 应用启动 | 按完整包名启动；不提供强制停止后启动或按应用名称模糊匹配 |
| APK 安装 | 选择或拖放单个 APK，确认后上传并安装；允许更新并保留应用数据，错误时不自动卸载 |
| 文件传输 | 普通文件上传到 `/sdcard/Download/uficpy/`；单个文件最多 512 MiB |
| 录制 | 原 H.264 码流封装为 fMP4，不再次编码；不含音轨，单次最多 128 MiB 或 30 分钟 |
| 音频 | 可选设备输出或麦克风；Android 11+，48 kHz 双声道 PCM；默认关闭，浏览器手动启声 |
| 本地显示 | 全屏、截图；实际全屏行为由浏览器决定 |
| 访问与管理 | 访问令牌、只读模式、HTTPS、按键白名单、可选危险按键；安装、更新、自启、卸载与备用下载源 |

### 使用时的区别

- **剪贴板**：桌面 scrcpy 可以自动同步设备剪贴板，uficpy 采用手动交换。普通 HTTP 页面或浏览器权限可能限制读取、写入观看端的系统剪贴板；页面文本框仍可使用。若 Android 返回空内容或拒绝读取，也可能在等待后显示超时。
- **屏幕电源**：关闭的是物理屏幕，不是发送锁屏按键。最后一个观看连接结束或采集停止时，会尝试恢复由本次采集关闭的屏幕；设备掉电或控制连接已不可用时无法保证恢复，可用设备实体电源键唤醒。
- **旋转与应用启动**：发送请求后，实际结果取决于 Android 和应用。固定方向的应用可能拒绝旋转；包名不存在或应用无法启动时，请检查设备状态与后端日志。
- **录制**：等待首个关键帧后开始。到达容量或时间限制、视频参数改变或连接中断时结束这一段，已有片段可下载；不会把不同分辨率的流直接拼接。普通画面内容变化不影响录制。
- **音频**：Android 11 在启动时需要解锁；设备或固件不支持时，视频和控制仍继续。`output` 通常停止设备本地播放，`mic` 采集 Android 设备麦克风。浏览器音量不触发 Android 音量键。音频和视频独立缓冲，目前没有音画同步调节。
- **安装**：当前不解析 `.apks`、`.xapk`、`.apkm` 或拆分 APK 集合。APK 是否可安装由 Android 包管理器判断，uficpy 不绕过签名、版本及兼容性检查。

## 尚未实现

这些功能可以继续适配，但当前界面或配置没有提供完整链路，不能仅修改 scrcpy 启动参数就视为已支持。

| 官方功能 | 当前缺少的部分 |
| --- | --- |
| H.265、AV1、VP8、VP9 | 对应浏览器解码与封装、兼容性协商；目前固定 H.264 |
| 其他音频格式与来源 | Opus、AAC、FLAC、音频复制、更多麦克风处理模式、音频独立模式 |
| 音视频录制 | 音轨封装、录制音视频同步、MKV及其他录音容器；当前只有无音轨 MP4 |
| 虚拟显示与随窗口缩放 | 创建、尺寸变化、应用迁移和销毁的完整生命周期；现有 display_id 只选择已有显示屏 |
| 相机投屏 | 相机选择、尺寸/帧率、灯光、变焦、高速采集及对应控制界面 |
| UHID 键盘、鼠标与手柄 | HID 报告、设备状态、客户端隔离及断线销毁；当前是 Android API 级输入 |
| 完整桌面输入行为 | 所有键盘布局与组合键、鼠标悬停和侧键映射、鼠标模拟捏合、手柄映射 |
| 自动剪贴板同步 | 自动监听并写入观看端系统剪贴板；目前手动读取与发送 |
| 其他采集与设备选项 | 无视频控制模式、纯音频模式、会话期间保持唤醒/触点显示、任意角度变换等 |

## 不直接适用于网页客户端

| 桌面功能 | 原因 |
| --- | --- |
| AOA / OTG | 依赖电脑与 Android 之间的直接 USB 通道，不走现有网络后端；官方 OTG 模式本身也没有视频和音频 |
| Linux V4L2 虚拟摄像头 | 需要观看端电脑的 v4l2loopback 内核驱动和设备节点，网页不能自行创建系统摄像头 |
| SDL / 原生窗口选项 | 置顶、无边框、桌面窗口位置和系统快捷键捕获受浏览器及操作系统限制 |
| 指定 VA-API / D3D11VA / VideoToolbox | 属于桌面解码器的选项；浏览器决定使用哪种系统解码接口 |
| ADB 设备选择与隧道 | uficpy 已运行在目标 Android 设备上，浏览器通过设备地址连接；不要求在观看端安装 ADB |

## 官方文档

- [视频、编码和方向](https://github.com/Genymobile/scrcpy/blob/v5.0.1/doc/video.md)
- [控制、剪贴板与文件拖放](https://github.com/Genymobile/scrcpy/blob/v5.0.1/doc/control.md)
- [设备电源与应用启动](https://github.com/Genymobile/scrcpy/blob/v5.0.1/doc/device.md)
- [音频](https://github.com/Genymobile/scrcpy/blob/v5.0.1/doc/audio.md) · [录制](https://github.com/Genymobile/scrcpy/blob/v5.0.1/doc/recording.md)
- [虚拟显示](https://github.com/Genymobile/scrcpy/blob/v5.0.1/doc/virtual-display.md) · [相机](https://github.com/Genymobile/scrcpy/blob/v5.0.1/doc/camera.md)
- [键盘](https://github.com/Genymobile/scrcpy/blob/v5.0.1/doc/keyboard.md) · [鼠标](https://github.com/Genymobile/scrcpy/blob/v5.0.1/doc/mouse.md) · [手柄](https://github.com/Genymobile/scrcpy/blob/v5.0.1/doc/gamepad.md)
- [OTG](https://github.com/Genymobile/scrcpy/blob/v5.0.1/doc/otg.md) · [V4L2](https://github.com/Genymobile/scrcpy/blob/v5.0.1/doc/v4l2.md)

剪贴板读取在 5 秒内没有回复时，会重建共享采集连接，避免迟到内容发送给另一位观看者。画面会短暂重连，正在录制的片段会结束并保留下载入口。
