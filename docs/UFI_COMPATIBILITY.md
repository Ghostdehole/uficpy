# UFI-TOOLS 兼容性与接口报错

2.2.0 已依据用户上传的插件规范、utils.js、示例和官方 UFI-TOOLS 源码检查。插件使用宿主的 Root 命令、弹窗、提示与折叠接口；配置通过 `timeout 2s awk '{print}'` 读取。未修改宿主函数。

## Windows / iOS 顶部报错

`Failed to execute 'json' on 'Response': Unexpected end of JSON input` 表示响应未能完整解析为 JSON；`The string did not match the expected pattern.` 单凭这一行无法定位调用。官方 `runShellWithRoot` 请求 `/api/root_shell`，直接解析 JSON，失败后返回异常文本。旧插件把文本显示到顶部，这是已确认的一条传播路径，但不能据此断言用户当时两次错误都来自它。

本版保留并完善以下处理：

- 等待 `UFI_DATA.loginfo` 为 `ok` 再自动读取状态，最多等待两分钟；不反复发送 Root 请求。
- 区分空响应、截断 JSON、HTML、无效配置和播放地址；提示带 `uficpy` 前缀及操作名称。
- 不自动重放结果不明的安装、重启、保存命令，也不在重启响应未知时盲目覆盖配置。
- 安装下载、校验、执行分为独立请求，均不超过 90 秒，低于官方 Root 接口的 100 秒上限。
- 播放器 `/api/client` 检查 HTTP 状态、完整响应与字段，读取响应体超时为 10 秒。
- 浏览器禁用存储时保持页面可用；弹窗 ID 遵守原始工具接口，避免连续关闭弹窗留下遮挡层。

`2333` 是 UFI-TOOLS 管理页，`9528` 是默认播放器端口。插件仅在用户安装或更新时查询 GitHub；仓库尚未创建，不能解释仅打开管理页时的所有错误。停用本插件并刷新后仍报错，应检查宿主与其他插件。

## 更新方式

首次创建仓库、发布及离线部署见 [发布指南](GITHUB_SETUP.md)。替换同名 `uficpy_plugin.js` 后重新加载管理页，只启用一份插件。后端升级也必需：播放器资源嵌入 Go 程序，仅换 JS 不会更新播放器。2.2.0 的普通界面不显示技术宣传语，危险功能按 [配置说明](CONFIGURATION.md) 分层开启。

若仍报错：Windows F12 → Network → Preserve log，刷新并记录失败请求的路径、HTTP 状态、响应是否为空或 HTML，以及 Console 调用栈。重点检查 `/api/root_shell`、`/api/goform/...`、播放器 `/api/client`。插件“管理与诊断 → 诊断 → 错误详情”提供脱敏提示。不要公开 Cookie、Authorization、配置 token 或完整带令牌地址。

## 插件商店源

根目录 `repo.json` 跟随主分支，由 `python3 scripts/plugin_source.py` 生成；Release 的 `repo.json` 指向固定发布标签，大小和 MD5 与该次 JS 一致。MD5 只用于插件商店，不替代运行包 SHA-256 校验。

首次发布成功后，商店源为：

```text
https://github.com/Ghostdehole/uficpy/releases/latest/download/repo.json
```

宿主自定义请求头可能触发跨域限制。使用商店代理功能，或同源代理路径：

```text
/api/proxy/--https://github.com/Ghostdehole/uficpy/releases/latest/download/repo.json
```

代理不能解决仓库不存在、没有 Release 或设备网络不通。清单内下载根地址仍为远程 HTTPS；宿主已有安装代理流程，不重复加前缀。上传的 C 生成器示例含占位地址且不能正确枚举本项目，无需运行它或附带 exe。

## 核对来源（2026-10-11）

- 用户上传的插件源规范、TODO.md、utils.js、示例及原 ws_scrcpy 插件。
- [官方 requests.js](https://github.com/kanoqwq/UFI-TOOLS/blob/http-server-version/app/frontEnd/public/script/requests.js)
- [官方 Root 接口](https://github.com/kanoqwq/UFI-TOOLS/blob/http-server-version/app/src/main/java/com/minikano/f50_sms/modules/advanced/advancedToolsModule.kt)
- [官方主页面](https://github.com/kanoqwq/UFI-TOOLS/blob/http-server-version/app/frontEnd/public/script/main.js)

测试覆盖原始 utils.js 及官方 Root 请求函数；不代表用户设备 APK 与当前官方源码完全一致，也不代表已在用户 Windows / iPhone 上确认原始错误消失。
