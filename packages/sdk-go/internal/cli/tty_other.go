//go:build !darwin && !linux

package cli

import "os"

// fileIsTTY on the platforms without a hand-written isatty here (Windows, and the
// Unixes the release does not build). The character-device test is an
// approximation — it also answers true for the platform's null device — but it is
// the pre-existing behavior everywhere, and the divergence it causes was only ever
// observed on the two platforms above, which now ask the terminal directly.
func fileIsTTY(f *os.File) bool {
	fi, err := f.Stat()
	return err == nil && fi.Mode()&os.ModeCharDevice != 0
}

// stdinIsTTY gates the host prompt and the post-scaffold handoff offer.
func stdinIsTTY() bool { return fileIsTTY(os.Stdin) }

// stdoutIsTTY gates the Setup block's color, and nothing else.
func stdoutIsTTY() bool { return fileIsTTY(os.Stdout) }
