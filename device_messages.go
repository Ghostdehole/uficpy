package main

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"time"
	"unicode/utf8"
)

const maxDeviceClipboard = (1 << 18) - 5

type clipboardRequest struct {
	owner *client
	conn  net.Conn
	timer *time.Timer
}

// scrcpy 5 DeviceMessageWriter: clipboard (0,u32,text), acknowledgement
// (1,u64), UHID output (2,u16 device id,u16 length,bytes). Autosync stays off;
// a clipboard response is delivered only to its explicit request's viewer.
// The capture owner closes conn on cancellation and restarts after any error.
func consumeDeviceMessages(conn net.Conn, h *hub) error {
	var header [8]byte
	for {
		if _, err := io.ReadFull(conn, header[:1]); err != nil {
			return err
		}
		switch header[0] {
		case 0:
			if _, err := io.ReadFull(conn, header[:4]); err != nil {
				return fmt.Errorf("读取剪贴板长度: %w", err)
			}
			n := binary.BigEndian.Uint32(header[:4])
			if n > maxDeviceClipboard {
				return fmt.Errorf("设备剪贴板长度超出协议上限: %d", n)
			}
			data := make([]byte, int(n))
			if _, err := io.ReadFull(conn, data); err != nil {
				return fmt.Errorf("读取剪贴板内容: %w", err)
			}
			if !utf8.Valid(data) {
				return fmt.Errorf("设备剪贴板不是有效的 UTF-8 文本")
			}
			h.deliverClipboard(conn, string(data))
		case 1:
			if _, err := io.ReadFull(conn, header[:8]); err != nil {
				return fmt.Errorf("读取剪贴板确认: %w", err)
			}
		case 2:
			if _, err := io.ReadFull(conn, header[:4]); err != nil {
				return fmt.Errorf("读取 UHID 消息头: %w", err)
			}
			if _, err := io.CopyN(io.Discard, conn, int64(binary.BigEndian.Uint16(header[2:4]))); err != nil {
				return fmt.Errorf("读取 UHID 消息: %w", err)
			}
		default:
			return fmt.Errorf("未知设备控制消息: %d", header[0])
		}
	}
}

func (h *hub) clipboardReply(c *client, text, detail string) {
	if c == nil {
		return
	}
	reply := map[string]string{"type": "clipboard"}
	if detail != "" {
		reply["error"] = detail
	} else {
		reply["text"] = text
	}
	b, _ := json.Marshal(reply)
	h.mu.Lock()
	h.enqueue(c, message{1, b})
	h.mu.Unlock()
}

// All pending-request operations hold controlMu. A timeout detaches the owner
// and closes this generation rather than reassigning its untagged response.
func (h *hub) expireClipboard(r *clipboardRequest) {
	h.controlMu.Lock()
	defer h.controlMu.Unlock()
	if h.clipboard != r || r.conn != h.control {
		return
	}
	h.clipboardReply(r.owner, "", "设备未返回剪贴板，可能为空或系统不允许读取；采集连接将重新建立，进行中的录制会结束")
	r.owner = nil
	// Device.getClipboardText() may return null without sending a response.
	// Closing the stream makes the capture owner restart; keeping a tombstone
	// until then prevents an already-decoded late reply from changing owners.
	h.restoreDisplayLocked()
	r.conn.Close()
}

func (h *hub) finishClipboardLocked(text, detail string) {
	r := h.clipboard
	if r == nil {
		return
	}
	r.timer.Stop()
	h.clipboard = nil
	h.clipboardReply(r.owner, text, detail)
}

func (h *hub) deliverClipboard(conn net.Conn, text string) {
	h.controlMu.Lock()
	defer h.controlMu.Unlock()
	if conn != h.control || h.clipboard == nil || h.clipboard.conn != conn {
		return
	}
	h.finishClipboardLocked(text, "")
}
