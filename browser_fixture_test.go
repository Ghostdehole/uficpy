package main

import (
	"context"
	"encoding/binary"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

// This opt-in fixture uses an in-memory capture source, not app_process or an
// Android socket. It validates the actual hub, HTTP/WebSocket stack and player.
func TestBrowserFixtureServer(t *testing.T) {
	dir := os.Getenv("UFICPY_BROWSER_FIXTURE")
	if dir == "" {
		t.Skip("browser-only fixture")
	}
	b, e := os.ReadFile("tests/fixtures/packets.bin")
	if e != nil {
		t.Fatal(e)
	}
	var packets []packet
	for len(b) > 0 {
		n := int(binary.BigEndian.Uint32(b[8:12]))
		data := append([]byte(nil), b[:12+n]...)
		flags := binary.BigEndian.Uint64(data)
		packets = append(packets, packet{data, flags&configFlag != 0, flags&keyFlag != 0})
		b = b[12+n:]
	}
	c, e := readConfig(filepath.Join(dir, "config.json"))
	if e != nil {
		t.Fatal(e)
	}
	h := newHub(func(ctx context.Context, h *hub) error {
		a, b := net.Pipe()
		defer a.Close()
		defer b.Close()
		h.setControl(a)
		defer h.setControl(nil)
		go func() {
			buf := make([]byte, 2048)
			for {
				n, e := b.Read(buf)
				if e != nil {
					return
				}
				fmt.Printf("TEST_CONTROL %x\n", buf[:n])
			}
		}()
		h.publish(packets[0])
		h.status("streaming", "内存测试流")
		tick := time.NewTicker(time.Second / 30)
		defer tick.Stop()
		i := 0
		for {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-tick.C:
				p := packets[1+i%(len(packets)-1)]
				p.data = append([]byte(nil), p.data...)
				flags := uint64(1000000 + i*33333)
				if p.key {
					flags |= keyFlag
				}
				binary.BigEndian.PutUint64(p.data, flags)
				h.publish(p)
				i++
			}
		}
	})
	srv := &http.Server{Addr: fmt.Sprintf("127.0.0.1:%d", c.Port), Handler: routes(c, h)}
	l, e := net.Listen("tcp", srv.Addr)
	if e != nil {
		t.Fatal(e)
	}
	go srv.Serve(l)
	os.WriteFile(filepath.Join(dir, "uficpy.ready"), []byte("fixture"), 0600)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	<-ctx.Done()
	h.close()
	srv.Close()
}
