package main

import (
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

type Config struct {
	WmSize             string   `json:"wm_size"`
	WmDensity          int      `json:"wm_density"`
	MaxSize            int      `json:"max_size"`
	MaxFps             int      `json:"max_fps"`
	BitRate            int      `json:"bit_rate"`
	NoAudio            bool     `json:"no_audio"`
	AudioSource        string   `json:"audio_source"`
	Port               int      `json:"port"`
	Listen             string   `json:"listen"`
	Token              string   `json:"token"`
	TLSCert            string   `json:"tls_cert,omitempty"`
	TLSKey             string   `json:"tls_key,omitempty"`
	VideoEncoder       string   `json:"video_encoder"`
	VideoCodecOptions  string   `json:"video_codec_options"`
	DisplayID          int      `json:"display_id"`
	Crop               string   `json:"crop"`
	CaptureOrientation string   `json:"capture_orientation"`
	DownsizeOnError    bool     `json:"downsize_on_error"`
	LogLevel           string   `json:"log_level"`
	ReadOnly           bool     `json:"read_only"`
	AllowVolumeKeys    bool     `json:"allow_volume_keys"`
	AllowedKeys        []uint32 `json:"allowed_keys"`
	MaxClients         int      `json:"max_clients"`
	QueueMB            int      `json:"queue_mb"`
	GOPMB              int      `json:"gop_mb"`
	IdleSeconds        int      `json:"idle_seconds"`
}

func defaults() Config {
	return Config{MaxSize: 1920, MaxFps: 60, BitRate: 12000000, NoAudio: true, AudioSource: "output", Port: 9528, Listen: "0.0.0.0", VideoCodecOptions: "i-frame-interval=1,max-bframes=0", LogLevel: "info", AllowedKeys: []uint32{3, 4, 19, 20, 21, 22, 23, 61, 62, 66, 67, 92, 93, 111, 112, 122, 123, 124, 187, 224}, MaxClients: 8, QueueMB: 16, GOPMB: 8, IdleSeconds: 2}

}

var sizePattern = regexp.MustCompile(`^(?:[1-9][0-9]{2,3})x(?:[1-9][0-9]{2,3})$`)

func (c Config) validate(requireToken bool) error {
	if c.WmSize != "" && !sizePattern.MatchString(c.WmSize) {
		return fmt.Errorf("wm_size 应留空或使用 720x1280 格式")
	}
	if c.WmDensity != 0 && (c.WmDensity < 72 || c.WmDensity > 640) {
		return fmt.Errorf("wm_density 应为 0 或 72..640")
	}
	if (c.MaxSize != 0 && (c.MaxSize < 128 || c.MaxSize > 16384)) || c.MaxFps < 0 || c.MaxFps > 1000 || c.BitRate < 100000 || c.BitRate > 2000000000 {
		return fmt.Errorf("编码参数超出范围: max_size 0 或 128..16384, max_fps 0..1000, bit_rate 100000..2000000000；0 表示不限制尺寸/帧率")
	}
	if c.DisplayID < 0 || c.MaxClients < 1 || c.MaxClients > 64 || c.QueueMB < 1 || c.QueueMB > 256 || c.GOPMB < 1 || c.GOPMB > c.QueueMB || c.IdleSeconds < 0 || c.IdleSeconds > 3600 {
		return fmt.Errorf("display_id/客户端数/队列/GOP/空闲时间超出范围")
	}
	if c.Crop != "" && !regexp.MustCompile(`^[1-9][0-9]*:[1-9][0-9]*:[0-9]+:[0-9]+$`).MatchString(c.Crop) {
		return fmt.Errorf("crop 应为 width:height:x:y")
	}
	if c.CaptureOrientation != "" && !regexp.MustCompile(`^@?(?:0|90|180|270)?$`).MatchString(c.CaptureOrientation) {
		return fmt.Errorf("capture_orientation 应为 0/90/180/270 或 @前缀")
	}
	if c.VideoEncoder != "" && !regexp.MustCompile(`^[a-zA-Z0-9_.-]{1,200}$`).MatchString(c.VideoEncoder) {
		return fmt.Errorf("编码器名称无效")
	}
	if c.LogLevel != "verbose" && c.LogLevel != "debug" && c.LogLevel != "info" && c.LogLevel != "warn" && c.LogLevel != "error" {
		return fmt.Errorf("log_level 无效")
	}
	if len(c.VideoCodecOptions) > 4096 || strings.ContainsAny(c.VideoCodecOptions, "\r\n\x00") {
		return fmt.Errorf("video_codec_options 无效")
	}
	// Browser muxing has no DTS/reordering support: do not silently accept broken B-frame streams.
	foundNoB := false
	for _, option := range strings.Split(c.VideoCodecOptions, ",") {
		pair := strings.SplitN(option, "=", 2)
		if len(pair) != 2 || !regexp.MustCompile(`^[a-zA-Z0-9_.-]+(?::(?:int|long|float|string))?$`).MatchString(pair[0]) || pair[1] == "" {
			return fmt.Errorf("编码器选项应为 key[:type]=value")
		}
		if strings.Split(pair[0], ":")[0] == "max-bframes" {
			if pair[1] != "0" {
				return fmt.Errorf("当前浏览器播放要求 max-bframes=0")
			}
			foundNoB = true
		}
	}
	if !foundNoB {
		return fmt.Errorf("video_codec_options 必须包含 max-bframes=0")
	}
	if len(c.AllowedKeys) > 1024 {
		return fmt.Errorf("allowed_keys 过多")
	}
	for _, k := range c.AllowedKeys {
		if k > 1024 {
			return fmt.Errorf("Android keycode 超出范围")
		}
	}
	if c.AudioSource != "output" && c.AudioSource != "mic" {
		return fmt.Errorf("audio_source 应为 output（设备声音）或 mic（设备麦克风）")
	}
	if c.Port < 1024 || c.Port > 65535 {
		return fmt.Errorf("port 必须为 1024..65535")
	}
	if (c.TLSCert == "") != (c.TLSKey == "") {
		return fmt.Errorf("tls_cert 和 tls_key 必须同时设置")
	}
	if c.TLSCert != "" && (!filepath.IsAbs(c.TLSCert) || !filepath.IsAbs(c.TLSKey)) {
		return fmt.Errorf("tls_cert 和 tls_key 必须使用绝对路径，例如 /data/uficpy/certs/server.crt 和 /data/uficpy/certs/server.key")
	}
	if requireToken && !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(c.Token) {
		return fmt.Errorf("缺少有效访问令牌，请先运行 ./uficpy -init")
	}
	if c.TLSCert != "" {
		if _, e := tls.LoadX509KeyPair(c.TLSCert, c.TLSKey); e != nil {
			return fmt.Errorf("TLS 证书或私钥无效: %w", e)
		}
	}
	return nil
}
func readConfig(path string) (Config, error) {
	c := defaults()
	f, e := os.Open(path)
	if e != nil {
		return c, e
	}
	defer f.Close()
	d := json.NewDecoder(io.LimitReader(f, 65537))
	d.DisallowUnknownFields()
	if e = d.Decode(&c); e != nil {
		return c, fmt.Errorf("config.json: %w", e)
	}
	var extra any
	if e = d.Decode(&extra); e != io.EOF {
		return c, fmt.Errorf("配置尾部存在额外数据")
	}
	return c, c.validate(false)
}
func writeConfig(path string, c Config) error {
	b, e := json.MarshalIndent(c, "", "  ")
	if e != nil {
		return e
	}
	f, e := os.CreateTemp(filepath.Dir(path), ".config-*")
	if e != nil {
		return e
	}
	defer os.Remove(f.Name())
	if e = f.Chmod(0600); e == nil {
		_, e = f.Write(append(b, '\n'))
	}
	if e == nil {
		e = f.Sync()
	}
	ce := f.Close()
	if e == nil {
		e = ce
	}
	if e != nil {
		return e
	}
	return os.Rename(f.Name(), path)
}
func initConfig(path string) error {
	c, e := readConfig(path)
	if os.IsNotExist(e) {
		c = defaults()
	} else if e != nil {
		return e
	}
	if strings.TrimSpace(c.Token) == "" {
		b := make([]byte, 32)
		if _, e = rand.Read(b); e != nil {
			return e
		}
		c.Token = hex.EncodeToString(b)
	}
	if e = c.validate(true); e != nil {
		return e
	}
	return writeConfig(path, c)
}
