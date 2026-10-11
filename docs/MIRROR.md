# 备用下载源

插件在“管理与诊断 → 高级设置 → 发布源”中设置下载地址。GitHub 仓库仍填 `Ghostdehole/uficpy`，备用地址填静态文件所在目录，例如 `https://download.doevt.top/uficpy`。这个地址是部署示例，需要先完成域名解析和网站配置。

| 下载方式 | 行为 |
| --- | --- |
| GitHub 优先 | 先读取 GitHub 清单，下载失败再尝试备用源 |
| 备用源优先 | 先读取备用源清单，下载失败再尝试 GitHub |
| 仅备用源 | 清单和后端都从备用源读取，不访问 GitHub |

默认使用 GitHub；备用地址留空即可停用。设置保存在当前浏览器，换浏览器或清除站点数据后需重新填写。国内设备可以选“备用源优先”；希望只安装自己已同步的版本时，选“仅备用源”。

读取到有效清单后，本次安装锁定其中的标签和 SHA-256。即使切换下载源，也只下载同一个版本；校验失败不会继续安装。备用源优先时，以镜像清单为准，不额外查询 GitHub 是否有更新。

## 1Panel 配置

1. 给 `download.doevt.top` 添加指向服务器公网 IP 的 DNS 记录。也可使用现有域名的独立目录。
2. 在 1Panel 的“网站”中创建静态网站，绑定该域名。若尚未安装 OpenResty，按面板提示安装。
3. 为网站申请或选择可信证书，启用 HTTPS，并确保 HTTPS 端口可以访问。插件只接受 HTTPS，不跳过证书检查。
4. 从面板打开该网站实际的根目录，在其中创建 `uficpy` 目录。不要把文件放进网站的日志或证书目录；不同版本的 1Panel 路径可能不同，以面板显示的运行目录为准。

服务器只需提供静态文件。下载请求由 UFI 设备上的 curl 发出，不需要配置浏览器 CORS，也不需要在服务器上运行 uficpy 后端。下载路径应允许直接 GET，不要加登录页、验证码或拦截空 Referer 的防盗链。

## 手动同步

每次从同一条 GitHub Release 下载 `uficpy-mirror.zip`，先解压到临时目录，再复制到网站目录：

| 网站根目录下的路径 | 用途 |
| --- | --- |
| `uficpy/release.json` | 镜像当前提供的版本 |
| `uficpy/releases/<完整标签>/uficpy-arm64.tar.gz` | 该版本的 ARM64 后端包 |
| `uficpy/releases/<完整标签>/uficpy-armv7.tar.gz` | 该版本的 ARMv7 后端包 |

先复制完整的 `releases/<完整标签>/`，确认完成后，最后替换 `uficpy/release.json`。可先上传为 `release.json.new`，再在同一目录重命名替换，避免设备读到上传了一半的清单。保留旧标签目录，让已经开始的下载能够完成。

ZIP 内已放好目录，不要改标签名、重新打包 tar.gz 或编辑清单中的摘要。也可手动下载同一 Release 的 `release.json`、`uficpy-arm64.tar.gz` 和 `uficpy-armv7.tar.gz`，按上表放置。清单里的 `tag` 就是完整标签，不能只用 `v2.2.3` 代替。

不要将修复补丁 ZIP 或 `uficpy-source.zip` 当作后端包。`uficpy-mirror.zip` 由更新后的发布工作流生成；2.2.2 开始提供镜像包，2.2.3 开始包含 ARMv7。升级后需同步新包和新清单；只换插件，旧镜像不会自动增加 ARMv7 文件。

## 缓存与检查

根目录的 `release.json` 不应长期缓存。如果网站启用了缓存或 CDN，为此路径单独禁用缓存；按版本存放的 tar.gz 可以缓存。使用 OpenResty 配置文件时，可在现有 `server` 块中添加下面两段，保留原有的域名、根目录和证书配置：

```nginx
location = /uficpy/release.json {
    expires off;
    add_header Cache-Control "no-store" always;
    try_files $uri =404;
}

location ^~ /uficpy/releases/ {
    autoindex off;
    try_files $uri =404;
}
```

这两段继承网站的 `root`，对应上表的目录。若已有相同 `location`，修改原规则，不能重复添加。保存时通过面板的配置检查再重载。

访问 `https://download.doevt.top/uficpy/release.json` 应返回 JSON。按其中的 `tag` 访问 `https://download.doevt.top/uficpy/releases/<完整标签>/uficpy-arm64.tar.gz` 应能下载文件，ARMv7 包路径同理。不存在的文件应返回 404，不要重写到首页。

常见问题：404 通常是目录多套了一层或该标签尚未同步；403 检查文件读取权限和防盗链；返回 HTML 则检查登录拦截、验证码或伪静态；证书错误检查域名、完整证书链和设备时间。插件会在安装前再次核对文件大小、SHA-256 和归档内容。

1Panel 的操作入口见[创建网站](https://1panel.cn/docs/v2/user_manual/websites/website_create/)和[网站配置](https://1panel.cn/docs/v2/user_manual/websites/website_config_basic/)；配置中的路径映射见 [Nginx root / try_files](https://nginx.org/en/docs/http/ngx_http_core_module.html#try_files)。
