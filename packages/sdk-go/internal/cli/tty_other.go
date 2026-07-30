//go:build !darwin && !linux

package cli

import "os"

// stdinIsTTY on the platforms without a hand-written isatty here (Windows, and the
// Unixes the release does not build). The character-device test is an
// approximation — it also answers true for the platform's null device — but it is
// the pre-existing behavior everywhere, and the divergence it causes was only ever
// observed on the two platforms above, which now ask the terminal directly.
func stdinIsTTY() bool {
	fi, err := os.Stdin.Stat()
	return err == nil && fi.Mode()&os.ModeCharDevice != 0
}
