package main

import (
	"encoding/binary"
	"fmt"
	"io"
	"unicode/utf8"
)

const maxPacket = 32 << 20
const configFlag uint64 = 1 << 62
const keyFlag uint64 = 1 << 61

type packet struct {
	data        []byte
	config, key bool
}

func readPacket(r io.Reader) (packet, error) {
	h := make([]byte, 12)
	if _, e := io.ReadFull(r, h); e != nil {
		return packet{}, e
	}
	if binary.BigEndian.Uint64(h)&(1<<63) != 0 {
		return packet{}, fmt.Errorf("unexpected session metadata: send_stream_meta must be false")
	}
	n := binary.BigEndian.Uint32(h[8:])
	if n == 0 || n > maxPacket || (binary.BigEndian.Uint64(h)&configFlag != 0 && n > 65536) {
		return packet{}, fmt.Errorf("无效视频包长度 %d (协议错位或版本不兼容)", n)
	}
	b := make([]byte, 12+int(n))
	copy(b, h)
	if _, e := io.ReadFull(r, b[12:]); e != nil {
		return packet{}, e
	}
	flags := binary.BigEndian.Uint64(h)
	return packet{b, flags&configFlag != 0, flags&keyFlag != 0}, nil
}

// Expose touch, scroll, short UTF-8 text and explicitly approved keys.
// Volume keys require their own opt-in even if present in the custom allowlist.
func validControl(b []byte) bool { return validControlFor(b, defaults()) }
func validControlFor(b []byte, c Config) bool {
	if len(b) == 0 {
		return false
	}
	switch b[0] {
	case 0:
		if len(b) != 14 || b[1] > 1 {
			return false
		}
		k := binary.BigEndian.Uint32(b[2:6])
		if binary.BigEndian.Uint32(b[6:10]) != 0 || binary.BigEndian.Uint32(b[10:14]) != 0 {
			return false
		}
		if k == 24 || k == 25 || k == 164 {
			return c.AllowVolumeKeys
		}
		for _, allowed := range c.AllowedKeys {
			if k == allowed {
				return true
			}
		}
		return false
	case 1:
		return len(b) >= 5 && len(b) <= 1029 && int(binary.BigEndian.Uint32(b[1:5])) == len(b)-5 && utf8.Valid(b[5:])
	case 9:
		return len(b) >= 14 && len(b) <= 1038 && binary.BigEndian.Uint64(b[1:9]) == 0 && b[9] <= 1 && int(binary.BigEndian.Uint32(b[10:14])) == len(b)-14 && utf8.Valid(b[14:])
	case 2:
		if len(b) != 32 || b[1] > 2 {
			return false
		}
		x, y := binary.BigEndian.Uint32(b[10:14]), binary.BigEndian.Uint32(b[14:18])
		w, h := binary.BigEndian.Uint16(b[18:20]), binary.BigEndian.Uint16(b[20:22])
		return w > 0 && h > 0 && x < uint32(w) && y < uint32(h) && binary.BigEndian.Uint32(b[24:28]) == 0 && binary.BigEndian.Uint32(b[28:32]) == 0
	case 3:
		if len(b) != 21 {
			return false
		}
		x, y := binary.BigEndian.Uint32(b[1:5]), binary.BigEndian.Uint32(b[5:9])
		w, h := binary.BigEndian.Uint16(b[9:11]), binary.BigEndian.Uint16(b[11:13])
		return w > 0 && h > 0 && x < uint32(w) && y < uint32(h) && binary.BigEndian.Uint32(b[17:21]) == 0
	}
	return false
}
