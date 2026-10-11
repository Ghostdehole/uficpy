package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"sync"
	"time"
)

type message struct {
	kind int
	data []byte
}
type client struct {
	queue       chan message
	queued      int
	ready       bool
	controlConn net.Conn
	touches     map[uint64][]byte
	keys        map[uint32][]byte
}
type hub struct {
	limits           Config
	mu               sync.Mutex
	clients          map[*client]bool
	config           []byte
	gop              [][]byte
	gopBytes         int
	collectingConfig bool
	nextPointer      uint64
	activePointers   int
	heldKeys         map[uint32]int
	cancel           context.CancelFunc
	idle             *time.Timer
	stopped          bool
	state, lastError string
	packets, bytes   uint64
	control          net.Conn
	controlMu        sync.Mutex
	runner           func(context.Context, *hub) error
	done             chan struct{}
}

func newHub(runner func(context.Context, *hub) error) *hub {
	return &hub{clients: make(map[*client]bool), state: "idle", runner: runner, limits: defaults()}
}
func (h *hub) enqueue(c *client, m message) bool {
	if !h.clients[c] {
		return false
	}
	if c.queued+len(m.data) > h.limits.QueueMB<<20 || len(c.queue) == cap(c.queue) {
		delete(h.clients, c)
		close(c.queue)
		return false
	}
	c.queued += len(m.data)
	c.queue <- m
	return true
}
func (h *hub) status(state, detail string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.state = state
	if state == "error" {
		h.lastError = detail
		log.Printf("capture error: %s", detail)
	}
	b, _ := json.Marshal(map[string]string{"type": "status", "state": state, "detail": detail})
	for c := range h.clients {
		h.enqueue(c, message{1, b})
	}
}
func (h *hub) add() *client {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.clients) >= h.limits.MaxClients {
		return nil
	}
	c := &client{queue: make(chan message, 256)}
	if h.stopped {
		close(c.queue)
		return c
	}
	h.clients[c] = true
	if h.idle != nil {
		h.idle.Stop()
		h.idle = nil
	}
	if len(h.gop) > 0 && h.config != nil {
		h.enqueue(c, message{2, h.config})
		for _, p := range h.gop {
			if !h.enqueue(c, message{2, p}) {
				break
			}
		}
		c.ready = true
	}
	if h.cancel == nil {
		ctx, cancel := context.WithCancel(context.Background())
		h.cancel = cancel
		h.done = make(chan struct{})
		go h.run(ctx)
	}
	return c
}
func (h *hub) remove(c *client) {
	h.releaseControls(c)
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.clients[c] {
		delete(h.clients, c)
		close(c.queue)
	}
	if len(h.clients) == 0 && h.idle == nil && h.cancel != nil {
		h.idle = time.AfterFunc(time.Duration(h.limits.IdleSeconds)*time.Second, func() {
			h.mu.Lock()
			defer h.mu.Unlock()
			h.idle = nil
			if len(h.clients) == 0 && h.cancel != nil {
				h.cancel()
			}
		})
	}
}
func (h *hub) run(ctx context.Context) {
	defer func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		h.cancel = nil
		h.config = nil
		h.collectingConfig = false
		h.gop = nil
		h.gopBytes = 0
		h.state = "idle"
		close(h.done)
		// A new viewer may have arrived after the idle timer cancelled this generation.
		if len(h.clients) > 0 && !h.stopped {
			nctx, cancel := context.WithCancel(context.Background())
			h.cancel = cancel
			h.done = make(chan struct{})
			go h.run(nctx)
		}
	}()
	for ctx.Err() == nil {
		h.mu.Lock()
		h.config = nil
		h.collectingConfig = false
		h.gop = nil
		h.gopBytes = 0
		for c := range h.clients {
			c.ready = false
		}
		h.mu.Unlock()
		h.status("starting", "正在启动采集进程")
		err := h.runner(ctx, h)
		if ctx.Err() != nil {
			return
		}
		if err == nil {
			err = fmt.Errorf("采集进程已结束")
		}
		h.status("error", err.Error())
		select {
		case <-ctx.Done():
			return
		case <-time.After(2 * time.Second):
		}
	}
}
func (h *hub) publish(p packet) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.packets++
	h.bytes += uint64(len(p.data))
	if p.config {
		if h.collectingConfig && len(h.config)+len(p.data)-12 <= 65536 {
			joined := make([]byte, len(h.config)+len(p.data)-12)
			copy(joined, h.config)
			copy(joined[len(h.config):], p.data[12:])
			binary.BigEndian.PutUint32(joined[8:12], uint32(len(joined)-12))
			h.config = joined
		} else {
			h.config = p.data
		}
		h.collectingConfig = true
		h.gop = nil
		h.gopBytes = 0
		for c := range h.clients {
			c.ready = false
		}
		return
	}
	h.collectingConfig = false
	if p.key {
		h.gop = nil
		h.gopBytes = 0
	}
	if p.key || len(h.gop) > 0 {
		if h.gopBytes+len(p.data) <= h.limits.GOPMB<<20 && len(h.gop) < 240 {
			h.gop = append(h.gop, p.data)
			h.gopBytes += len(p.data)
		} else {
			h.gop = nil
			h.gopBytes = 0
		}
	}
	for c := range h.clients {
		if !c.ready {
			if !p.key || h.config == nil {
				continue
			}
			if !h.enqueue(c, message{2, h.config}) {
				continue
			}
			c.ready = true
		}
		h.enqueue(c, message{2, p.data})
	}
}
func (h *hub) health() map[string]any {
	h.mu.Lock()
	defer h.mu.Unlock()
	return map[string]any{"service": "uficpy", "version": appVersion, "core_version": coreLock.Version, "capture": h.state, "last_error": h.lastError, "clients": len(h.clients), "packets": h.packets, "bytes": h.bytes}
}
func (h *hub) setControl(c net.Conn) {
	h.controlMu.Lock()
	defer h.controlMu.Unlock()
	h.control = c
	h.activePointers = 0
	h.heldKeys = make(map[uint32]int)
}

