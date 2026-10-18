package main

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func testTransferService(t *testing.T) *transferService {
	t.Helper()
	c := defaults()
	c.Token = strings.Repeat("a", 64)
	s := newTransferService(c)
	s.apkBase = t.TempDir()
	s.fileBase = t.TempDir()
	s.install = func(context.Context, *os.File, int64) (string, error) {
		t.Error("unexpected package-manager call")
		return "Failure", errors.New("unexpected install")
	}
	return s
}

func transferRequest(s *transferService, endpoint, name string, body io.Reader) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "http://device.test"+endpoint+"?name="+url.QueryEscape(name), body)
	r.Header.Set("Authorization", "Bearer "+s.config.Token)
	r.Header.Set("Origin", "http://device.test")
	r.Header.Set("Content-Type", "application/octet-stream")
	return r
}

func transferResponse(t *testing.T, s *transferService, r *http.Request) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	w := httptest.NewRecorder()
	s.serve(w, r, r.URL.Path == "/api/install")
	var v map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &v); err != nil {
		t.Fatalf("invalid response JSON: %v, %s", err, w.Body)
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("upload response must not be cached")
	}
	return w, v
}

type unreadTransferBody struct{ t *testing.T }

func (b *unreadTransferBody) Read([]byte) (int, error) {
	b.t.Error("rejected request body was read")
	return 0, io.EOF
}
func (b *unreadTransferBody) Close() error { return nil }

func TestTransferRejectsBeforeReading(t *testing.T) {
	tests := []struct {
		name   string
		change func(*transferService, *http.Request)
		status int
	}{
		{"missing bearer", func(s *transferService, r *http.Request) { r.Header.Del("Authorization") }, 401},
		{"bare token", func(s *transferService, r *http.Request) { r.Header.Set("Authorization", s.config.Token) }, 401},
		{"websocket token", func(s *transferService, r *http.Request) {
			r.Header.Del("Authorization")
			r.Header.Set("Sec-WebSocket-Protocol", s.config.Token)
		}, 401},
		{"empty configured token", func(s *transferService, r *http.Request) {
			s.config.Token = ""
			r.Header.Set("Authorization", "Bearer ")
		}, 401},
		{"duplicate authorization", func(s *transferService, r *http.Request) { r.Header.Add("Authorization", "Bearer "+s.config.Token) }, 401},
		{"cross origin", func(s *transferService, r *http.Request) { r.Header.Set("Origin", "http://evil.test") }, 403},
		{"different scheme", func(s *transferService, r *http.Request) { r.Header.Set("Origin", "https://device.test") }, 403},
		{"origin path", func(s *transferService, r *http.Request) { r.Header.Set("Origin", "http://device.test/path") }, 403},
		{"null origin", func(s *transferService, r *http.Request) { r.Header.Set("Origin", "null") }, 403},
		{"readonly", func(s *transferService, r *http.Request) { s.config.ReadOnly = true }, 403},
		{"method", func(s *transferService, r *http.Request) { r.Method = http.MethodGet }, 405},
		{"declared size", func(s *transferService, r *http.Request) { r.ContentLength = s.maxBytes + 1 }, 413},
		{"multipart", func(s *transferService, r *http.Request) {
			r.Header.Set("Content-Type", "multipart/form-data; boundary=test")
		}, 415},
		{"encoding", func(s *transferService, r *http.Request) { r.Header.Set("Content-Encoding", "gzip") }, 415},
		{"split", func(s *transferService, r *http.Request) {
			r.URL.Path = "/api/install"
			r.URL.RawQuery = "name=test.apks"
		}, 415},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := testTransferService(t)
			r := transferRequest(s, "/api/files", "test.txt", &unreadTransferBody{t})
			tt.change(s, r)
			w, _ := transferResponse(t, s, r)
			if w.Code != tt.status {
				t.Fatalf("status %d want %d: %s", w.Code, tt.status, w.Body)
			}
			files, _ := os.ReadDir(s.fileBase)
			if len(files) != 0 {
				t.Fatal("rejected request created directories")
			}
		})
	}
}

func TestTransferFilenames(t *testing.T) {
	for _, name := range []string{"../a", "/a", `a\b`, ".hidden", ".", "..", " a", "a ", "a\x00b", "a\nb", "a\u202eb", strings.Repeat("字", 81)} {
		t.Run(url.QueryEscape(name), func(t *testing.T) {
			s := testTransferService(t)
			w, _ := transferResponse(t, s, transferRequest(s, "/api/files", name, &unreadTransferBody{t}))
			if w.Code != 400 {
				t.Fatalf("accepted invalid filename %q: %d", name, w.Code)
			}
		})
	}
	s := testTransferService(t)
	for _, query := range []string{"name=x&name=y", "name=x&path=/tmp", "name=%gg", ""} {
		r := transferRequest(s, "/api/files", "ok", &unreadTransferBody{t})
		r.URL.RawQuery = query
		w, _ := transferResponse(t, s, r)
		if w.Code != 400 {
			t.Fatalf("accepted invalid query %q", query)
		}
	}
}

