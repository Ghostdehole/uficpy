package main

import (
	"context"
	"crypto/subtle"
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"github.com/gorilla/websocket"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

//go:embed web/*
var webFiles embed.FS
var appVersion = "2.3.0"

func authorized(r *http.Request, token string) bool {
	v := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if subtle.ConstantTimeCompare([]byte(v), []byte(token)) == 1 {
		return true
	}
	for _, v = range websocket.Subprotocols(r) {
		if subtle.ConstantTimeCompare([]byte(v), []byte(token)) == 1 {
			return true
		}
	}
	return false
}
func sameOrigin(r *http.Request) bool {
	u, e := url.Parse(r.Header.Get("Origin"))
	return e == nil && (u.Scheme == "http" || u.Scheme == "https") && strings.EqualFold(u.Host, r.Host)
}
func routes(c Config, h *hub) http.Handler {
	mux := http.NewServeMux()
	registerTransferRoutes(mux, c)
	files, _ := fs.Sub(webFiles, "web")
	mux.Handle("/", http.FileServer(http.FS(files)))
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		if !authorized(r, c.Token) {
			http.Error(w, "unauthorized", 401)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(h.health())
	})
	mux.HandleFunc("/api/client", func(w http.ResponseWriter, r *http.Request) {
		if !authorized(r, c.Token) {
			http.Error(w, "unauthorized", 401)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"version": appVersion, "core_version": coreLock.Version, "read_only": c.ReadOnly,
			"allow_volume_keys": c.AllowVolumeKeys, "allowed_keys": c.AllowedKeys,
			"max_size": c.MaxSize, "max_fps": c.MaxFps, "bit_rate": c.BitRate,
			"transfers": ExposeTransferLimits(), "device_tools": true,
			"audio": map[string]any{"enabled": !c.NoAudio, "source": c.AudioSource},
		})
	})
	up := websocket.Upgrader{CheckOrigin: sameOrigin, Subprotocols: []string{"uficpy-v2"}, HandshakeTimeout: 5 * time.Second}
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		if !authorized(r, c.Token) {
			http.Error(w, "unauthorized", 401)
			return
		}
		ws, e := up.Upgrade(w, r, nil)
		if e != nil {
			return
		}
		defer ws.Close()
		cl := h.add()
		if cl == nil {
			ws.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(1013, "client limit"), time.Now().Add(time.Second))
			return
		}
		ws.SetReadLimit(2048)
		ws.SetReadDeadline(time.Now().Add(45 * time.Second))
		ws.SetPongHandler(func(string) error { return ws.SetReadDeadline(time.Now().Add(45 * time.Second)) })
		readDone := make(chan struct{})
		defer func() {
			// Stop incoming controls before releasing this client's held pointer.
			ws.Close()
			<-readDone
			h.remove(cl)
		}()
		go func() {
			defer close(readDone)
			defer ws.Close()
			for {
				kind, b, e := ws.ReadMessage()
				if e != nil {
					return
				}
				if kind == websocket.TextMessage {
					var ping struct {
						Type string `json:"type"`
						ID   int64  `json:"id"`
					}
					if json.Unmarshal(b, &ping) == nil && ping.Type == "ping" {
						reply, _ := json.Marshal(map[string]any{"type": "pong", "id": ping.ID})
						h.mu.Lock()
						h.enqueue(cl, message{1, reply})
						h.mu.Unlock()
						continue
					}
				}
				if c.ReadOnly {
					continue
				}
				if kind != websocket.BinaryMessage || !validControlFor(b, c) {
					ws.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(1008, "invalid control"), time.Now().Add(time.Second))
					return
				}
				if e = h.sendControl(cl, b); e != nil {
					log.Printf("control: %v", e)
					reply, _ := json.Marshal(map[string]string{"type": "control_error", "detail": e.Error()})
					h.mu.Lock()
					h.enqueue(cl, message{1, reply})
					h.mu.Unlock()
				}
			}
		}()
		ping := time.NewTicker(15 * time.Second)
		defer ping.Stop()
		for {
			select {
			case <-readDone:
				return
			case m, ok := <-cl.queue:
				if !ok {
					return
				}
				h.mu.Lock()
				cl.queued -= len(m.data)
				h.mu.Unlock()
				ws.SetWriteDeadline(time.Now().Add(3 * time.Second))
				if e = ws.WriteMessage(m.kind, m.data); e != nil {
					return
				}
			case <-ping.C:
				if e = ws.WriteControl(websocket.PingMessage, nil, time.Now().Add(time.Second)); e != nil {
					return
				}
			}
		}
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		mux.ServeHTTP(w, r)
	})
}
func main() {
	exe, _ := os.Executable()
	dir := flag.String("dir", filepath.Dir(exe), "运行目录")
	init := flag.Bool("init", false, "验证配置并生成访问令牌")
	check := flag.Bool("check", false, "验证配置和配套核心")
	configPath := flag.String("config", "", "替代配置文件路径")
	apply := flag.Bool("apply-display", false, "备份并显式应用 wm 配置")
	listEncoders := flag.Bool("list-encoders", false, "列出设备编码器")
	listDisplays := flag.Bool("list-displays", false, "列出设备显示屏")
	version := flag.Bool("version", false, "输出程序和核心版本")
	restore := flag.Bool("restore-display", false, "恢复首次修改前的 wm 覆盖值")
	flag.Parse()
	if *version {
		fmt.Printf("uficpy %s / scrcpy %s\n", appVersion, coreLock.Version)
		return
	}
	abs, e := filepath.Abs(*dir)
	if e != nil {
		log.Fatal(e)
	}
	path := *configPath
	if path == "" {
		path = filepath.Join(abs, "config.json")
	}
	if *init {
		if e = initConfig(path); e != nil {
			log.Fatal(e)
		}
		log.Print("配置已初始化")
		return
	}
	if *restore {
		if e = restoreDisplay(abs); e != nil {
			log.Fatal(e)
		}
		return
	}
	c, e := readConfig(path)
	if e != nil {
		log.Fatal(e)
	}
	if e = c.validate(true); e != nil {
		log.Fatal(e)
	}
	if e = verifyCore(abs); e != nil {
		log.Fatal(e)
	}
	if *listEncoders || *listDisplays {
		kind := "encoders"
		if *listDisplays {
			kind = "displays"
		}
		if e = listCapabilities(abs, kind); e != nil {
			log.Fatal(e)
		}
		return
	}
	if *check {
		fmt.Println("配置和核心校验通过")
		return
	}
	if *apply {
		if e = applyDisplay(abs, c); e != nil {
			log.Fatal(e)
		}
		return
	}
	h := newHub(captureRunner(abs, c))
	h.limits = c
	srv := &http.Server{Addr: net.JoinHostPort(c.Listen, fmt.Sprint(c.Port)), Handler: routes(c, h), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 16384}
	listener, e := net.Listen("tcp", srv.Addr)
	if e != nil {
		log.Fatal(e)
	}
	readyPath := filepath.Join(abs, "uficpy.ready")
	if e = os.WriteFile(readyPath, []byte(fmt.Sprint(os.Getpid())), 0600); e != nil {
		listener.Close()
		log.Fatal(e)
	}
	defer os.Remove(readyPath)
	log.Printf("uficpy 服务运行在 %s (按需采集)", listener.Addr())
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ended := make(chan error, 1)
	go func() {
		if c.TLSCert != "" {
			ended <- srv.ServeTLS(listener, c.TLSCert, c.TLSKey)
		} else {
			ended <- srv.Serve(listener)
		}
	}()
	select {
	case <-ctx.Done():
	case e = <-ended:
		if e != nil && e != http.ErrServerClosed {
			log.Printf("HTTP: %v", e)
		}
	}
	h.close()
	shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	srv.Shutdown(shutdown)
}
