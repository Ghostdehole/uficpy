# UFI-TOOLS 兼容性与排错

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
