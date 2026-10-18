package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func clipboardDevicePacket(text string) []byte {
	b := make([]byte, 5+len(text))
	binary.BigEndian.PutUint32(b[1:5], uint32(len(text)))
	copy(b[5:], text)
	return b
}

func clipboardTestClient(h *hub) *client {
	c := &client{queue: make(chan message, 10)}
	h.mu.Lock()
	h.clients[c] = true
	h.mu.Unlock()
	return c
}

func readClipboardReply(t *testing.T, c *client) map[string]string {
	t.Helper()
	select {
	case m := <-c.queue:
		var reply map[string]string
		if err := json.Unmarshal(m.data, &reply); err != nil {
			t.Fatal(err)
		}
		if reply["type"] != "clipboard" {
			t.Fatalf("wrong response: %s", m.data)
		}
		return reply
	case <-time.After(time.Second):
		t.Fatal("clipboard response missing")
		return nil
	}
}

func TestDeviceControlsArePreciselyFramed(t *testing.T) {
	for _, b := range [][]byte{{5}, {6}, {7}, {11}, {8, 0}, {10, 0}, {10, 1}, append([]byte{16, 20}, []byte("com.android.settings")...)} {
		if !validControl(b) {
			t.Fatalf("rejected control: %v", b)
		}
		if validControl(append(append([]byte(nil), b...), 0)) {
			t.Fatalf("accepted trailing bytes: %v", b)
		}
	}
	for _, b := range [][]byte{{8}, {8, 1}, {8, 2}, {10}, {10, 2}, {12}, {13}, {14}, {15}, {17}, {18}, {21}, {22}} {
		if validControl(b) {
			t.Fatalf("unsupported control accepted: %v", b)
		}
	}
	for _, name := range []string{"", "com", "com..app", "com.app;reboot", "com.app/activity", "+com.app", "?Settings", "com.应用", "com.1app", "com.app\n", strings.Repeat("a", 256) + ".app"} {
		b := append([]byte{16, byte(len(name))}, name...)
		if validControl(b) {
			t.Fatalf("invalid package accepted: %q", name)
		}
	}
	clip := make([]byte, 14)
	clip[0] = 9
	if !validControl(clip) {
		t.Fatal("setting empty clipboard without pasting rejected")
	}
}

func TestManualClipboardReplyIsPrivate(t *testing.T) {
	h := newHub(nil)
	conn := &controlRecorder{}
	h.setControl(conn)
	defer h.setControl(nil)
	a, b := clipboardTestClient(h), clipboardTestClient(h)
	h.deliverClipboard(conn, "unsolicited secret")
	if len(a.queue) != 0 || len(b.queue) != 0 {
		t.Fatal("unsolicited clipboard leaked")
	}
	if err := h.sendControl(a, []byte{8, 0}); err != nil {
		t.Fatal(err)
	}
	if err := h.sendControl(b, []byte{8, 0}); err == nil || conn.Len() != 2 {
		t.Fatal("overlapping untagged requests accepted")
	}
	h.deliverClipboard(conn, "剪贴板🔒")
	if got := readClipboardReply(t, a); got["text"] != "剪贴板🔒" {
		t.Fatal(got)
	}
	if len(b.queue) != 0 {
		t.Fatal("clipboard broadcast to other viewer")
	}
	if err := h.sendControl(b, []byte{8, 0}); err != nil {
		t.Fatal("completed request did not release slot", err)
	}
	h.deliverClipboard(conn, "")
	if got := readClipboardReply(t, b); got["error"] != "" || got["text"] != "" {
		t.Fatal("empty clipboard is a valid response", got)
	}
}

