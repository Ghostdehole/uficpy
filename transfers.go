package main

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	transferMaxBytes        = int64(512 << 20)
	transferConcurrency     = 2
	transferUploadTimeout   = 10 * time.Minute
	transferInstallTimeout  = 3 * time.Minute
	transferOutputLimit     = 8192
	transferPublicDirectory = "/sdcard/Download/uficpy"
)

// ExposeTransferLimits reports the actual limits used by both upload endpoints.
func ExposeTransferLimits() map[string]any {
	return map[string]any{
		"max_bytes":               transferMaxBytes,
		"max_concurrent":          transferConcurrency,
		"upload_timeout_seconds":  int(transferUploadTimeout / time.Second),
		"install_timeout_seconds": int(transferInstallTimeout / time.Second),
		"file_directory":          transferPublicDirectory,
		"single_apk_only":         true,
	}
}

type transferService struct {
	config          Config
	slots           chan struct{}
	maxBytes        int64
	uploadTimeout   time.Duration
	installTimeout  time.Duration
	apkBase         string
	fileBase        string
	publicDirectory string
	install         func(context.Context, *os.File, int64) (string, error)
}

func newTransferService(c Config) *transferService {
	return &transferService{
		config: c, slots: make(chan struct{}, transferConcurrency), maxBytes: transferMaxBytes,
		uploadTimeout: transferUploadTimeout, installTimeout: transferInstallTimeout,
		apkBase: "/data/local/tmp", fileBase: "/sdcard", publicDirectory: transferPublicDirectory,
		install: runAPKInstall,
	}
}

func registerTransferRoutes(mux *http.ServeMux, c Config) {
	newTransferService(c).register(mux)
}

func (s *transferService) register(mux *http.ServeMux) {
	mux.HandleFunc("/api/install", func(w http.ResponseWriter, r *http.Request) { s.serve(w, r, true) })
	mux.HandleFunc("/api/files", func(w http.ResponseWriter, r *http.Request) { s.serve(w, r, false) })
}

func transferJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func transferError(w http.ResponseWriter, status int, code, message string) {
	transferJSON(w, status, map[string]any{"error": message, "code": code})
}

func transferAuthorized(r *http.Request, token string) bool {
	values := r.Header.Values("Authorization")
	if token == "" || len(values) != 1 || !strings.HasPrefix(values[0], "Bearer ") {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(strings.TrimPrefix(values[0], "Bearer ")), []byte(token)) == 1
}

func transferSameOrigin(r *http.Request) bool {
	values := r.Header.Values("Origin")
	if len(values) == 0 {
		return true // Native HTTP clients do not send Origin; the bearer token remains mandatory.
	}
	if len(values) != 1 {
		return false
	}
	u, err := url.Parse(values[0])
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	return err == nil && u.Scheme == scheme && u.User == nil && u.Path == "" && u.RawQuery == "" && u.Fragment == "" && strings.EqualFold(u.Host, r.Host)
}

func transferFilename(r *http.Request) (string, error) {
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil || len(query) != 1 || len(query["name"]) != 1 {
		return "", errors.New("请通过 name 参数提供一个文件名")
	}
	name := query.Get("name")
	if name == "" || len(name) > 240 || !utf8.ValidString(name) || strings.TrimSpace(name) != name || strings.HasPrefix(name, ".") || strings.ContainsAny(name, "/\\") {
		return "", errors.New("文件名无效：不能包含路径、控制字符、首尾空格，或超过 240 字节")
	}
	for _, r := range name {
		if unicode.IsControl(r) || unicode.In(r, unicode.Cf) {
			return "", errors.New("文件名不能包含控制字符或不可见格式字符")
		}
	}
	return name, nil
}

