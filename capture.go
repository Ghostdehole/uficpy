package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	_ "embed"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// The reviewed core identity is embedded at build time, never trusted from device config.
//
//go:embed core-lock.json
var coreLockJSON []byte
var coreLock struct {
	Version string `json:"version"`
	SHA256  string `json:"sha256"`
}

func init() {
	if err := json.Unmarshal(coreLockJSON, &coreLock); err != nil {
		panic(err)
	}
}

func verifyCore(dir string) error {
	v, e := os.ReadFile(filepath.Join(dir, "version.txt"))
	if e != nil {
		return e
	}
	if strings.TrimSpace(string(v)) != coreLock.Version {
		return fmt.Errorf("核心版本不匹配，请安装同一个 Release 的完整后端")
	}
	b, e := os.ReadFile(filepath.Join(dir, "scrcpy-server.jar"))
	if e != nil {
		return e
	}
	if fmt.Sprintf("%x", sha256.Sum256(b)) != coreLock.SHA256 {
		return fmt.Errorf("scrcpy-server.jar 校验不匹配，请恢复配套文件")
	}
	return nil
}
func dialSocket(ctx context.Context, name string) (net.Conn, error) {
	d := net.Dialer{Timeout: 200 * time.Millisecond}
	deadline := time.NewTimer(10 * time.Second)
	defer deadline.Stop()
	for {
		c, e := d.DialContext(ctx, "unix", "@"+name)
		if e == nil {
			return c, nil
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-deadline.C:
			return nil, fmt.Errorf("连接 %s 超时，请检查 app_process 日志和 SELinux 权限", name)
		case <-time.After(100 * time.Millisecond):
		}
	}
}
func captureRunner(dir string, c Config) func(context.Context, *hub) error {
	return func(ctx context.Context, h *hub) error {
		ctx, cancel := context.WithCancel(ctx)
		defer cancel()
		var seed [4]byte
		if _, e := rand.Read(seed[:]); e != nil {
			return e
		}
		id := binary.BigEndian.Uint32(seed[:]) & 0x7fffffff
		args := captureArgs(c, id)
		cmd := exec.CommandContext(ctx, "app_process", args...)
		cmd.Env = append(os.Environ(), "CLASSPATH="+filepath.Join(dir, "scrcpy-server.jar"))
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		cmd.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
		if e := cmd.Start(); e != nil {
			return fmt.Errorf("app_process: %w", e)
		}
		waited := make(chan error, 1)
		go func() { e := cmd.Wait(); waited <- e; cancel() }()
		defer func() { cancel(); <-waited }()
		name := fmt.Sprintf("scrcpy_%08x", id)
		v, e := dialSocket(ctx, name)
		if e != nil {
			return e
		}
		defer v.Close()
		// scrcpy accepts enabled sockets in video, audio, control order. Even if
		// Android cannot capture audio, its socket must still occupy this slot.
		var audio net.Conn
		if !c.NoAudio {
			audio, e = dialSocket(ctx, name)
			if e != nil {
				return fmt.Errorf("连接音频 socket: %w", e)
			}
			defer audio.Close()
		}
		ctrl, e := dialSocket(ctx, name)
		if e != nil {
			return e
		}
		defer ctrl.Close()
		h.setControl(ctrl)
		defer h.setControl(nil)
		go func() {
			<-ctx.Done()
			v.Close()
			ctrl.Close()
			if audio != nil {
				audio.Close()
			}
		}()
		// Consume clipboard/ack messages, and restart both sockets together if
		// control disconnects instead of leaving a working video with dead input.
		go func() {
			_ = consumeDeviceMessages(ctrl, h)
			cancel()
		}()
		h.status("connected", "视频和控制 socket 已连接，等待首个编码包")
		if audio != nil {
			audioCtx, stopAudio := context.WithCancel(ctx)
			audioDone := make(chan struct{})
			go func() {
				defer close(audioDone)
				consumeAudio(audioCtx, audio, h)
			}()
			defer func() { stopAudio(); audio.Close(); <-audioDone }()
		} else {
			h.audioStatus("disabled", "设备声音采集未开启")
		}
		v.SetReadDeadline(time.Now().Add(15 * time.Second))
		if !c.NoAudio {
			if e := readStreamCodec(v, h264CodecID); e != nil {
				return fmt.Errorf("视频流协商: %w", e)
			}
		}
		first := true
		for {
			p, e := readCaptureVideoPacket(v, !c.NoAudio)
			if e != nil {
				return fmt.Errorf("读取视频流: %w", e)
			}
			if first {
				first = false
				v.SetReadDeadline(time.Time{})
				h.status("streaming", "收到编码数据，等待浏览器显示")
			}
			h.publish(p)
		}
	}
}

func captureArgs(c Config, id uint32) []string {
	args := []string{"/", "com.genymobile.scrcpy.Server", coreLock.Version,
		fmt.Sprintf("scid=%08x", id), "log_level=" + c.LogLevel, "video=true", "video_codec=h264", fmt.Sprintf("audio=%t", !c.NoAudio), "control=true", "tunnel_forward=true", "cleanup=false", "clipboard_autosync=false", "send_dummy_byte=false", "send_device_meta=false", fmt.Sprintf("send_stream_meta=%t", !c.NoAudio), "send_frame_meta=true",
		fmt.Sprintf("max_size=%d", c.MaxSize), fmt.Sprintf("max_fps=%d", c.MaxFps), fmt.Sprintf("video_bit_rate=%d", c.BitRate), fmt.Sprintf("display_id=%d", c.DisplayID), fmt.Sprintf("downsize_on_error=%t", c.DownsizeOnError),
		"video_codec_options=" + c.VideoCodecOptions}
	if !c.NoAudio {
		args = append(args, "audio_codec=raw", "audio_source="+c.AudioSource)
	}
	if c.VideoEncoder != "" {
		args = append(args, "video_encoder="+c.VideoEncoder)
	}
	if c.Crop != "" {
		args = append(args, "crop="+c.Crop)
	}
	if c.CaptureOrientation != "" {
		args = append(args, "capture_orientation="+c.CaptureOrientation)
	}
	return args
}
func listCapabilities(dir, kind string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "app_process", "/", "com.genymobile.scrcpy.Server", coreLock.Version, "list_"+kind+"=true")
	cmd.Env = append(os.Environ(), "CLASSPATH="+filepath.Join(dir, "scrcpy-server.jar"))
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}
