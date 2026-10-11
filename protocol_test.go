package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"github.com/gorilla/websocket"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func makePacket(flags uint64, b []byte) packet {
	data := make([]byte, len(b)+12)
	binary.BigEndian.PutUint64(data, flags)
	binary.BigEndian.PutUint32(data[8:], uint32(len(b)))
	copy(data[12:], b)
	return packet{data, flags&configFlag != 0, flags&keyFlag != 0}
}
func TestScrcpy41Framing(t *testing.T) {
	for _, flags := range []uint64{configFlag, keyFlag | 123456789, 123456790} {
		p := makePacket(flags, []byte{0, 0, 0, 1, 0x65})
		got, e := readPacket(bytes.NewReader(p.data))
		if e != nil || !bytes.Equal(got.data, p.data) || got.config != p.config || got.key != p.key {
			t.Fatalf("flags=%x: %#v %v", flags, got, e)
		}
	}
	for _, bad := range [][]byte{{}, make([]byte, 12), makePacket(1<<63, []byte{1}).data, makePacket(0, []byte{1}).data[:12]} {
		if _, e := readPacket(bytes.NewReader(bad)); e == nil {
			t.Fatal("accepted invalid packet")
		}
	}
	b := makePacket(0, []byte{1}).data
	binary.BigEndian.PutUint32(b[8:], maxPacket+1)
	if _, e := readPacket(bytes.NewReader(b)); e == nil {
		t.Fatal("unbounded allocation")
	}
}
func TestControlBoundary(t *testing.T) {
	b := make([]byte, 14)
	binary.BigEndian.PutUint32(b[2:], 4)
	if !validControl(b) {
		t.Fatal("back rejected")
	}
	for _, k := range []uint32{24, 25, 26, 164, 0xffffffff} {
		binary.BigEndian.PutUint32(b[2:], k)
		if validControl(b) {
			t.Fatalf("dangerous/unapproved key %d accepted", k)
		}
	}
	touch := make([]byte, 32)
	touch[0] = 2
	binary.BigEndian.PutUint16(touch[18:], 720)
	binary.BigEndian.PutUint16(touch[20:], 1280)
	if !validControl(touch) {
		t.Fatal("touch rejected")
	}
	binary.BigEndian.PutUint32(touch[10:], 720)
	if validControl(touch) {
		t.Fatal("offscreen touch accepted")
	}
	text := []byte("中文 ' $(test)")
	clip := make([]byte, 14+len(text))
	clip[0] = 9
	clip[9] = 1
	binary.BigEndian.PutUint32(clip[10:], uint32(len(text)))
	copy(clip[14:], text)
	if !validControl(clip) {
		t.Fatal("clipboard rejected")
	}
	clip[10] = 255
	if validControl(clip) {
		t.Fatal("invalid clipboard size accepted")
	}
	if validControl(append(b, b...)) {
		t.Fatal("multiple controls in one frame accepted")
	}
}
func TestHubLateJoinAndSlowViewer(t *testing.T) {
	started := make(chan struct{})
	h := newHub(func(ctx context.Context, h *hub) error { close(started); <-ctx.Done(); return ctx.Err() })
	defer h.close()
	a := h.add()
	<-started
	h.publish(makePacket(configFlag, []byte{7, 8}))
	h.publish(makePacket(keyFlag|10, []byte{5}))
	h.publish(makePacket(11, []byte{1}))
	b := h.add()
	// Starting status may precede packets; verify the binary sequence only.
	drain := func(c *client) [][]byte {
		var got [][]byte
		for {
			select {
			case m := <-c.queue:
				if m.kind == 2 {
					got = append(got, m.data)
				}
			default:
				return got
			}
		}
	}
	got := drain(b)
	if len(got) != 3 {
		t.Fatalf("late viewer missing config/GOP: %d", len(got))
	}
	for i := 0; i < 300; i++ {
		h.publish(makePacket(uint64(i+12), []byte{1}))
	}
	h.mu.Lock()
	remaining := len(h.clients)
	h.mu.Unlock()
	if remaining != 0 {
		t.Fatalf("slow clients not disconnected: %d", remaining)
	}
	h.remove(a)
	h.remove(b)
}
func TestHubIdleReconnect(t *testing.T) {
	var starts atomic.Int32
	h := newHub(func(ctx context.Context, h *hub) error { starts.Add(1); <-ctx.Done(); return ctx.Err() })
	defer h.close()
	a := h.add()
	time.Sleep(10 * time.Millisecond)
	h.remove(a)
	time.Sleep(100 * time.Millisecond)
	b := h.add()
	time.Sleep(2100 * time.Millisecond)
	if starts.Load() != 1 {
		t.Fatal("reconnect unnecessarily restarted capture")
	}
	h.remove(b)
	time.Sleep(2100 * time.Millisecond)
	h.mu.Lock()
	idle := h.cancel == nil
	h.mu.Unlock()
	if !idle {
		t.Fatal("capture did not stop after idle")
	}
	c := h.add()
	time.Sleep(20 * time.Millisecond)
	if starts.Load() != 2 {
		t.Fatal("capture did not restart")
	}
	h.remove(c)
}
func TestWebsocketAuthAndTransport(t *testing.T) {
	c := defaults()
	c.Token = strings.Repeat("a", 64)
	h := newHub(func(ctx context.Context, h *hub) error {
		h.publish(makePacket(configFlag, []byte{7, 8}))
		h.publish(makePacket(keyFlag, []byte{5}))
		<-ctx.Done()
		return ctx.Err()
	})
	defer h.close()
	srv := httptest.NewServer(routes(c, h))
	defer srv.Close()
	resp, e := http.Get(srv.URL + "/healthz")
	if e != nil {
		t.Fatal(e)
	}
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatal("health unauthenticated")
	}
	req, _ := http.NewRequest("GET", srv.URL+"/healthz", nil)
	req.Header.Set("Authorization", "Bearer "+c.Token)
	resp, e = http.DefaultClient.Do(req)
	if e != nil {
		t.Fatal(e)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatal("health unavailable")
	}
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"
	d := websocket.Dialer{Subprotocols: []string{"uficpy-v2", c.Token}}
	if ws, _, e := d.Dial(url, http.Header{"Origin": []string{"http://evil.test"}}); e == nil {
		ws.Close()
		t.Fatal("cross-origin websocket accepted")
	}
	ws, _, e := d.Dial(url, http.Header{"Origin": []string{srv.URL}})
	if e != nil {
		t.Fatal(e)
	}
	defer ws.Close()
	ws.SetReadDeadline(time.Now().Add(time.Second))
	count := 0
	for count < 2 {
		kind, _, e := ws.ReadMessage()
		if e != nil {
			t.Fatal(e)
		}
		if kind == 2 {
			count++
		}
	}
	bad := make([]byte, 14)
	binary.BigEndian.PutUint32(bad[2:], 24)
	ws.WriteMessage(2, bad)
	for {
		_, _, e = ws.ReadMessage()
		if e != nil {
			break
		}
	}
	if !websocket.IsCloseError(e, 1008) {
		t.Fatalf("bad control not rejected: %v", e)
	}
}
func TestConfigValidation(t *testing.T) {
	c := defaults()
	if e := c.validate(false); e != nil {
		t.Fatal(e)
	}
	c.NoAudio = false
	if c.validate(false) == nil {
		t.Fatal("unsupported audio accepted")
	}
	c = defaults()
	c.WmSize = "720x1280; reboot"
	if c.validate(false) == nil {
		t.Fatal("shell-like size accepted")
	}
	dir := t.TempDir()
	path := dir + "/config.json"
	if e := initConfig(path); e != nil {
		t.Fatal(e)
	}
	got, e := readConfig(path)
	if e != nil || got.validate(true) != nil {
		t.Fatal("init failed", e)
	}
	token := got.Token
	if e = initConfig(path); e != nil {
		t.Fatal(e)
	}
	got, _ = readConfig(path)
	if got.Token != token {
		t.Fatal("token changed on re-init")
	}
}

func TestSplitConfigPackets(t *testing.T) {
	started := make(chan struct{})
	h := newHub(func(ctx context.Context, h *hub) error { close(started); <-ctx.Done(); return ctx.Err() })
	defer h.close()
	a := h.add()
	<-started
	h.publish(makePacket(configFlag, []byte{0, 0, 0, 1, 7}))
	h.publish(makePacket(configFlag, []byte{0, 0, 0, 1, 8}))
	h.publish(makePacket(keyFlag, []byte{0, 0, 0, 1, 5}))
	var config []byte
	for len(config) == 0 {
		select {
		case m := <-a.queue:
			if m.kind == 2 {
				config = m.data
			}
		case <-time.After(time.Second):
			t.Fatal("missing config")
		}
	}
	p, e := readPacket(bytes.NewReader(config))
	if e != nil || len(p.data) != 22 || p.data[16] != 7 || p.data[21] != 8 {
		t.Fatal("split SPS/PPS were not preserved", e)
	}
	h.remove(a)
}