func (s *transferService) serve(w http.ResponseWriter, r *http.Request, apk bool) {
	// Check authorization before opening files or touching the request body.
	if !transferAuthorized(r, s.config.Token) {
		w.Header().Set("WWW-Authenticate", "Bearer")
		transferError(w, http.StatusUnauthorized, "unauthorized", "访问令牌无效")
		return
	}
	if !transferSameOrigin(r) {
		transferError(w, http.StatusForbidden, "cross_origin", "不接受跨站上传请求")
		return
	}
	if s.config.ReadOnly {
		transferError(w, http.StatusForbidden, "read_only", "只读模式不允许上传文件或安装应用")
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		transferError(w, http.StatusMethodNotAllowed, "method_not_allowed", "请使用 POST 上传文件")
		return
	}
	name, err := transferFilename(r)
	if err != nil {
		transferError(w, http.StatusBadRequest, "invalid_name", err.Error())
		return
	}
	if apk && !strings.EqualFold(filepath.Ext(name), ".apk") {
		transferError(w, http.StatusUnsupportedMediaType, "single_apk_required", "仅支持单个 .apk 文件；不支持 .apks、.xapk、.apkm 分包合集，请使用应用提供的通用 APK")
		return
	}
	if enc := r.Header.Get("Content-Encoding"); enc != "" && enc != "identity" {
		transferError(w, http.StatusUnsupportedMediaType, "content_encoding", "请上传原始文件，不要压缩 HTTP 请求体")
		return
	}
	if media, _, e := mime.ParseMediaType(r.Header.Get("Content-Type")); r.Header.Get("Content-Type") != "" && (e != nil || strings.HasPrefix(media, "multipart/")) {
		transferError(w, http.StatusUnsupportedMediaType, "raw_body_required", "请求体必须直接包含文件内容")
		return
	}
	if r.ContentLength > s.maxBytes {
		transferError(w, http.StatusRequestEntityTooLarge, "too_large", fmt.Sprintf("单个文件不能超过 %d MiB", s.maxBytes>>20))
		return
	}
	select {
	case s.slots <- struct{}{}:
		defer func() { <-s.slots }()
	default:
		w.Header().Set("Retry-After", "3")
		transferError(w, http.StatusTooManyRequests, "busy", "同时上传或安装的任务过多，请等待已有任务完成")
		return
	}
	if r.Context().Err() != nil {
		transferError(w, 499, "cancelled", "上传已取消")
		return
	}
	var dir, f *os.File
	var diskName string
	if apk {
		dir, err = openTransferDirectory(s.apkBase, []string{"uficpy-uploads"}, 0700, true)
		if err == nil {
			var id [16]byte
			_, err = rand.Read(id[:])
			if err == nil {
				diskName = "upload-" + hex.EncodeToString(id[:]) + ".apk"
				f, err = createTransferFile(dir, diskName, 0600)
			}
		}
	} else {
		dir, err = openTransferDirectory(s.fileBase, []string{"Download", "uficpy"}, 0755, false)
		if err == nil {
			diskName = name
			f, err = createTransferFile(dir, diskName, 0644)
		}
	}
	if dir != nil {
		defer dir.Close()
	}
	if err != nil {
		if !apk && errors.Is(err, os.ErrExist) {
			transferError(w, http.StatusConflict, "file_exists", "设备上已有同名文件，请重命名后再上传")
		} else {
			log.Printf("upload storage: %v", err)
			transferError(w, http.StatusInternalServerError, "storage_unavailable", "无法创建上传文件；请检查设备存储空间、目录权限及日志")
		}
		return
	}
	keep := false
	defer func() {
		_ = f.Close()
		if !keep {
			_ = syscall.Unlinkat(int(dir.Fd()), diskName)
		}
	}()
	n, digest, err := s.receive(w, r, f)
	if err != nil {
		switch {
		case errors.Is(err, errTransferTooLarge):
			transferError(w, http.StatusRequestEntityTooLarge, "too_large", fmt.Sprintf("单个文件不能超过 %d MiB", s.maxBytes>>20))
		case errors.Is(err, context.DeadlineExceeded):
			transferError(w, http.StatusRequestTimeout, "upload_timeout", "上传超时，未完成的文件已清理")
		case errors.Is(err, context.Canceled):
			transferError(w, 499, "cancelled", "上传已取消，未完成的文件已清理")
		default:
			transferError(w, http.StatusBadRequest, "upload_failed", "上传未完成；请检查网络和设备存储空间后重试")
		}
		return
	}
	if r.Context().Err() != nil {
		transferError(w, 499, "cancelled", "上传已取消，未完成的文件已清理")
		return
	}
	if !apk {
		if err := f.Sync(); err != nil {
			transferError(w, http.StatusInsufficientStorage, "storage_failed", "无法保存文件，请检查设备存储空间")
			return
		}
		if err := f.Close(); err != nil {
			transferError(w, http.StatusInsufficientStorage, "storage_failed", "无法完成文件写入，请检查设备存储空间")
			return
		}
		if r.Context().Err() != nil {
			transferError(w, 499, "cancelled", "上传已取消，未完成的文件已清理")
			return
		}
		keep = true
		transferJSON(w, http.StatusCreated, map[string]any{"ok": true, "message": "文件已保存", "path": s.publicDirectory + "/" + name, "name": name, "bytes": n, "sha256": digest})
		return
	}
	if err := validateSingleAPK(f, n); err != nil {
		transferError(w, http.StatusUnprocessableEntity, "invalid_apk", err.Error())
		return
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		transferError(w, http.StatusInternalServerError, "storage_failed", "无法读取已上传的 APK")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), s.installTimeout)
	defer cancel()
	output, installErr := s.install(ctx, f, n)
	output = truncateTransferOutput(output)
	if ctx.Err() != nil {
		status := http.StatusGatewayTimeout
		if errors.Is(ctx.Err(), context.Canceled) {
			status = 499
		}
		transferJSON(w, status, map[string]any{"error": "安装等待已中断，系统可能仍在处理；请在设备上确认结果后再试，避免重复安装", "code": "install_status_unknown", "status_unknown": true, "detail": output})
		return
	}
	if installErr != nil || !transferInstallSucceeded(output) {
		transferJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": "Android 未确认安装成功；不会自动卸载旧版或降级安装", "code": "install_failed", "detail": output})
		return
	}
	transferJSON(w, http.StatusOK, map[string]any{"ok": true, "message": "应用已安装", "name": name, "bytes": n, "sha256": digest})
}