func TestClipboardTimeoutClosesGenerationAndDiscardsLateReplies(t *testing.T) {
	for _, disconnect := range []bool{false, true} {
		h := newHub(nil)
		conn := &controlRecorder{}
		h.setControl(conn)
		a, b := clipboardTestClient(h), clipboardTestClient(h)
		if err := h.sendControl(a, []byte{8, 0}); err != nil {
			t.Fatal(err)
		}
		request := h.clipboard
		if disconnect {
			h.remove(a)
		}
		if !request.timer.Stop() {
			t.Fatal("disconnect disabled the pending request deadline")
		}
		// Invoke the timer callback directly to test the deadline without a
		// five-second sleep. A disconnected owner must not stop this deadline.
		h.expireClipboard(request)
		if !conn.closed {
			t.Fatal("timed-out generation left its control stream open")
		}
		if !disconnect {
			if got := readClipboardReply(t, a); !strings.Contains(got["error"], "重新建立") || !strings.Contains(got["error"], "录制会结束") {
				t.Fatal("timeout omitted restart and recording warning", got)
			}
		}
		if h.clipboard != request || request.owner != nil {
			t.Fatal("timeout must retain an ownerless tombstone until the generation ends")
		}
		if err := h.sendControl(b, []byte{8, 0}); err == nil {
			t.Fatal("late response could be assigned to a different viewer")
		}
		// Simulate the capture restart after consumeDeviceMessages observes
		// the closed socket; a response already decoded by the old goroutine
		// must never satisfy this new generation's request.
		next := &controlRecorder{}
		h.setControl(next)
		if err := h.sendControl(b, []byte{8, 0}); err != nil {
			t.Fatal("new generation did not unblock manual reading", err)
		}
		h.deliverClipboard(conn, "old private text")
		if len(b.queue) != 0 {
			t.Fatal("late response leaked")
		}
		h.expireClipboard(request)
		if next.closed {
			t.Fatal("old timer closed a newer generation")
		}
		h.deliverClipboard(next, "new response")
		if got := readClipboardReply(t, b); got["text"] != "new response" {
			t.Fatal("old timer expired a newer request", got)
		}
		h.setControl(nil)
	}
}

func TestClipboardDisconnectAllowsReplyBeforeDeadline(t *testing.T) {
	h := newHub(nil)
	conn := &controlRecorder{}
	h.setControl(conn)
	defer h.setControl(nil)
	a, b := clipboardTestClient(h), clipboardTestClient(h)
	if err := h.sendControl(a, []byte{8, 0}); err != nil {
		t.Fatal(err)
	}
	request := h.clipboard
	h.remove(a)
	h.deliverClipboard(conn, "discard disconnected user's response")
	h.expireClipboard(request)
	if conn.closed {
		t.Fatal("completed tombstone unnecessarily restarted capture")
	}
	if err := h.sendControl(b, []byte{8, 0}); err != nil {
		t.Fatal(err)
	}
	h.deliverClipboard(conn, "new response")
	if got := readClipboardReply(t, b); got["text"] != "new response" {
		t.Fatal(got)
	}
}

func TestClipboardTimeoutInterruptsDeviceMessageReader(t *testing.T) {
	h := newHub(nil)
	ctrl, device := net.Pipe()
	defer ctrl.Close()
	defer device.Close()
	h.setControl(ctrl)
	defer h.setControl(nil)
	c := clipboardTestClient(h)
	readDone := make(chan error, 1)
	go func() { readDone <- consumeDeviceMessages(ctrl, h) }()
	requestReceived := make(chan struct{})
	go func() { var b [2]byte; io.ReadFull(device, b[:]); close(requestReceived) }()
	if err := h.sendControl(c, []byte{8, 0}); err != nil {
		t.Fatal(err)
	}
	<-requestReceived
	h.controlMu.Lock()
	request := h.clipboard
	h.controlMu.Unlock()
	h.expireClipboard(request)
	select {
	case err := <-readDone:
		if err == nil {
			t.Fatal("closed control reader returned no error")
		}
	case <-time.After(time.Second):
		t.Fatal("clipboard timeout did not unblock capture's device message reader")
	}
}

