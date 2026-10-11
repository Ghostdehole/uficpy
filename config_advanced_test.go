package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestNativeQualityAndArguments(t *testing.T) {
	c := defaults()
	c.MaxSize = 0
	c.MaxFps = 0
	c.BitRate = 100000000
	c.VideoEncoder = "c2.qti.avc.encoder"
	c.Crop = "1080:1920:0:0"
	if e := c.validate(false); e != nil {
		t.Fatal(e)
	}
	args := strings.Join(captureArgs(c, 0x42), "\n")
	for _, value := range []string{"max_size=0", "max_fps=0", "video_bit_rate=100000000", "video_encoder=c2.qti.avc.encoder", "downsize_on_error=false", "max-bframes=0", "send_stream_meta=false", "audio=false"} {
		if !strings.Contains(args, value) {
			t.Fatalf("missing %s", value)
		}
	}
	for _, options := range []string{"max-bframes=1", "i-frame-interval=1", "max-bframes=0,max-bframes=2", "max-bframes=0\ncontrol=false"} {
		c.VideoCodecOptions = options
		if c.validate(false) == nil {
			t.Fatalf("accepted %q", options)
		}
	}
}
func TestConfigurableControlPolicy(t *testing.T) {
	c := defaults()
	b := make([]byte, 14)
	for _, code := range []uint32{24, 25, 164} {
		binary.BigEndian.PutUint32(b[2:], code)
		c.AllowVolumeKeys = false
		c.AllowedKeys = []uint32{code}
		if validControlFor(b, c) {
			t.Fatal("volume enabled by default or whitelist bypassed opt-in")
		}
		c.AllowVolumeKeys = true
		if !validControlFor(b, c) {
			t.Fatal("explicit volume setting ignored")
		}
	}
	c.AllowedKeys = []uint32{66}
	binary.BigEndian.PutUint32(b[2:], 4)
	if validControlFor(b, c) {
		t.Fatal("non-whitelisted key accepted")
	}
	binary.BigEndian.PutUint32(b[2:], 66)
	if !validControlFor(b, c) {
		t.Fatal("custom whitelist ignored")
	}
}
func TestReviewedCore(t *testing.T) {
	if err := verifyCore("."); err != nil {
		t.Fatal(err)
	}
}

func TestTLSRequiresAbsolutePathsAndValidPair(t *testing.T) {
	for _, paths := range [][2]string{
		{"certs/server.crt", "certs/server.key"},
		{"/data/uficpy/certs/server.crt", "certs/server.key"},
		{"certs/server.crt", "/data/uficpy/certs/server.key"},
	} {
		c := defaults()
		c.TLSCert, c.TLSKey = paths[0], paths[1]
		if e := c.validate(false); e == nil || !strings.Contains(e.Error(), "绝对路径") {
			t.Fatalf("relative TLS path did not produce actionable error: %v", e)
		}
	}
	// Verify that the path restriction still accepts a real, loadable key pair.
	key, e := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	now := time.Now()
	cert := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "localhost"}, NotBefore: now.Add(-time.Minute), NotAfter: now.Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, e := x509.CreateCertificate(rand.Reader, cert, cert, &key.PublicKey, key)
	if e != nil {
		t.Fatal(e)
	}
	keyDER, e := x509.MarshalECPrivateKey(key)
	if e != nil {
		t.Fatal(e)
	}
	c := defaults()
	dir := t.TempDir()
	c.TLSCert, c.TLSKey = filepath.Join(dir, "server.crt"), filepath.Join(dir, "server.key")
	for path, block := range map[string]*pem.Block{c.TLSCert: {Type: "CERTIFICATE", Bytes: der}, c.TLSKey: {Type: "EC PRIVATE KEY", Bytes: keyDER}} {
		if e = os.WriteFile(path, pem.EncodeToMemory(block), 0600); e != nil {
			t.Fatal(e)
		}
	}
	if e = c.validate(false); e != nil {
		t.Fatalf("valid absolute TLS paths rejected: %v", e)
	}
	if e = os.WriteFile(c.TLSKey, []byte("invalid private key"), 0600); e != nil {
		t.Fatal(e)
	}
	if e = c.validate(false); e == nil || !strings.Contains(e.Error(), "TLS 证书或私钥无效") {
		t.Fatalf("absolute path bypassed key-pair verification: %v", e)
	}
}
