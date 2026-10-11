#!/system/bin/sh
# Run from an extracted release: sh install.sh [--fresh]
# Never invoke the original service.sh stop (it used broad pkill -f).
set -eu
FRESH=0
case "${1:-}" in
    '') [ "$#" -eq 0 ] || { echo 'Usage: sh install.sh [--fresh]'; exit 1; };;
    --fresh) [ "$#" -eq 1 ] || { echo 'Usage: sh install.sh [--fresh]'; exit 1; }; FRESH=1;;
    *) echo 'Usage: sh install.sh [--fresh]'; exit 1;;
esac
[ "$(id -u)" = 0 ] || { echo '请使用 Root shell'; exit 1; }
SOURCE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TARGET=/data/uficpy
LOCK=/data/uficpy-operation.lock
mkdir "$LOCK" 2>/dev/null || { echo '另一个安装/卸载操作正在进行'; exit 1; }
trap 'rmdir "$LOCK" 2>/dev/null' EXIT
STAGE=/data/uficpy-stage.$$
BACKUP=/data/uficpy-backup-$(date +%Y%m%d-%H%M%S)-$$
[ ! -e "$BACKUP" ] || { echo '备份路径已存在，请重试'; exit 1; }
case "$SOURCE/" in "$TARGET/"*) echo '请在 /data/local/tmp 等独立临时目录解压安装包后执行'; exit 1;; esac
[ ! -L "$TARGET" ] || { echo '安装目录不可为符号链接'; exit 1; }
case "$(uname -m)" in aarch64|arm64) :;; *) echo '此安装包仅适用于 ARM64'; exit 1;; esac
for item in uficpy scrcpy-server.jar core-lock.json version.txt VERSION service.sh uninstall.sh config.json; do
    [ -f "$SOURCE/$item" ] || { echo "缺少 $item"; exit 1; }
done
umask 077
mkdir "$STAGE"
SWAP_STARTED=0
COMMITTED=0
cleanup() {
    result=$?
    if [ "$SWAP_STARTED" -eq 1 ] && [ "$COMMITTED" -eq 0 ]; then
        if [ -d "$BACKUP" ] || { [ ! -d "$STAGE" ] && [ -d "$TARGET" ]; }; then
            if [ -d "$TARGET" ]; then
                sh "$TARGET/service.sh" stop || true
                mv "$TARGET" "$TARGET-failed-$$" || true
            fi
            if [ -d "$BACKUP" ] && [ ! -e "$TARGET" ]; then
                if mv "$BACKUP" "$TARGET"; then
                    echo '已恢复旧目录；为兼容旧脚本，不会自动启动旧版本'
                else
                    echo "自动恢复失败，旧文件仍保留于 $BACKUP" >&2
                fi
            elif [ -d "$BACKUP" ]; then
                echo "无法移开失败目录；旧文件仍保留于 $BACKUP" >&2
            fi
        fi
    fi
    rm -rf "$STAGE"
    rmdir "$LOCK" 2>/dev/null || true
    return "$result"
}
trap cleanup EXIT
trap 'exit 1' INT TERM
for item in uficpy scrcpy-server.jar core-lock.json version.txt VERSION service.sh uninstall.sh; do cp "$SOURCE/$item" "$STAGE/"; done
for item in release-tag.txt README.md THIRD_PARTY_NOTICES.md; do [ ! -f "$SOURCE/$item" ] || cp "$SOURCE/$item" "$STAGE/"; done
[ ! -d "$SOURCE/licenses" ] || cp -R "$SOURCE/licenses" "$STAGE/"
if [ "$FRESH" -eq 0 ] && [ -f "$TARGET/config.json" ]; then cp "$TARGET/config.json" "$STAGE/config.json"; else cp "$SOURCE/config.json" "$STAGE/config.json"; fi
# A fresh configuration must not discard the device's original display values.
[ ! -f "$TARGET/display-backup.json" ] || cp "$TARGET/display-backup.json" "$STAGE/"
# Certificates are user data, including when configuration and token are reset.
[ ! -d "$TARGET/certs" ] || cp -R "$TARGET/certs" "$STAGE/"
chmod 700 "$STAGE/uficpy" "$STAGE/service.sh"
"$STAGE/uficpy" -dir "$STAGE" -init
"$STAGE/uficpy" -dir "$STAGE" -check
owned() {
    candidate=$1
    [ "$(readlink "/proc/$candidate/exe" 2>/dev/null)" = "$TARGET/uficpy" ] && return 0
    # Only the scrcpy server started with this exact deployment's classpath.
    tr '\000' '\n' < "/proc/$candidate/cmdline" 2>/dev/null | grep -qxF 'com.genymobile.scrcpy.Server' || return 1
    tr '\000' '\n' < "/proc/$candidate/environ" 2>/dev/null | grep -qxF "CLASSPATH=$TARGET/scrcpy-server.jar"
}
stopping=''
for entry in /proc/[0-9]*; do
    p=${entry##*/}
    if owned "$p"; then
        kill -TERM "$p" 2>/dev/null || true
        stopping="$stopping $p"
    fi
done
# One shared grace period: multiple stale capture children must not multiply
# the install duration beyond the management page's Root request deadline.
n=0
while [ "$n" -lt 5 ]; do
    pending=0
    for p in $stopping; do if owned "$p"; then pending=1; fi; done
    [ "$pending" -ne 0 ] || break
    sleep 1; n=$((n+1))
done
for p in $stopping; do if owned "$p"; then kill -KILL "$p" 2>/dev/null || true; fi; done
SWAP_STARTED=1
if [ -d "$TARGET" ]; then mv "$TARGET" "$BACKUP"; fi
if ! mv "$STAGE" "$TARGET"; then
    echo '安装目录替换失败'; exit 1
fi
if ! sh "$TARGET/service.sh" start; then
    echo '新版本启动失败；保留失败目录并恢复旧目录（不会自动运行旧脚本）'
    exit 1
fi
COMMITTED=1
echo "安装完成。旧版备份（如果原目录存在）：$BACKUP"
echo '请在 UFI-TOOLS 中替换 uficpy_plugin.js，然后点击“刷新状态”并打开投屏。'