func TestFileTransferPreservesUnicodeAndDoesNotOverwrite(t *testing.T) {
	s := testTransferService(t)
	name := "课程 笔记 📚.txt"
	content := []byte("file contents\n")
	r := transferRequest(s, "/api/files", name, bytes.NewReader(content))
	r.Header.Del("Origin")
	w, v := transferResponse(t, s, r)
	if w.Code != 201 || v["ok"] != true || v["path"] != transferPublicDirectory+"/"+name {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	digest := sha256.Sum256(content)
	if v["sha256"] != hex.EncodeToString(digest[:]) {
		t.Fatal("wrong upload digest")
	}
	got, err := os.ReadFile(filepath.Join(s.fileBase, "Download", "uficpy", name))
	if err != nil || !bytes.Equal(got, content) {
		t.Fatalf("file mismatch: %v %q", err, got)
	}
	w, _ = transferResponse(t, s, transferRequest(s, "/api/files", name, &unreadTransferBody{t}))
	if w.Code != 409 {
		t.Fatalf("overwrite accepted: %d", w.Code)
	}
	got, _ = os.ReadFile(filepath.Join(s.fileBase, "Download", "uficpy", name))
	if !bytes.Equal(got, content) {
		t.Fatal("existing file modified")
	}
	w, _ = transferResponse(t, s, transferRequest(s, "/api/files", "empty.txt", bytes.NewReader(nil)))
	if w.Code != 201 {
		t.Fatalf("empty ordinary file rejected: %s", w.Body)
	}
}

func assertTransferDirectoryEmpty(t *testing.T, path string) {
	t.Helper()
	files, err := os.ReadDir(path)
	if errors.Is(err, os.ErrNotExist) {
		return
	}
	if err != nil || len(files) != 0 {
		t.Fatalf("temporary data remains: %s %v %v", path, files, err)
	}
}

func TestTransferUnknownLengthLimitAndTruncation(t *testing.T) {
	for _, tc := range []struct {
		name    string
		content string
		length  int64
		status  int
	}{
		{"unknown over limit", "123456789", -1, 413},
		{"declared short", "123", 5, 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := testTransferService(t)
			s.maxBytes = 8
			r := transferRequest(s, "/api/files", "partial.txt", strings.NewReader(tc.content))
			r.ContentLength = tc.length
			w, _ := transferResponse(t, s, r)
			if w.Code != tc.status {
				t.Fatalf("%d %s", w.Code, w.Body)
			}
			assertTransferDirectoryEmpty(t, filepath.Join(s.fileBase, "Download", "uficpy"))
		})
	}
}

type cancelTransferBody struct {
	cancel context.CancelFunc
	read   bool
}

func (r *cancelTransferBody) Read(b []byte) (int, error) {
	if r.read {
		return 0, io.EOF
	}
	r.read = true
	n := copy(b, "partial")
	r.cancel()
	return n, nil
}
func (*cancelTransferBody) Close() error { return nil }

type blockingTransferBody struct {
	closed chan struct{}
	once   sync.Once
}

func (r *blockingTransferBody) Read([]byte) (int, error) {
	<-r.closed
	return 0, errors.New("body closed")
}
func (r *blockingTransferBody) Close() error { r.once.Do(func() { close(r.closed) }); return nil }

func TestTransferCancellationAndTimeoutCleanUp(t *testing.T) {
	t.Run("cancel", func(t *testing.T) {
		s := testTransferService(t)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		r := transferRequest(s, "/api/files", "partial", &cancelTransferBody{cancel: cancel}).WithContext(ctx)
		w, _ := transferResponse(t, s, r)
		if w.Code != 499 {
			t.Fatalf("%d %s", w.Code, w.Body)
		}
		assertTransferDirectoryEmpty(t, filepath.Join(s.fileBase, "Download", "uficpy"))
	})
	t.Run("timeout", func(t *testing.T) {
		s := testTransferService(t)
		s.uploadTimeout = 20 * time.Millisecond
		r := transferRequest(s, "/api/files", "partial", &blockingTransferBody{closed: make(chan struct{})})
		w, _ := transferResponse(t, s, r)
		if w.Code != 408 {
			t.Fatalf("%d %s", w.Code, w.Body)
		}
		assertTransferDirectoryEmpty(t, filepath.Join(s.fileBase, "Download", "uficpy"))
	})
}

