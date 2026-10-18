package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// This process implements the scrcpy 5.0.1 wire contract using real Linux
// abstract sockets. It does not emulate Android audio APIs or codec output.
const captureAudioProcessFixture = `
import json, os, socket, struct, sys
args = dict(a.split('=', 1) for a in sys.argv[1:] if '=' in a)
assert args['audio'] == 'true'
assert args['audio_codec'] == 'raw'
assert args['audio_source'] == 'output'
assert args['send_stream_meta'] == 'true'
assert args['send_frame_meta'] == 'true'
assert args['send_dummy_byte'] == 'false'
assert args['send_device_meta'] == 'false'
assert args['clipboard_autosync'] == 'false'
name = '\0scrcpy_' + args['scid']
listener = socket.socket(socket.AF_UNIX)
listener.bind(name)
listener.listen(3)
with open(os.environ['UFICPY_AUDIO_TEST_ADDRESS'], 'w') as record:
    json.dump({'address': '@scrcpy_' + args['scid']}, record)
video, _ = listener.accept()
audio, _ = listener.accept()
control, _ = listener.accept()

def frame(conn, pts, payload):
    conn.sendall(struct.pack('>QI', pts, len(payload)) + payload)

def video_session(width, height, pts):
    video.sendall(struct.pack('>III', 0x80000000, width, height))
    frame(video, 1 << 62, b'\x00\x00\x00\x01\x67')
    frame(video, (1 << 61) | pts, b'\x00\x00\x00\x01\x65')

video.sendall(struct.pack('>I', 0x68323634))
video_session(720, 1280, 1000000)
mode = os.environ['UFICPY_AUDIO_TEST_MODE']
if mode == 'pcm':
    audio.sendall(struct.pack('>I', 0x00726177))
    frame(audio, 1234567890123, b'\x00\x80\xff\x7f\x00\x00\x00\x40')
else:
    # Do not close this socket: the backend must recognize the four-byte
    # disable/error marker without waiting for a twelve-byte frame header.
    audio.sendall(struct.pack('>I', int(mode)))

command = b''
while len(command) < 2:
    chunk = control.recv(2 - len(command))
    if not chunk:
        sys.exit(2)
    command += chunk
assert command == b'\x08\x00', command.hex()
clipboard = 'third-socket-confirmed'.encode()
control.sendall(b'\x00' + struct.pack('>I', len(clipboard)) + clipboard)
# After the audio result and a successful control round-trip, another video
# session must still arrive. This also checks rotation/session-header stripping.
video_session(1280, 720, 2000000)
while control.recv(4096):
    pass
`

func TestCaptureRunnerAudioSocketIntegration(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("capture integration requires Linux abstract Unix sockets")
	}
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("capture integration requires Python 3 for the app_process wire fixture")
	}
	probeAddress := fmt.Sprintf("@uficpy-audio-probe-%d-%d", os.Getpid(), time.Now().UnixNano())
	probe, err := net.Listen("unix", probeAddress)
	if err != nil {
		t.Skipf("host does not permit Linux abstract Unix sockets: %v", err)
	}
	probe.Close()
	for _, mode := range []string{"pcm", "0", "1"} {
		t.Run(mode, func(t *testing.T) {
			dir := t.TempDir()
			fixture := "#!" + python + "\n" + captureAudioProcessFixture
			if err := os.WriteFile(filepath.Join(dir, "app_process"), []byte(fixture), 0700); err != nil {
				t.Fatal(err)
			}
			addressFile := filepath.Join(dir, "address.json")
			t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
			t.Setenv("UFICPY_AUDIO_TEST_ADDRESS", addressFile)
			t.Setenv("UFICPY_AUDIO_TEST_MODE", mode)
			cfg := defaults()
			cfg.NoAudio = false
			h := newHub(nil)
			c := &client{queue: make(chan message, 64)}
			h.clients[c] = true
			ctx, cancel := context.WithCancel(context.Background())
			done := make(chan struct{})
			var captureErr error
			go func() {
				captureErr = captureRunner(dir, cfg)(ctx, h)
				close(done)
			}()
			t.Cleanup(func() {
				cancel()
				select {
				case <-done:
				case <-time.After(3 * time.Second):
					t.Error("captureRunner did not stop and reap app_process after cancellation")
				}
			})
			wantAudioState := map[string]string{"pcm": "streaming", "0": "unavailable", "1": "error"}[mode]
			firstVideo, secondVideo, audioState, audioData, clipboard, sentControl := false, false, false, false, false, false
			deadline := time.NewTimer(5 * time.Second)
			defer deadline.Stop()
			for !secondVideo || !clipboard {
				select {
				case <-done:
					t.Fatalf("capture stopped before video/control completed in audio mode %s: %v", mode, captureErr)
				case <-deadline.C:
					t.Fatalf("capture stalled: mode=%s firstVideo=%t secondVideo=%t audioState=%t audioData=%t control=%t clipboard=%t", mode, firstVideo, secondVideo, audioState, audioData, sentControl, clipboard)
				case m := <-c.queue:
					h.mu.Lock()
					c.queued -= len(m.data)
					h.mu.Unlock()
					if m.kind == 1 {
						var event map[string]any
						if err := json.Unmarshal(m.data, &event); err != nil {
							t.Fatal(err)
						}
						if event["type"] == "audio-status" && event["state"] == wantAudioState {
							audioState = true
						}
						if event["type"] == "clipboard" {
							if event["text"] != "third-socket-confirmed" {
								t.Fatalf("third control socket did not round-trip: %v", event)
							}
							clipboard = true
						}
					} else if bytes.HasPrefix(m.data, []byte("UFIA")) {
						if mode != "pcm" || len(m.data) != 20 || binary.BigEndian.Uint64(m.data[4:12]) != 1234567890123 || !bytes.Equal(m.data[12:], []byte{0, 128, 255, 127, 0, 0, 0, 64}) {
							t.Fatalf("unexpected audio output: mode=%s packet=%x", mode, m.data)
						}
						audioData = true
					} else {
						p, err := readPacket(bytes.NewReader(m.data))
						if err != nil {
							t.Fatalf("codec/session metadata leaked into browser video packets: %v", err)
						}
						if p.key {
							pts := binary.BigEndian.Uint64(p.data[:8]) & ^keyFlag
							firstVideo = firstVideo || pts == 1000000
							secondVideo = secondVideo || pts == 2000000
						}
					}
					if !sentControl && firstVideo && audioState && (mode != "pcm" || audioData) {
						if err := h.sendControl(c, []byte{8, 0}); err != nil {
							t.Fatal(err)
						}
						sentControl = true
					}
				}
			}
			if ctx.Err() != nil {
				t.Fatal("audio result canceled the healthy video/control session")
			}
			cancel()
			select {
			case <-done:
			case <-time.After(3 * time.Second):
				t.Fatal("captureRunner did not finish after cancellation")
			}
			h.controlMu.Lock()
			controlCleared := h.control == nil && h.clipboard == nil
			h.controlMu.Unlock()
			if !controlCleared {
				t.Fatal("cancellation retained control socket or pending clipboard request")
			}
			var record struct {
				Address string `json:"address"`
			}
			data, err := os.ReadFile(addressFile)
			if err != nil || json.Unmarshal(data, &record) != nil || !strings.HasPrefix(record.Address, "@scrcpy_") {
				t.Fatalf("fixture address missing: %s %v", data, err)
			}
			conn, err := net.DialTimeout("unix", record.Address, 200*time.Millisecond)
			if err == nil {
				conn.Close()
				t.Fatal("mock app_process/listening socket survived capture cancellation")
			}
		})
	}
}
