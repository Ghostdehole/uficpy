package main

import (
	"context"
	"encoding/binary"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestVolumeAndReadOnlyWebsocketPolicy(t *testing.T) {
	for _, mode := range []struct {
		name   string
		volume bool
		read   bool
	}{{"blocked", false, false}, {"enabled", true, false}, {"read_only", true, true}} {
		t.Run(mode.name, func(t *testing.T) {
			c := defaults()
			c.Token = strings.Repeat("a", 64)
			c.AllowVolumeKeys, c.ReadOnly = mode.volume, mode.read
			ready := make(chan struct{})
			controls := make(chan []byte, 4)
			h := newHub(func(ctx context.Context, h *hub) error {
				a, b := net.Pipe()
				defer a.Close()
				defer b.Close()
				h.setControl(a)
				defer h.setControl(nil)
				go func() {
					for {
						buf := make([]byte, 14)
						if _, e := io.ReadFull(b, buf); e != nil {
							return
						}
						controls <- buf
					}
				}()
				close(ready)
				<-ctx.Done()
				return ctx.Err()
			})
			defer h.close()
			srv := httptest.NewServer(routes(c, h))
			defer srv.Close()
			d := websocket.Dialer{Subprotocols: []string{"uficpy-v2", c.Token}}
			ws, _, e := d.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"/ws", http.Header{"Origin": []string{srv.URL}})
			if e != nil {
				t.Fatal(e)
			}
			defer ws.Close()
			<-ready
			ws.SetReadDeadline(time.Now().Add(time.Second))
			if e = ws.WriteMessage(websocket.BinaryMessage, keyControl(24, 0)); e != nil {
				t.Fatal(e)
			}
			if !mode.volume {
				for e == nil {
					_, _, e = ws.ReadMessage()
				}
				if !websocket.IsCloseError(e, 1008) {
					t.Fatal("disabled volume key not rejected", e)
				}
				return
			}
			if mode.read {
				if e = ws.WriteMessage(websocket.TextMessage, []byte(`{"type":"ping","id":42}`)); e != nil {
					t.Fatal(e)
				}
				for {
					_, data, e := ws.ReadMessage()
					if e != nil {
						t.Fatal(e)
					}
					if strings.Contains(string(data), `"pong"`) {
						break
					}
				}
				select {
				case <-controls:
					t.Fatal("read-only client injected volume event")
				default:
				}
				return
			}
			select {
			case got := <-controls:
				if got[1] != 0 || binary.BigEndian.Uint32(got[2:6]) != 24 {
					t.Fatal("authorized volume key changed in transit")
				}
			case <-time.After(time.Second):
				t.Fatal("authorized volume key silently dropped")
			}
			ws.Close()
			select {
			case got := <-controls:
				if got[1] != 1 || binary.BigEndian.Uint32(got[2:6]) != 24 {
					t.Fatal("disconnect did not release held volume key")
				}
			case <-time.After(time.Second):
				t.Fatal("disconnect left volume key held")
			}
		})
	}
}