func TestTransferHTTPReadDeadline(t *testing.T) {
	s := testTransferService(t)
	s.uploadTimeout = 50 * time.Millisecond
	mux := http.NewServeMux()
	s.register(mux)
	server := httptest.NewServer(mux)
	defer server.Close()
	u, _ := url.Parse(server.URL)
	conn, err := net.DialTimeout("tcp", u.Host, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatal(err)
	}
	_, err = io.WriteString(conn, "POST /api/files?name=partial HTTP/1.1\r\nHost: "+u.Host+"\r\nAuthorization: Bearer "+s.config.Token+"\r\nContent-Length: 100\r\n\r\npartial")
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatalf("stalled upload was not terminated: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != 408 {
		t.Fatalf("status %d", response.StatusCode)
	}
	if _, err := io.ReadAll(response.Body); err != nil {
		t.Fatal(err)
	}
	assertTransferDirectoryEmpty(t, filepath.Join(s.fileBase, "Download", "uficpy"))
}

func TestTransferRefusesWritableSymlinks(t *testing.T) {
	for _, level := range []string{"Download", "uficpy", "file"} {
		t.Run(level, func(t *testing.T) {
			s := testTransferService(t)
			outside := t.TempDir()
			victim := filepath.Join(outside, "important")
			if err := os.WriteFile(victim, []byte("original"), 0600); err != nil {
				t.Fatal(err)
			}
			var link, target string
			switch level {
			case "Download":
				link, target = filepath.Join(s.fileBase, "Download"), outside
			case "uficpy":
				if err := os.Mkdir(filepath.Join(s.fileBase, "Download"), 0755); err != nil {
					t.Fatal(err)
				}
				link, target = filepath.Join(s.fileBase, "Download", "uficpy"), outside
			case "file":
				if err := os.MkdirAll(filepath.Join(s.fileBase, "Download", "uficpy"), 0755); err != nil {
					t.Fatal(err)
				}
				link, target = filepath.Join(s.fileBase, "Download", "uficpy", "important"), victim
			}
			if err := os.Symlink(target, link); err != nil {
				t.Fatal(err)
			}
			w, _ := transferResponse(t, s, transferRequest(s, "/api/files", "important", strings.NewReader("replacement")))
			if w.Code < 400 {
				t.Fatalf("symlink upload accepted: %d", w.Code)
			}
			got, _ := os.ReadFile(victim)
			if string(got) != "original" {
				t.Fatal("symlink target overwritten")
			}
			files, _ := os.ReadDir(outside)
			if len(files) != 1 {
				t.Fatal("file created outside fixed destination")
			}
		})
	}
}

func makeTransferAPK(t *testing.T, names ...string) []byte {
	t.Helper()
	var data bytes.Buffer
	w := zip.NewWriter(&data)
	for _, name := range names {
		entry, err := w.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write([]byte("test manifest data")); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return data.Bytes()
}

func TestAPKTransferValidationAndCleanup(t *testing.T) {
	forged := makeTransferAPK(t, "AndroidManifest.xml")
	binary.LittleEndian.PutUint32(forged[len(forged)-22+12:len(forged)-22+16], 4)
	for _, tc := range []struct {
		name string
		data []byte
	}{
		{"not zip", []byte("apk")},
		{"empty", nil},
		{"missing manifest", makeTransferAPK(t, "base.apk")},
		{"duplicate manifest", makeTransferAPK(t, "AndroidManifest.xml", "AndroidManifest.xml")},
		{"forged metadata bounds", forged},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := testTransferService(t)
			w, v := transferResponse(t, s, transferRequest(s, "/api/install", "test.apk", bytes.NewReader(tc.data)))
			if w.Code != 422 || v["code"] != "invalid_apk" {
				t.Fatalf("%d %s", w.Code, w.Body)
			}
			assertTransferDirectoryEmpty(t, filepath.Join(s.apkBase, "uficpy-uploads"))
		})
	}
}

func TestAPKTransferRejectsSharedTemporaryDirectory(t *testing.T) {
	s := testTransferService(t)
	path := filepath.Join(s.apkBase, "uficpy-uploads")
	if err := os.Mkdir(path, 0755); err != nil {
		t.Fatal(err)
	}
	w, _ := transferResponse(t, s, transferRequest(s, "/api/install", "a.apk", &unreadTransferBody{t}))
	if w.Code != 500 {
		t.Fatalf("unsafe staging directory accepted: %d %s", w.Code, w.Body)
	}
	assertTransferDirectoryEmpty(t, path)
}