func TestClipboardGenerationIsolation(t *testing.T) {
	h := newHub(nil)
	old, next := &controlRecorder{}, &controlRecorder{}
	h.setControl(old)
	c := clipboardTestClient(h)
	if err := h.sendControl(c, []byte{8, 0}); err != nil {
		t.Fatal(err)
	}
	h.setControl(next)
	if got := readClipboardReply(t, c); got["error"] == "" {
		t.Fatal("restarted request not completed with error")
	}
	if err := h.sendControl(c, []byte{8, 0}); err != nil {
		t.Fatal(err)
	}
	h.deliverClipboard(old, "previous session")
	if len(c.queue) != 0 {
		t.Fatal("old generation response accepted")
	}
	h.deliverClipboard(next, "current session")
	if got := readClipboardReply(t, c); got["text"] != "current session" {
		t.Fatal(got)
	}
	h.setControl(nil)
}

func TestDeviceMessageParserBoundariesAndAlignment(t *testing.T) {
	oversize := clipboardDevicePacket("")
	binary.BigEndian.PutUint32(oversize[1:], maxDeviceClipboard+1)
	ack := append([]byte{1}, make([]byte, 8)...)
	uhid := []byte{2, 0, 1, 0, 3, 1, 2, 3}
	for name, input := range map[string][]byte{
		"clipboard":        clipboardDevicePacket("hello 世界"),
		"mixed":            append(append(ack, uhid...), clipboardDevicePacket("aligned")...),
		"max":              clipboardDevicePacket(strings.Repeat("x", maxDeviceClipboard)),
		"oversize":         oversize,
		"unknown":          {3},
		"truncated_header": {0, 0},
		"truncated_text":   {0, 0, 0, 0, 2, 1},
		"invalid_utf8":     {0, 0, 0, 0, 1, 255},
		"truncated_ack":    {1, 0},
		"truncated_uhid":   {2, 0, 1, 0, 2, 0},
	} {
		t.Run(name, func(t *testing.T) {
			h := newHub(nil)
			conn := &readOnlyDeviceConn{Reader: bytes.NewReader(input)}
			err := consumeDeviceMessages(conn, h)
			if name == "clipboard" || name == "mixed" || name == "max" {
				if err != io.EOF {
					t.Fatal("valid stream did not finish on frame boundary", err)
				}
			} else if err == nil || err == io.EOF {
				t.Fatal("malformed frame not rejected", err)
			}
		})
	}
}

type readOnlyDeviceConn struct{ *bytes.Reader }

func (c *readOnlyDeviceConn) Write([]byte) (int, error)        { return 0, io.ErrClosedPipe }
func (c *readOnlyDeviceConn) Close() error                     { return nil }
func (c *readOnlyDeviceConn) LocalAddr() net.Addr              { return nil }
func (c *readOnlyDeviceConn) RemoteAddr() net.Addr             { return nil }
func (c *readOnlyDeviceConn) SetDeadline(time.Time) error      { return nil }
func (c *readOnlyDeviceConn) SetReadDeadline(time.Time) error  { return nil }
func (c *readOnlyDeviceConn) SetWriteDeadline(time.Time) error { return nil }

func TestClipboardConcurrentRequestOwnership(t *testing.T) {
	h := newHub(nil)
	conn := &controlRecorder{}
	h.setControl(conn)
	defer h.setControl(nil)
	var wg sync.WaitGroup
	var accepted atomic.Int32
	var clients []*client
	for i := 0; i < 16; i++ {
		clients = append(clients, clipboardTestClient(h))
	}
	for _, c := range clients {
		wg.Add(1)
		go func(c *client) {
			defer wg.Done()
			if h.sendControl(c, []byte{8, 0}) == nil {
				accepted.Add(1)
			}
		}(c)
	}
	wg.Wait()
	if accepted.Load() != 1 {
		t.Fatalf("accepted %d simultaneous requests", accepted.Load())
	}
	h.deliverClipboard(conn, "one owner")
	responses := 0
	for _, c := range clients {
		responses += len(c.queue)
	}
	if responses != 1 {
		t.Fatalf("private response delivered %d times", responses)
	}
}

