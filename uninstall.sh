#!/system/bin/sh
# sh /data/uficpy/uninstall.sh [--purge-backups]
set -eu
[ "$(id -u)" = 0 ] || { echo '请使用 Root'; exit 1; }
case "${1:-}" in
    '') [ "$#" -eq 0 ] || { echo 'Usage: uninstall.sh [--purge-backups]'; exit 1; };;
    --purge-backups) [ "$#" -eq 1 ] || { echo 'Usage: uninstall.sh [--purge-backups]'; exit 1; };;
    *) echo 'Usage: uninstall.sh [--purge-backups]'; exit 1;;
esac
[ ! -L /data/uficpy ] || { echo '安装目录不可为符号链接'; exit 1; }
LOCK=/data/uficpy-operation.lock
mkdir "$LOCK" 2>/dev/null || { echo '另一个安装/卸载操作正在进行'; exit 1; }
trap 'rmdir "$LOCK" 2>/dev/null' EXIT
sh /data/uficpy/service.sh stop
# Restore only values explicitly backed up by this project.
if [ -f /data/uficpy/display-backup.json ]; then
    /data/uficpy/uficpy -dir /data/uficpy -restore-display
fi
BOOT=/sdcard/ufi_tools_boot.sh
if [ -f "$BOOT" ]; then
    awk '$0 != "(cd /data/uficpy && sh service.sh start)" && $0 != "sh /data/uficpy/service.sh start # UFICPY_V2_AUTOSTART" {print}' "$BOOT" > "$BOOT.uficpy.tmp"
    mv -f "$BOOT.uficpy.tmp" "$BOOT"
fi
rm -rf /data/uficpy
if [ "${1:-}" = --purge-backups ]; then rm -rf /data/uficpy-backup-* /data/uficpy-failed-*; fi
echo '后端已卸载，自启已清理；管理页 JS 插件可保留以便重新安装。'
