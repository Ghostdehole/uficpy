package main

import (
	"bytes"
	"encoding/binary"
	"io"
	"net"
	"testing"
	"time"
)

type controlRecorder struct {
	bytes.Buffer
	closed bool
	short  bool
}

func (c *controlRecorder) Read([]byte) (int, error) { return 0, io.EOF }
func (c *controlRecorder) Write(p []byte) (int, error) {
	if c.closed {
		return 0, net.ErrClosed
	}
	if c.short {
		return len(p) - 1, nil
	}
	return c.Buffer.Write(p)
}
func (c *controlRecorder) Close() error                     { c.closed = true; return nil }
func (c *controlRecorder) LocalAddr() net.Addr              { return nil }
func (c *controlRecorder) RemoteAddr() net.Addr             { return nil }
func (c *controlRecorder) SetDeadline(time.Time) error      { return nil }
func (c *controlRecorder) SetReadDeadline(time.Time) error  { return nil }
func (c *controlRecorder) SetWriteDeadline(time.Time) error { return nil }

func touchControl(id uint64, action byte) []byte {
	b := make([]byte, 32)
	b[0], b[1] = 2, action
	binary.BigEndian.PutUint64(b[2:10], id)
	binary.BigEndian.PutUint16(b[18:20], 720)
	binary.BigEndian.PutUint16(b[20:22], 1280)
	if action != 1 {
		binary.BigEndian.PutUint16(b[22:24], 0xffff)
	}
	return b
}

func keyControl(key uint32, action byte) []byte {
	b := make([]byte, 14)
	b[1] = action
	binary.BigEndian.PutUint32(b[2:6], key)
	return b
}

func TestMultiTouchIsolationAndRelease(t *testing.T) {
	h := newHub(nil)
	conn := &controlRecorder{}
	h.setControl(conn)
	a, b := &client{}, &client{}
	for _, event := range []struct {
		client *client
		id     uint64
	}{{a, 1}, {a, 2}, {b, 1}} {
		if e := h.sendControl(event.client, touchControl(event.id, 0)); e != nil {
			t.Fatal(e)
		}
	}
	ids := make(map[uint64]bool)
	for _, offset := range []int{0, 32, 64} {
		id := binary.BigEndian.Uint64(conn.Bytes()[offset+2 : offset+10])
		if ids[id] || id == 0 {
			t.Fatal("touch IDs collide across fingers/clients")
		}
		ids[id] = true
	}
	second := binary.BigEndian.Uint64(conn.Bytes()[34:42])
	conn.Reset()
	if e := h.sendControl(a, touchControl(2, 2)); e != nil {
		t.Fatal(e)
	}
	if got := binary.BigEndian.Uint64(conn.Bytes()[2:10]); got != second {
		t.Fatalf("pointer identity changed during move: %d != %d", got, second)
	}
	conn.Reset()
	h.releaseControls(a)
	if conn.Len() != 64 || h.activePointers != 1 {
		t.Fatalf("not all disconnected client's touches released: bytes=%d pointers=%d", conn.Len(), h.activePointers)
	}
	for _, offset := range []int{0, 32} {
		if conn.Bytes()[offset+1] != 1 || binary.BigEndian.Uint16(conn.Bytes()[offset+22:offset+24]) != 0 {
			t.Fatal("release must send UP with zero pressure")
		}
	}
	conn.Reset()
	h.releaseControls(b)
	if conn.Len() != 32 || h.activePointers != 0 {
		t.Fatal("second client touch was not isolated")
	}
}

func TestTouchLimitAndCaptureGeneration(t *testing.T) {
	h := newHub(nil)
	old := &controlRecorder{}
	h.setControl(old)
	c := &client{}
	for i := uint64(0); i < 10; i++ {
		if e := h.sendControl(c, touchControl(i, 0)); e != nil {
			t.Fatal(e)
		}
	}
	other := &client{}
	if e := h.sendControl(other, touchControl(0, 0)); e == nil || old.Len() != 320 {
		t.Fatal("Android's global 10-pointer limit not enforced")
	}
	if e := h.sendControl(c, touchControl(0, 1)); e != nil {
		t.Fatal(e)
	}
	if e := h.sendControl(other, touchControl(0, 0)); e != nil {
		t.Fatal("released pointer slot not reusable", e)
	}
	next := &controlRecorder{}
	h.setControl(next)
	h.releaseControls(c)
	if next.Len() != 0 || h.activePointers != 0 {
		t.Fatal("old-generation release injected into new capture")
	}
	if e := h.sendControl(other, touchControl(0, 2)); e != nil || next.Len() != 0 {
		t.Fatal("stale move recreated a pointer")
	}
	if e := h.sendControl(other, touchControl(0, 0)); e != nil || next.Len() != 32 {
		t.Fatal("fresh down did not work after capture restart")
	}
}

func TestHeldKeyOwnershipAndRelease(t *testing.T) {
	h := newHub(nil)
	conn := &controlRecorder{}
	h.setControl(conn)
	a, b := &client{}, &client{}
	for _, c := range []*client{a, a, b} {
		if e := h.sendControl(c, keyControl(66, 0)); e != nil {
			t.Fatal(e)
		}
	}
	if conn.Len() != 14 {
		t.Fatal("duplicate held key injected")
	}
	h.releaseControls(a)
	if conn.Len() != 14 {
		t.Fatal("disconnect released another viewer's held key")
	}
	h.releaseControls(b)
	if conn.Len() != 28 || conn.Bytes()[15] != 1 || len(h.heldKeys) != 0 {
		t.Fatal("last owner disconnect did not release key")
	}
	conn.Reset()
	if e := h.sendControl(a, keyControl(24, 0)); e != nil {
		t.Fatal(e)
	}
	if e := h.sendControl(a, keyControl(24, 1)); e != nil {
		t.Fatal(e)
	}
	if conn.Len() != 28 || binary.BigEndian.Uint32(conn.Bytes()[2:6]) != 24 {
		t.Fatal("authorized volume command not forwarded intact")
	}
}

func TestScrollControlBoundary(t *testing.T) {
	b := make([]byte, 21)
	b[0] = 3
	binary.BigEndian.PutUint16(b[9:11], 720)
	binary.BigEndian.PutUint16(b[11:13], 1280)
	binary.BigEndian.PutUint16(b[13:15], 0x8000)
	binary.BigEndian.PutUint16(b[15:17], 0x7fff)
	if !validControl(b) {
		t.Fatal("valid fixed-point scroll rejected")
	}
	h := newHub(nil)
	conn := &controlRecorder{}
	h.setControl(conn)
	if e := h.sendControl(&client{}, b); e != nil || !bytes.Equal(conn.Bytes(), b) {
		t.Fatal("scroll was not forwarded intact", e)
	}
	for _, bad := range [][]byte{b[:20], append(append([]byte(nil), b...), 0)} {
		if validControl(bad) {
			t.Fatal("invalid scroll size accepted")
		}
	}
	b[20] = 1
	if validControl(b) {
		t.Fatal("unapproved mouse button accepted")
	}
	b[20] = 0
	binary.BigEndian.PutUint32(b[1:5], 720)
	if validControl(b) {
		t.Fatal("offscreen scroll accepted")
	}
}

func TestPartialControlWriteClosesCorruptStream(t *testing.T) {
	h := newHub(nil)
	conn := &controlRecorder{short: true}
	h.setControl(conn)
	if e := h.sendControl(&client{}, keyControl(4, 0)); e != io.ErrShortWrite || !conn.closed {
		t.Fatal("partial control stream left usable", e)
	}
}