// All clients share one Android input device. Remap each browser pointer to a
// unique positive scrcpy ID, and share held keys until the last owner releases.
// controlMu protects both the socket and every client's input state.
func (h *hub) sendControl(c *client, b []byte) error {
	h.controlMu.Lock()
	defer h.controlMu.Unlock()
	if h.control == nil {
		return fmt.Errorf("控制通道未就绪")
	}
	if c.controlConn != h.control {
		c.controlConn = h.control
		c.touches = make(map[uint64][]byte)
		c.keys = make(map[uint32][]byte)
	}
	if b[0] == 2 {
		id := binary.BigEndian.Uint64(b[2:10])
		previous, exists := c.touches[id]
		if !exists && b[1] != 0 {
			// Ignore stale move/up messages after a capture restart or lost focus.
			return nil
		}
		if exists && b[1] == 0 {
			return nil
		}
		if !exists && h.activePointers >= 10 {
			return fmt.Errorf("同时触控最多支持 10 个触点")
		}
		b = append([]byte(nil), b...)
		if exists {
			copy(b[2:10], previous[2:10])
		} else {
			h.nextPointer++
			binary.BigEndian.PutUint64(b[2:10], h.nextPointer)
			h.activePointers++
		}
		if b[1] == 1 {
			delete(c.touches, id)
			h.activePointers--
		} else {
			c.touches[id] = b
		}
	}
	if b[0] == 0 {
		key := binary.BigEndian.Uint32(b[2:6])
		_, held := c.keys[key]
		if b[1] == 0 {
			if held {
				return nil
			}
			c.keys[key] = append([]byte(nil), b...)
			h.heldKeys[key]++
			if h.heldKeys[key] > 1 {
				return nil
			}
		} else {
			if !held {
				return nil
			}
			delete(c.keys, key)
			h.heldKeys[key]--
			if h.heldKeys[key] > 0 {
				return nil
			}
			delete(h.heldKeys, key)
		}
	}
	h.control.SetWriteDeadline(time.Now().Add(time.Second))
	n, e := h.control.Write(b)
	if e == nil && n != len(b) {
		e = io.ErrShortWrite
	}
	if e != nil {
		// A partial control frame corrupts this stream. End this generation so
		// subsequent frames cannot be interpreted as the missing bytes.
		h.control.Close()
	}
	return e
}
func (h *hub) close() {
	h.mu.Lock()
	h.stopped = true
	if h.idle != nil {
		h.idle.Stop()
	}
	if h.cancel != nil {
		h.cancel()
	}
	d := h.done
	for c := range h.clients {
		delete(h.clients, c)
		close(c.queue)
	}
	h.mu.Unlock()
	if d != nil {
		<-d
	}
}

// Release every held pointer/key when a viewer disconnects. Old-generation
// input is never injected into a newly created capture session.
func (h *hub) releaseControls(c *client) {
	h.controlMu.Lock()
	defer h.controlMu.Unlock()
	if c.controlConn == h.control && h.control != nil {
		h.control.SetWriteDeadline(time.Now().Add(time.Second))
		writeRelease := func(b []byte) {
			n, e := h.control.Write(b)
			if e != nil || n != len(b) {
				h.control.Close()
			}
		}
		for _, touch := range c.touches {
			b := append([]byte(nil), touch...)
			b[1] = 1
			binary.BigEndian.PutUint16(b[22:24], 0)
			writeRelease(b)
			h.activePointers--
		}
		for key, down := range c.keys {
			h.heldKeys[key]--
			if h.heldKeys[key] == 0 {
				delete(h.heldKeys, key)
				b := append([]byte(nil), down...)
				b[1] = 1
				writeRelease(b)
			}
		}
	}
	c.touches = nil
	c.keys = nil
	c.controlConn = nil
}