var errTransferTooLarge = errors.New("upload exceeds size limit")

func (s *transferService) receive(w http.ResponseWriter, r *http.Request, f *os.File) (int64, string, error) {
	ctx, cancel := context.WithTimeout(r.Context(), s.uploadTimeout)
	defer cancel()
	deadline, _ := ctx.Deadline()
	controller := http.NewResponseController(w)
	_ = controller.SetReadDeadline(deadline)
	defer controller.SetReadDeadline(time.Time{})
	finished := make(chan struct{})
	defer close(finished)
	go func() {
		select {
		case <-ctx.Done():
			_ = r.Body.Close()
		case <-finished:
		}
	}()
	defer r.Body.Close()
	hash := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, hash), io.LimitReader(&transferContextReader{ctx, r.Body}, s.maxBytes+1))
	// net/http also cancels Request.Context after a socket read deadline fires.
	// Preserve the actual timeout instead of misreporting a client cancellation.
	if os.IsTimeout(err) {
		return n, "", context.DeadlineExceeded
	}
	if ctx.Err() != nil {
		return n, "", ctx.Err()
	}
	if n > s.maxBytes {
		return n, "", errTransferTooLarge
	}
	if err == nil && r.ContentLength >= 0 && n != r.ContentLength {
		err = io.ErrUnexpectedEOF
	}
	return n, hex.EncodeToString(hash.Sum(nil)), err
}

type transferContextReader struct {
	ctx context.Context
	r   io.Reader
}

func (r *transferContextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.r.Read(p)
}

