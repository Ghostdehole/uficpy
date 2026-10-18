package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"net"
	"strings"
	"testing"
	"time"
)

func TestAudioNegotiationAndPCMFraming(t *testing.T) {
	for _, tc := range []struct {
		codec uint32
		err   error
	}{{rawAudioCodecID, nil}, {0, errStreamDisabled}, {1, errStreamConfiguration}} {
		var header [4]byte
		binary.BigEndian.PutUint32(header[:], tc.codec)
		if err := readStreamCodec(bytes.NewReader(header[:]), rawAudioCodecID); !errors.Is(err, tc.err) {
			t.Fatalf("codec %d: %v", tc.codec, err)
		}
	}
	if readStreamCodec(bytes.NewReader([]byte("opus")), rawAudioCodecID) == nil {
		t.Fatal("unexpected codec accepted")
	}
	pcm := []byte{0, 128, 255, 127, 0, 0, 0, 64}
	b, err := readAudioPacket(bytes.NewReader(makePacket(123456, pcm).data))
	if err != nil || string(b[:4]) != "UFIA" || binary.BigEndian.Uint64(b[4:12]) != 123456 || !bytes.Equal(b[12:], pcm) {
		t.Fatalf("PCM framing changed samples or timestamp: %x %v", b, err)
	}
	if empty, err := readAudioPacket(bytes.NewReader(makePacket(0, nil).data)); err != nil || len(empty) != 12 {
		t.Fatalf("zero-length AudioRecord read rejected: %v", err)
	}
	for _, bad := range [][]byte{
		{}, makePacket(0, []byte{1, 2}).data,
		makePacket(configFlag, pcm).data, makePacket(keyFlag, pcm).data,
		makePacket(0, make([]byte, maxAudioPacket+4)).data,
		makePacket(0, pcm).data[:15],
	} {
		if _, err = readAudioPacket(bytes.NewReader(bad)); err == nil {
			t.Fatal("accepted malformed audio packet")
		}
	}
}

func TestAudioDisabledMarkerDoesNotWaitForFrameOrCancelVideo(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	h := newHub(nil)
	c := &client{queue: make(chan message, 16)}
	h.clients[c] = true
	reader, writer := net.Pipe()
	defer writer.Close()
	done := make(chan struct{})
	go func() { consumeAudio(ctx, reader, h); close(done) }()
	if _, err := writer.Write([]byte{0, 0, 0, 0}); err != nil {
		t.Fatal(err)
	}
	// Keep the writer open, matching scrcpy's disabled-audio behavior.
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("disabled audio blocked waiting for a frame header")
	}
	if ctx.Err() != nil {
		t.Fatal("audio failure canceled the video session")
	}
	var status map[string]any
	for len(c.queue) > 0 {
		if err := json.Unmarshal((<-c.queue).data, &status); err != nil {
			t.Fatal(err)
		}
	}
	if status["type"] != "audio-status" || status["state"] != "unavailable" {
		t.Fatalf("missing actionable audio status: %v", status)
	}
	h.publish(makePacket(configFlag, []byte{7}))
	h.publish(makePacket(keyFlag|100, []byte{5}))
	if len(c.queue) != 2 {
		t.Fatal("video did not continue after audio was disabled")
	}
}

func TestVideoSessionMetadataIsStrippedWithAudio(t *testing.T) {
	var session [12]byte
	binary.BigEndian.PutUint32(session[:4], 0x80000000)
	binary.BigEndian.PutUint32(session[4:8], 720)
	binary.BigEndian.PutUint32(session[8:12], 1280)
	p := makePacket(configFlag, []byte{0, 0, 0, 1, 7})
	r := bytes.NewReader(append(append(session[:], p.data...), append(session[:], p.data...)...))
	for i := 0; i < 2; i++ {
		got, err := readCaptureVideoPacket(r, true)
		if err != nil || !bytes.Equal(got.data, p.data) {
			t.Fatalf("session header broke video: %v", err)
		}
	}
	if _, err := readCaptureVideoPacket(bytes.NewReader(session[:]), false); err == nil {
		t.Fatal("legacy video protocol silently accepted unexpected metadata")
	}
	binary.BigEndian.PutUint32(session[4:8], 0)
	if _, err := readCaptureVideoPacket(bytes.NewReader(session[:]), true); err == nil {
		t.Fatal("invalid session dimensions accepted")
	}
}

func TestAudioIsOptInAndQueuesAreBounded(t *testing.T) {
	cfg := defaults()
	if !cfg.NoAudio || cfg.AudioSource != "output" {
		t.Fatal("audio must stay disabled on upgrade")
	}
	args := strings.Join(captureArgs(cfg, 1), " ")
	if !strings.Contains(args, "audio=false") || !strings.Contains(args, "send_stream_meta=false") || strings.Contains(args, "audio_codec=") {
		t.Fatal("legacy capture arguments changed")
	}
	cfg.NoAudio = false
	cfg.AudioSource = "mic"
	if err := cfg.validate(false); err != nil {
		t.Fatal(err)
	}
	args = strings.Join(captureArgs(cfg, 1), " ")
	for _, expected := range []string{"audio=true", "send_stream_meta=true", "audio_codec=raw", "audio_source=mic"} {
		if !strings.Contains(args, expected) {
			t.Fatalf("missing %s", expected)
		}
	}
	cfg.AudioSource = "voice-call"
	if cfg.validate(false) == nil {
		t.Fatal("unimplemented source accepted")
	}
	h := newHub(nil)
	c := &client{queue: make(chan message, 256)}
	h.clients[c] = true
	for i := 0; i < 1000; i++ {
		h.publishAudio(make([]byte, 4108))
	}
	if len(c.queue) != 12 || !h.clients[c] || len(h.gop) != 0 {
		t.Fatal("audio buffered too much, disconnected the client, or polluted the GOP")
	}
}
