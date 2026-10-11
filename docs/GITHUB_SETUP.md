# 首次创建仓库、发布、部署

在 GitHub 创建 **Ghostdehole/uficpy**，选择 Public，创建时不另外初始化 README/license/gitignore，避免首次推送分叉。公开 Release 可以不配置 GitHub token 下载。

解压仓库包，进入同时包含 go.mod、README.md、.github 的目录。推荐用 Git 上传，避免漏掉工作流：

```sh
git init -b main
git add .
git commit -m "Release uficpy 2.2.0 with automatic deployment"
git remote add origin https://github.com/Ghostdehole/uficpy.git
git push -u origin main
```

请先在电脑安装 Git 并配置提交身份；登录由 Git 凭据管理器处理，不要把账号 token 写进仓库。网页上传时上传项目目录内的全部内容，不能只上传 ZIP，也不能再套一层 uficpy 目录。检查仓库根目录存在 `.github/workflows/release.yml`。

打开 Actions → Build and Release。推送 main 会启动；也可 Run workflow，选择 main，scrcpy_version 保持 latest。手动工作流文件必须在默认分支。

工作流用内置 GITHUB_TOKEN 和 contents: write，不需要创建 PAT。组织策略若禁止写 Release，需仓库/组织管理员允许。仓库没有运行过工作流，所以本交付不能保证你的账户策略已满足。

成功后 Release 应包含：

- uficpy-arm64.tar.gz：完整运行包。
- uficpy_plugin.js：前端管理插件。
- uficpy-source.zip：该次构建的完整源码，包含更新后的核心及锁定文件。
- release.json：版本、固定标签、架构、长度、SHA-256。
- repo.json：符合 UFI-TOOLS 商店规范的插件源，指向同一 Release 的 JS。
- core-lock.json：此次使用的 scrcpy 版本和官方 SHA-256。
- SHA256SUMS：附件校验表。

草稿附件上传完整后才公开为 latest。失败可能留下草稿；它不会被插件当作 latest。修复后重跑用新 attempt 标签，不覆写旧版本；不需要的草稿可手动清理。

首次发布完成后再导入插件，在 UFI-TOOLS 的“管理与诊断 → 服务管理”中点击“安装 / 更新”。仓库未创建/未发布会明确失败。旧版 2.0 后端可以直接更新，默认保留配置；需要重置时用“全新安装”。刷新管理页后实际检查画面、触控、断开重连。

没有创建仓库时，可以先手动替换 JS，检查管理页面；这一步不需要在线安装。插件商店源地址与代理设置见 [UFI 兼容性说明](UFI_COMPATIBILITY.md)。商店使用 `repo.json`，不能填写 GitHub 仓库网页或 `release.json`。

## 离线部署

从成功的 Release 下载 `uficpy-arm64.tar.gz`，将它传入设备的 `/data/local/tmp/uficpy-arm64.tar.gz`。在 Root 终端执行：

```sh
mkdir -p /data/local/tmp/uficpy-install
cd /data/local/tmp/uficpy-install
tar -xzf /data/local/tmp/uficpy-arm64.tar.gz
sh install.sh
```

先用 Release 的 `SHA256SUMS` 核对下载包。安装来源必须在 `/data/uficpy` 之外；不要先删除旧目录，安装器会校验、备份及替换旧代码。默认保留配置；明确需要重置配置时使用 `sh install.sh --fresh`。安装成功后可删除上述临时解压目录。

## 触发方式

- main 推送：默认最新稳定 scrcpy，测试并发布。
- workflow_dispatch：latest / locked / 精确版本号；都需要通过协议检查。
- 每天 UTC 03:23（北京时间 11:23）：检查上游；应用版本、核心版本和提交均已发布则跳过。调度可能延迟。
- PR：只读测试，不发布。

VERSION 是 uficpy 版本，core-lock.json/version.txt 是 scrcpy 版本，不能混用。

Fork 发布时清单自动使用实际 GITHUB_REPOSITORY；插件默认 Ghostdehole/uficpy，Fork 用户在“管理与诊断 → 高级设置 → 发布源”改成自己的 owner/repo。

## 官方资料

- https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow
- https://docs.github.com/en/rest/releases/releases
- https://github.com/Genymobile/scrcpy/releases
