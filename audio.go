package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"time"
)

// scrcpy v5.0.1 AudioConfig and AudioRawRecorder specify 48 kHz stereo,
// signed 16-bit little-endian PCM, in blocks of at most 1024 stereo samples.
const audioSampleRate = 48000
const audioChannels = 2
const maxAudioPacket = 4096
const rawAudioCodecID = 0x00726177
const h264CodecID = 0x68323634

var errStreamDisabled = errors.New("设备未能开启采集；音频需要 Android 11 或更新版本，Android 11 启动时须解锁屏幕，请检查服务日志")
var errStreamConfiguration = errors.New("设备报告采集配置错误，请检查服务日志")

// Disabled audio is a four-byte codec marker, not a frame. Reading it before
// the frame header avoids waiting forever for the other eight bytes on devices
// which keep the disabled audio socket open while video/control continue.
func readStreamCodec(r io.Reader, expected uint32) error {
	var b [4]byte
	if _, err := io.ReadFull(r, b[:]); err != nil {
		return err
	}
	switch codec := binary.BigEndian.Uint32(b[:]); codec {
	case 0:
		return errStreamDisabled
	case 1:
		return errStreamConfiguration
	default:
		if codec != expected {
			return fmt.Errorf("非预期流格式 0x%08x", codec)
		}
	}
	return nil
}

// Audio needs send_stream_meta=true for an unambiguous success/failure header.
// This also enables video session metadata; strip that metadata on the backend
// so the existing browser H.264 protocol is unchanged (including rotations).
func readCaptureVideoPacket(r io.Reader, streamMeta bool) (packet, error) {
	if !streamMeta {
		return readPacket(r)
	}
	for {
		var header [12]byte
		if _, err := io.ReadFull(r, header[:]); err != nil {
			return packet{}, err
		}
		if binary.BigEndian.Uint64(header[:8])&(1<<63) != 0 {
			w := binary.BigEndian.Uint32(header[4:8])
			h := binary.BigEndian.Uint32(header[8:12])
			if w == 0 || h == 0 || w > 65535 || h > 65535 {
				return packet{}, fmt.Errorf("无效视频会话尺寸 %dx%d", w, h)
			}
			continue
		}
		return readPacket(io.MultiReader(bytes.NewReader(header[:]), r))
	}
}

func readAudioPacket(r io.Reader) ([]byte, error) {
	var header [12]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return nil, err
	}
	pts := binary.BigEndian.Uint64(header[:8])
	n := binary.BigEndian.Uint32(header[8:])
	if pts&(uint64(7)<<61) != 0 || n > maxAudioPacket || n%4 != 0 {
		return nil, fmt.Errorf("无效 PCM 音频包（长度 %d）", n)
	}
	// UFIA cannot collide with our video stream header: its top bits would
	// describe a config packet, whose first eight bytes must be exactly 1<<62.
	b := make([]byte, 12+int(n))
	copy(b[:4], "UFIA")
	binary.BigEndian.PutUint64(b[4:12], pts)
	if _, err := io.ReadFull(r, b[12:]); err != nil {
		return nil, err
	}
	return b, nil
}

func consumeAudio(ctx context.Context, conn net.Conn, h *hub) {
	defer conn.Close()
	h.audioStatus("starting", "正在开启设备声音采集")
	conn.SetReadDeadline(time.Now().Add(15 * time.Second))
	if err := readStreamCodec(conn, rawAudioCodecID); err != nil {
		if ctx.Err() == nil {
			state := "error"
			if errors.Is(err, errStreamDisabled) {
				state = "unavailable"
			}
			h.audioStatus(state, err.Error())
		}
		return
	}
	first := true
	for ctx.Err() == nil {
		conn.SetReadDeadline(time.Now().Add(30 * time.Second))
		b, err := readAudioPacket(conn)
		if err != nil {
			if ctx.Err() == nil {
				h.audioStatus("error", "音频流已停止，视频和控制仍可使用："+err.Error())
			}
			return
		}
		if len(b) == 12 {
			continue // AudioRecord may report a zero-length read.
		}
		if first {
			first = false
			h.audioStatus("streaming", "设备声音已连接，请点击开启声音")
		}
		h.publishAudio(b)
	}
}

func (h *hub) audioStatus(state, detail string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	b, _ := json.Marshal(map[string]any{"type": "audio-status", "state": state, "detail": detail, "sample_rate": audioSampleRate, "channels": audioChannels, "format": "s16le"})
	for c := range h.clients {
		h.enqueue(c, message{1, b})
	}
}

func (h *hub) publishAudio(b []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.clients {
		// Audio is live-only and never added to the video GOP. Do not let a
		// slow websocket accumulate seconds of audio or evict video frames.
		if len(c.queue) >= 12 || c.queued > 1<<20 {
			continue
		}
		h.enqueue(c, message{2, b})
	}
}
