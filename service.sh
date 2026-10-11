#!/system/bin/sh
# Usage: sh /data/uficpy/service.sh start|stop|restart|status
set -u
BASEDIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
BIN="$BASEDIR/uficpy"
PIDFILE="$BASEDIR/uficpy.pid"
READY="$BASEDIR/uficpy.ready"
LOG="$BASEDIR/uficpy.log"
LOCK="$BASEDIR/.service-lock"
owned_pid() {
    [ -f "$PIDFILE" ] || return 1
    pid=$(cat "$PIDFILE")
    case "$pid" in ''|*[!0-9]*) return 1;; esac
    [ "$pid" -gt 1 ] || return 1
    [ "$(readlink "/proc/$pid/exe" 2>/dev/null)" = "$BIN" ] && kill -0 "$pid" 2>/dev/null
}
if [ "${1:-}" = status ]; then
    if owned_pid && [ "$(cat "$READY" 2>/dev/null)" = "$pid" ]; then echo running; else echo stopped; fi
    exit 0
fi
umask 077
if ! mkdir "$LOCK" 2>/dev/null; then
    echo '另一个启停操作尚未结束；若脚本被强杀，请确认无操作后删除 .service-lock' >&2
    exit 1
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT
trap 'exit 1' INT TERM
start_service() {
    if owned_pid; then
        if [ "$(cat "$READY" 2>/dev/null)" = "$pid" ]; then echo "already running: $pid"; return 0; fi
        echo '进程存在但尚未就绪，请执行 restart 或检查日志' >&2
        return 1
    fi
    rm -f "$PIDFILE" "$READY"
    chmod 700 "$BASEDIR" || return 1
    chmod 700 "$BIN" || return 1
    "$BIN" -dir "$BASEDIR" -init || return 1
    "$BIN" -dir "$BASEDIR" -check || return 1
    [ ! -f "$LOG" ] || mv -f "$LOG" "$LOG.previous"
    nohup "$BIN" -dir "$BASEDIR" > "$LOG" 2>&1 < /dev/null &
    pid=$!
    echo "$pid" > "$PIDFILE"
    count=0
    while [ "$count" -lt 10 ]; do
        # nohup may not have exec'd the Go binary on the first poll.
        if owned_pid && [ "$(cat "$READY" 2>/dev/null)" = "$pid" ]; then echo "running: $pid"; return 0; fi
        if ! kill -0 "$pid" 2>/dev/null; then tail -n 30 "$LOG"; rm -f "$PIDFILE"; return 1; fi
        sleep 1
        count=$((count + 1))
    done
    echo '监听启动超时，请查看日志' >&2
    stop_service
    return 1
}
stop_service() {
    if owned_pid; then
        kill -TERM "$pid" || return 1
        count=0
        while owned_pid && [ "$count" -lt 8 ]; do sleep 1; count=$((count + 1)); done
        if owned_pid; then kill -KILL "$pid" || return 1; fi
    fi
    rm -f "$PIDFILE" "$READY"
    echo stopped
}
case "${1:-}" in
    start) start_service;;
    stop) stop_service;;
    restart) stop_service && start_service;;
    *) echo "Usage: $0 {start|stop|restart|status}"; exit 1;;
esac