func TestDisplayPowerRestoresOnlyWhenUnwatched(t *testing.T) {
	h := newHub(nil)
	conn := &controlRecorder{}
	h.setControl(conn)
	a, b := clipboardTestClient(h), clipboardTestClient(h)
	if err := h.sendControl(a, []byte{10, 0}); err != nil {
		t.Fatal(err)
	}
	h.remove(a)
	if !bytes.Equal(conn.Bytes(), []byte{10, 0}) {
		t.Fatal("display restored while another viewer remained")
	}
	h.remove(b)
	if !bytes.Equal(conn.Bytes(), []byte{10, 0, 10, 1}) {
		t.Fatal("display not restored on final disconnect")
	}
	h.setControl(nil)
	if conn.Len() != 4 {
		t.Fatal("unneeded second power change")
	}
}

type orderedPowerConn struct {
	controlRecorder
	ctx    context.Context
	events chan string
}

func (c *orderedPowerConn) Write(b []byte) (int, error) {
	if bytes.Equal(b, []byte{10, 1}) {
		if c.ctx.Err() != nil {
			c.events <- "restore_after_cancel"
		} else {
			c.events <- "restore"
		}
	}
	return c.controlRecorder.Write(b)
}

func TestDisplayRestorationPrecedesShutdownAndZeroIdleCancellation(t *testing.T) {
	for _, idle := range []bool{false, true} {
		t.Run(map[bool]string{false: "shutdown", true: "zero_idle"}[idle], func(t *testing.T) {
			h := newHub(nil)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			events := make(chan string, 4)
			conn := &orderedPowerConn{ctx: ctx, events: events}
			h.setControl(conn)
			c := clipboardTestClient(h)
			h.limits.IdleSeconds = 0
			h.cancel = func() { events <- "cancel"; cancel(); conn.Close() }
			if err := h.sendControl(c, []byte{10, 0}); err != nil {
				t.Fatal(err)
			}
			if idle {
				h.remove(c)
			} else {
				h.close()
			}
			select {
			case <-ctx.Done():
			case <-time.After(time.Second):
				t.Fatal("capture was not cancelled")
			}
			if first, second := <-events, <-events; first != "restore" || second != "cancel" {
				t.Fatalf("wrong shutdown order: %s then %s", first, second)
			}
			if !idle {
				if err := h.sendControl(c, []byte{10, 0}); err == nil {
					t.Fatal("shutdown accepted another display-off command")
				}
			}
		})
	}
}

func TestReadOnlyBlocksAllDeviceTools(t *testing.T) {
	c := defaults()
	c.Token, c.ReadOnly = strings.Repeat("a", 64), true
	ready := make(chan struct{})
	conn := &controlRecorder{}
	h := newHub(func(ctx context.Context, h *hub) error {
		h.setControl(conn)
		defer h.setControl(nil)
		close(ready)
		<-ctx.Done()
		return ctx.Err()
	})
	defer h.close()
	srv := httptest.NewServer(routes(c, h))
	defer srv.Close()
	dialer := websocket.Dialer{Subprotocols: []string{"uficpy-v2", c.Token}}
	ws, _, err := dialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"/ws", http.Header{"Origin": []string{srv.URL}})
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	<-ready
	clipboard := make([]byte, 14)
	clipboard[0] = 9
	for _, control := range [][]byte{{5}, {6}, {7}, {8, 0}, clipboard, {10, 0}, {11}, append([]byte{16, 20}, []byte("com.android.settings")...)} {
		if err = ws.WriteMessage(websocket.BinaryMessage, control); err != nil {
			t.Fatal(err)
		}
	}
	if err = ws.WriteMessage(websocket.TextMessage, []byte(`{"type":"ping","id":123}`)); err != nil {
		t.Fatal(err)
	}
	ws.SetReadDeadline(time.Now().Add(time.Second))
	for {
		_, data, err := ws.ReadMessage()
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(data), `"pong"`) {
			break
		}
	}
	h.controlMu.Lock()
	defer h.controlMu.Unlock()
	if conn.Len() != 0 || h.clipboard != nil || h.displayOff {
		t.Fatal("read-only viewer changed device state or read private clipboard")
	}
}
