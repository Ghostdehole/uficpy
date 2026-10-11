package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
)

type displayBackup struct {
	Size    string `json:"size"`
	Density string `json:"density"`
}

func wm(kind, value string) error {
	out, e := exec.Command("wm", kind, value).CombinedOutput()
	if e != nil {
		return fmt.Errorf("wm %s: %w: %s", kind, e, out)
	}
	return nil
}
func backupDisplay(dir string) error {
	path := filepath.Join(dir, "display-backup.json")
	if _, e := os.Stat(path); e == nil {
		return nil
	} else if !os.IsNotExist(e) {
		return e
	}
	b := displayBackup{Size: "reset", Density: "reset"}
	for _, kind := range []string{"size", "density"} {
		out, e := exec.Command("wm", kind).CombinedOutput()
		if e != nil {
			return fmt.Errorf("读取 wm %s: %w", kind, e)
		}
		pattern := `(?m)Override size:\s*([0-9]+x[0-9]+)`
		if kind == "density" {
			pattern = `(?m)Override density:\s*([0-9]+)`
		}
		m := regexp.MustCompile(pattern).FindSubmatch(out)
		if len(m) > 1 {
			if kind == "size" {
				b.Size = string(m[1])
			} else {
				b.Density = string(m[1])
			}
		}
	}
	data, _ := json.Marshal(b)
	return os.WriteFile(path, data, 0600)
}
func restoreDisplay(dir string) error {
	path := filepath.Join(dir, "display-backup.json")
	data, e := os.ReadFile(path)
	if e != nil {
		return e
	}
	var b displayBackup
	if e = json.Unmarshal(data, &b); e != nil {
		return e
	}
	if b.Size != "reset" && !sizePattern.MatchString(b.Size) {
		return fmt.Errorf("无效分辨率备份")
	}
	if b.Density != "reset" && !regexp.MustCompile(`^[0-9]{2,4}$`).MatchString(b.Density) {
		return fmt.Errorf("无效密度备份")
	}
	if e = wm("size", b.Size); e != nil {
		return e
	}
	if e = wm("density", b.Density); e != nil {
		return e
	}
	return os.Remove(path)
}
func applyDisplay(dir string, c Config) error {
	if c.WmSize == "" && c.WmDensity == 0 {
		return nil
	}
	if e := backupDisplay(dir); e != nil {
		return e
	}
	if c.WmSize != "" {
		if e := wm("size", c.WmSize); e != nil {
			return e
		}
	}
	if c.WmDensity != 0 {
		return wm("density", fmt.Sprint(c.WmDensity))
	}
	return nil
}