// Pin every created directory to an fd and refuse symlinks in the writable
// suffix. /sdcard itself is an Android-managed symlink and is resolved once.
func openTransferDirectory(base string, suffix []string, mode uint32, private bool) (*os.File, error) {
	resolved, err := filepath.EvalSymlinks(base)
	if err != nil {
		return nil, err
	}
	fd, err := syscall.Open(resolved, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	dir := os.NewFile(uintptr(fd), resolved)
	for _, name := range suffix {
		next, err := syscall.Openat(int(dir.Fd()), name, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		if errors.Is(err, syscall.ENOENT) {
			if err = syscall.Mkdirat(int(dir.Fd()), name, mode); err == nil || errors.Is(err, syscall.EEXIST) {
				next, err = syscall.Openat(int(dir.Fd()), name, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
			}
		}
		_ = dir.Close()
		if err != nil {
			return nil, err
		}
		dir = os.NewFile(uintptr(next), name)
	}
	if private {
		info, err := dir.Stat()
		if err != nil {
			dir.Close()
			return nil, err
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || int(stat.Uid) != os.Geteuid() || info.Mode().Perm()&0077 != 0 {
			dir.Close()
			return nil, errors.New("private upload directory ownership or permissions are unsafe")
		}
	}
	return dir, nil
}

func createTransferFile(dir *os.File, name string, mode uint32) (*os.File, error) {
	fd, err := syscall.Openat(int(dir.Fd()), name, syscall.O_RDWR|syscall.O_CREAT|syscall.O_EXCL|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, mode)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(fd), name), nil
}

func validateSingleAPK(f *os.File, size int64) error {
	// Bound ZIP metadata before archive/zip allocates it. APKs do not need ZIP64.
	tailSize := int64(65557)
	if size < tailSize {
		tailSize = size
	}
	tail := make([]byte, tailSize)
	if _, err := f.ReadAt(tail, size-tailSize); err != nil {
		return errors.New("无法读取 APK 文件")
	}
	end := -1
	for i := len(tail) - 22; i >= 0; i-- {
		if bytes.Equal(tail[i:i+4], []byte{'P', 'K', 5, 6}) && i+22+int(binary.LittleEndian.Uint16(tail[i+20:i+22])) == len(tail) {
			end = i
			break
		}
	}
	if end < 0 {
		return errors.New("文件不是受支持的单包 APK，或 ZIP 元数据过大")
	}
	entries := int(binary.LittleEndian.Uint16(tail[end+10 : end+12]))
	centralSize := int64(binary.LittleEndian.Uint32(tail[end+12 : end+16]))
	centralOffset := int64(binary.LittleEndian.Uint32(tail[end+16 : end+20]))
	if entries == 65535 || centralSize > 16<<20 || centralOffset == 0xffffffff || centralOffset+centralSize != size-tailSize+int64(end) || binary.LittleEndian.Uint16(tail[end+4:end+6]) != 0 || binary.LittleEndian.Uint16(tail[end+6:end+8]) != 0 || int(binary.LittleEndian.Uint16(tail[end+8:end+10])) != entries {
		return errors.New("不支持 ZIP64、多卷 ZIP 或过大的 APK 元数据")
	}
	central := make([]byte, centralSize)
	if _, err := f.ReadAt(central, centralOffset); err != nil {
		return errors.New("APK 的 ZIP 目录不完整")
	}
	// Validate directory bounds as well as the EOCD declaration: archive/zip
	// otherwise keeps parsing headers beyond a forged central-directory size.
	count := 0
	for pos := 0; pos < len(central); {
		if len(central)-pos < 46 || !bytes.Equal(central[pos:pos+4], []byte{'P', 'K', 1, 2}) {
			return errors.New("APK 的 ZIP 目录无效")
		}
		length := 46 + int(binary.LittleEndian.Uint16(central[pos+28:pos+30])) + int(binary.LittleEndian.Uint16(central[pos+30:pos+32])) + int(binary.LittleEndian.Uint16(central[pos+32:pos+34]))
		if length > len(central)-pos {
			return errors.New("APK 的 ZIP 目录不完整")
		}
		pos += length
		count++
	}
	if count != entries {
		return errors.New("APK 的 ZIP 目录条目数不匹配")
	}
	z, err := zip.NewReader(f, size)
	if err != nil {
		return errors.New("APK 的 ZIP 结构无效")
	}
	var manifest *zip.File
	for _, entry := range z.File {
		if entry.Name == "AndroidManifest.xml" {
			if manifest != nil || entry.FileInfo().IsDir() || entry.UncompressedSize64 == 0 || entry.UncompressedSize64 > 8<<20 {
				return errors.New("APK 中的 AndroidManifest.xml 无效")
			}
			manifest = entry
		}
	}
	if manifest == nil {
		return errors.New("APK 缺少 AndroidManifest.xml；分包合集请先获取通用 APK")
	}
	reader, err := manifest.Open()
	if err != nil {
		return errors.New("无法读取 APK 清单")
	}
	defer reader.Close()
	n, err := io.Copy(io.Discard, io.LimitReader(reader, 8<<20+1))
	if err != nil || n > 8<<20 {
		return errors.New("APK 清单校验失败")
	}
	return nil
}

type transferOutputBuffer struct {
	mu        sync.Mutex
	b         bytes.Buffer
	truncated bool
}

func (b *transferOutputBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := len(p)
	remaining := transferOutputLimit - b.b.Len()
	if len(p) > remaining {
		p = p[:remaining]
		b.truncated = true
	}
	_, _ = b.b.Write(p)
	return n, nil
}

func (b *transferOutputBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	s := b.b.String()
	if b.truncated {
		s += "\n[输出已截断]"
	}
	return s
}

func truncateTransferOutput(s string) string {
	if len(s) > transferOutputLimit {
		s = s[:transferOutputLimit] + "\n[输出已截断]"
	}
	return strings.ToValidUTF8(strings.TrimSpace(s), "�")
}

func transferInstallSucceeded(output string) bool {
	for _, line := range strings.Split(output, "\n") {
		if strings.TrimSpace(line) == "Success" {
			return true
		}
	}
	return false
}

func runAPKInstall(ctx context.Context, f *os.File, size int64) (string, error) {
	cmd := exec.CommandContext(ctx, "/system/bin/pm", "install", "-r", "--user", "current", "-S", strconv.FormatInt(size, 10))
	cmd.Stdin = f
	var output transferOutputBuffer
	cmd.Stdout, cmd.Stderr = &output, &output
	cmd.WaitDelay = 5 * time.Second
	err := cmd.Run()
	if err != nil && output.String() == "" {
		return "无法执行 Android 软件包安装器：" + err.Error(), err
	}
	return output.String(), err
}
