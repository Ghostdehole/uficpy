# 配置与约束

配置在 `/data/uficpy/config.json`。表单展示常用项；“高级 JSON”可以编辑全部支持字段及导入/导出。导出文件包含 token，请私下保存。修改需重启。未知字段报错，避免拼写错误被忽略。

| 字段 | 范围或行为 |
| --- | --- |
| max_size | 0 原生尺寸，或 128–16384；最终受设备限制 |
| max_fps | 0 不限，或 1–1000；不是实际帧率保证 |
| bit_rate | 100000–2000000000 bit/s，实际码率由编码器决定 |
| video_encoder | 空为系统选择；用“编码器 / 显示屏”查询实际 H.264 编码器 |
| video_codec_options | key[:int/long/float/string]=value，逗号分隔；必须有 max-bframes=0 |
| display_id | 非负显示屏 ID，默认 0 |
| crop | 空或 width:height:x:y |
| capture_orientation | 空、0/90/180/270 或 @ 前缀锁定；语义按配套 scrcpy |
| downsize_on_error | 默认 false；降低分辨率必须显式允许 |
| no_audio | 固定 true，没有音频链路 |
| port / listen | 1024–65535；默认 9528 / 0.0.0.0 |
| token | 64 位小写十六进制，初始化生成，更新保留 |
| tls_cert / tls_key | 证书与私钥的绝对路径，成对填写；建议放入 /data/uficpy/certs/ |
| read_only | 仅观看，后端拒绝所有控制输入 |
| allowed_keys | Android 按键白名单，决定可用按键；默认包含导航、常用键盘，更新保留用户已有白名单 |
| allow_volume_keys | 默认 false；true 时独立允许音量键，不受 allowed_keys 限制 |
| max_clients | 1–64，默认 8 |
| queue_mb | 每客户端发送队列 1–256 MiB，默认 16；不是进程总内存上限 |
| gop_mb | 1–queue_mb MiB，默认 8 |
| idle_seconds | 0–3600 秒，默认 2；停止采集后 Go 服务仍待命 |
| log_level | verbose/debug/info/warn/error |
| wm_size / wm_density | 单独应用才生效；空/0 不修改，清空不等于恢复 |

例如 `i-frame-interval=1,max-bframes=0,bitrate-mode=2` 可请求特定编码行为，但 MediaCodec 参数是否支持由设备决定。本版本没有 DTS/B 帧重排支持，因此明确拒绝非零 max-bframes。不要通过加任意 scrcpy 参数破坏两个 socket 的视频/控制协议。

播放器偏好在每个浏览器分别保存：播放模式、硬件偏好、目标缓存 30–3000 ms、追赶阈值最高 10000 ms、解码队列 1–120。阈值需大于目标缓存。RTT 是应用层往返时间，不是视频端到端延迟。WebCodecs 默认由浏览器选择解码器，可手动选硬件/软件偏好，均非强制保证。

音量键开关默认关闭；原参考插件警告部分 UFI 固件赋予它危险行为，确认自己的固件后再开启。系统分辨率更改会影响所有应用，而编码 max_size 只限制投屏流尺寸。

当前最多同时 10 个触点，跨客户端合计也受 scrcpy 触点上限约束。鼠标滚轮仅在画面区域生效；键盘仅在画面获得焦点时生效，不拦截配置输入框。旧配置若保留较窄的 allowed_keys，需在高级 JSON 中明确添加需要的键码。

`certs/` 中的证书和私钥在更新及全新安装时保留。其他自定义证书请放在安装目录之外；不要把真实私钥上传到 GitHub。

## 危险功能入口

插件：管理与诊断 → 高级 JSON → 危险功能。开启音量键需输入“我已确认设备音量键行为”；通过高级 JSON 导入或编辑开启也会再次确认，取消不写配置。关闭无需短语。播放器：设置 → 高级控制 → 危险按键，进入后再按页面提示解锁本次会话。它控制真实 Android 音量键，并非浏览器本地音量。