func TestAPKInstallerCancellationReportsUnknown(t *testing.T) {
	s := testTransferService(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s.install = func(runCtx context.Context, _ *os.File, _ int64) (string, error) {
		cancel()
		<-runCtx.Done()
		return "", runCtx.Err()
	}
	r := transferRequest(s, "/api/install", "a.apk", bytes.NewReader(makeTransferAPK(t, "AndroidManifest.xml"))).WithContext(ctx)
	w, v := transferResponse(t, s, r)
	if w.Code != 499 || v["status_unknown"] != true {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	assertTransferDirectoryEmpty(t, filepath.Join(s.apkBase, "uficpy-uploads"))
}

func TestAPKTransferSuccessfulInstallerReadsExactBytes(t *testing.T) {
	s := testTransferService(t)
	apk := makeTransferAPK(t, "AndroidManifest.xml", "classes.dex")
	called := false
	s.install = func(ctx context.Context, f *os.File, size int64) (string, error) {
		called = true
		if _, ok := ctx.Deadline(); !ok {
			t.Error("installer has no deadline")
		}
		got, err := io.ReadAll(f)
		if err != nil || !bytes.Equal(got, apk) || size != int64(len(apk)) {
			t.Errorf("installer input mismatch: %v", err)
		}
		return "Performing Streamed Install\nSuccess\n", nil
	}
	w, v := transferResponse(t, s, transferRequest(s, "/api/install", "更新.APK", bytes.NewReader(apk)))
	if w.Code != 200 || v["ok"] != true || !called {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	assertTransferDirectoryEmpty(t, filepath.Join(s.apkBase, "uficpy-uploads"))
}

func TestAPKInstallerFailuresAndUnknownStatus(t *testing.T) {
	apk := makeTransferAPK(t, "AndroidManifest.xml")
	for _, tc := range []struct {
		name   string
		output string
		err    error
		status int
	}{
		{"pm failure", "Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE]", errors.New("exit status 1"), 422},
		{"no confirmation", "", nil, 422},
		{"false success substring", "NotSuccess", nil, 422},
		{"bounded output", strings.Repeat("x", 100000), errors.New("failed"), 422},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := testTransferService(t)
			s.install = func(context.Context, *os.File, int64) (string, error) { return tc.output, tc.err }
			w, v := transferResponse(t, s, transferRequest(s, "/api/install", "a.apk", bytes.NewReader(apk)))
			if w.Code != tc.status || v["code"] != "install_failed" {
				t.Fatalf("%d %s", w.Code, w.Body)
			}
			if len(v["detail"].(string)) > transferOutputLimit+100 {
				t.Fatal("unbounded pm output")
			}
			assertTransferDirectoryEmpty(t, filepath.Join(s.apkBase, "uficpy-uploads"))
		})
	}
	t.Run("timeout", func(t *testing.T) {
		s := testTransferService(t)
		s.installTimeout = 20 * time.Millisecond
		s.install = func(ctx context.Context, _ *os.File, _ int64) (string, error) { <-ctx.Done(); return "", ctx.Err() }
		w, v := transferResponse(t, s, transferRequest(s, "/api/install", "a.apk", bytes.NewReader(apk)))
		if w.Code != 504 || v["status_unknown"] != true {
			t.Fatalf("%d %s", w.Code, w.Body)
		}
		assertTransferDirectoryEmpty(t, filepath.Join(s.apkBase, "uficpy-uploads"))
	})
}

func TestTransferConcurrency(t *testing.T) {
	s := testTransferService(t)
	apk := makeTransferAPK(t, "AndroidManifest.xml")
	entered := make(chan struct{}, 2)
	release := make(chan struct{})
	s.install = func(context.Context, *os.File, int64) (string, error) {
		entered <- struct{}{}
		<-release
		return "Success", nil
	}
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			w, _ := transferResponse(t, s, transferRequest(s, "/api/install", "a.apk", bytes.NewReader(apk)))
			if w.Code != 200 {
				t.Errorf("%d %s", w.Code, w.Body)
			}
		}()
	}
	for i := 0; i < 2; i++ {
		select {
		case <-entered:
		case <-time.After(2 * time.Second):
			close(release)
			t.Fatal("installer did not start")
		}
	}
	w, _ := transferResponse(t, s, transferRequest(s, "/api/files", "busy", &unreadTransferBody{t}))
	if w.Code != 429 || w.Header().Get("Retry-After") == "" {
		t.Errorf("%d %s", w.Code, w.Body)
	}
	close(release)
	wg.Wait()
	assertTransferDirectoryEmpty(t, filepath.Join(s.apkBase, "uficpy-uploads"))
	w, _ = transferResponse(t, s, transferRequest(s, "/api/files", "after", strings.NewReader("ok")))
	if w.Code != 201 {
		t.Fatalf("capacity not released: %d %s", w.Code, w.Body)
	}
}

func TestTransferOutputBufferIsBounded(t *testing.T) {
	var b transferOutputBuffer
	input := bytes.Repeat([]byte("x"), transferOutputLimit*2)
	if n, err := b.Write(input); n != len(input) || err != nil {
		t.Fatal("discarded output reported as write failure")
	}
	if len(b.String()) > transferOutputLimit+100 || !strings.Contains(b.String(), "输出已截断") {
		t.Fatal("output not bounded")
	}
}
