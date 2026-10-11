# 构建与发布

`Build and Release` 负责测试、编译和发布，使用仓库自带的 `GITHUB_TOKEN`，需要 `contents: write` 权限。PR 只运行测试。

## 触发方式

- 推送 `main`：使用最新稳定版 scrcpy 构建。
- 手动运行：`scrcpy_version` 可填 `latest`、`locked` 或具体版本号。
- 定时任务：每天 UTC 03:23 检查上游；应用版本、核心版本和提交没有变化时跳过发布。

核心下载后会核对官方 SHA-256 和协议文件。协议发生变化会中止发布，不直接替换 JAR。

## 版本与附件

`VERSION` 是 uficpy 版本；`version.txt` 和 `core-lock.json` 记录 scrcpy 版本。Release 标签包含应用版本、核心版本和工作流运行编号，每次构建使用独立标签。

| 附件 | 内容 |
| --- | --- |
| `uficpy-arm64.tar.gz` | Android ARM64 运行包 |
| `uficpy_plugin-v<版本>.js` | UFI-TOOLS 插件，例如 `uficpy_plugin-v2.2.1.js` |
| `uficpy-source.zip` | 本次构建的源码和核心文件 |
| `release.json` | 固定标签、运行包与插件的大小及 SHA-256 |
| `repo.json` | 指向本次插件附件的商店源 |
| `core-lock.json` | scrcpy 版本及官方资产摘要 |
| `SHA256SUMS` | 附件校验表 |

源码中的插件文件名保持 `uficpy_plugin.js`。仓库根目录的 `repo.json` 跟随主分支，Release 附件中的 `repo.json` 指向固定标签下带版本号的插件。

所有附件先上传到草稿，上传完成后再公开并设为 latest。失败留下的草稿不会被自动安装使用；重跑生成新标签。

## 本地打包

`sh build.sh` 运行测试、编译后端并生成发布文件。测试环境和命令见 [测试说明](VALIDATION.md)。本地打包默认使用 `-local` 标签。

Fork 的发布清单使用 `GITHUB_REPOSITORY`。插件默认发布源为 `Ghostdehole/uficpy`，可在“管理与诊断 → 高级设置 → 发布源”中修改。
