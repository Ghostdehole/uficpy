# UFI-TOOLS 兼容性与排错

## 设备架构

在“管理与诊断 → 诊断 → 设备架构”中查看内核报告、Android ABI 和选择的后端类型。未安装后端时也能查看。

2.2.2 及更早版本只提供 ARM64 包，并且只接受 `uname -m` 返回 `aarch64/arm64`；提示“当前发布包仅支持 ARM64”表示安装被这项检查拦截，不代表备用下载源失效。

2.2.3 同时提供 ARM64 和 ARMv7 包。`armv8l` 按 ARM64 兼容报告处理；`armv7/armv7l` 结合 Android ABI 选择。安装脚本会先在临时目录运行新程序的 `-version`，确认可执行后再处理配置和旧服务；运行失败不会替换旧后端。

旧清单缺少 ARMv7 时，需要发布并同步新版本的清单和后端包，同时更新管理插件。不要改文件名把 ARM64 包当成 ARMv7，也不要只删除旧插件的架构检查。

插件使用 UFI-TOOLS 的 Root 命令、弹窗和提示接口，登录后才自动查询状态。管理页通常使用 `2333` 端口，播放器默认使用 `9528`。

## JSON 或地址报错

`Unexpected end of JSON input` 通常表示接口响应为空或被截断。`The string did not match the expected pattern.` 需要结合调用栈定位，可能涉及地址解析等浏览器接口。

排查时打开浏览器开发者工具，保留 Network 日志后刷新，查看失败请求的路径、HTTP 状态和响应内容。重点检查 `/api/root_shell`、`/api/goform/...` 和播放器的 `/api/client`。插件内也可查看“管理与诊断 → 诊断 → 错误详情”。

Root 命令的响应不明确时，插件不会自动重试安装、重启或保存，避免重复执行。下载、校验和安装分别请求，单次不超过 90 秒。确认后台状态后再重试。

停用插件后仍然报错时，继续检查 UFI-TOOLS 本身和其他插件。提交日志前删除 Cookie、Authorization、配置 token 和带令牌的地址。

## 更新后没有变化

后端内置播放器资源，更新管理插件不会同时更新播放器。检查后端版本，重新加载管理页，并确认只启用一份 uficpy 插件。Release 插件名带版本号，源码文件名仍为 `uficpy_plugin.js`。

## 插件商店源

稳定发布源：

```text
https://github.com/Ghostdehole/uficpy/releases/latest/download/repo.json
```

跨域请求受限时可使用 UFI-TOOLS 的代理功能，同源代理地址为：

```text
/api/proxy/--https://github.com/Ghostdehole/uficpy/releases/latest/download/repo.json
```

商店读取的是 `repo.json`，不是仓库网页或 `release.json`。Release 中的源固定到同一标签下的插件附件；MD5 用于商店展示文件摘要，后端运行包另外使用 SHA-256。

根目录的源由 `python3 scripts/plugin_source.py` 生成，跟随主分支。清单内保留远程 HTTPS 地址，由宿主处理下载代理。

## 接口参考

- [UFI-TOOLS requests.js](https://github.com/kanoqwq/UFI-TOOLS/blob/http-server-version/app/frontEnd/public/script/requests.js)
- [UFI-TOOLS Root 接口](https://github.com/kanoqwq/UFI-TOOLS/blob/http-server-version/app/src/main/java/com/minikano/f50_sms/modules/advanced/advancedToolsModule.kt)
