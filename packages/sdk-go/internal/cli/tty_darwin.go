//go:build darwin

package cli

import (
	"os"
	"syscall"
	"unsafe"
)

// fdIsTTY asks the terminal itself. Node (process.stdin.isTTY / process.stdout.isTTY)
// and Python (isatty) both ask isatty(3), so this asks the same terminal ioctl rather
// than a Stat(): a character-device test also answers true for /dev/null, /dev/zero,
// and /dev/urandom, so `leji start < /dev/zero` prompted and then blocked forever on a
// line that never arrives, where the other two printed the fallback and exited 0.
// Dependency-free.
func fdIsTTY(fd uintptr) bool {
	var t syscall.Termios
	_, _, errno := syscall.Syscall6(
		syscall.SYS_IOCTL,
		fd,
		syscall.TIOCGETA,
		uintptr(unsafe.Pointer(&t)),
		0, 0, 0,
	)
	return errno == 0
}

// stdinIsTTY gates the host prompt and the post-scaffold handoff offer.
func stdinIsTTY() bool { return fdIsTTY(os.Stdin.Fd()) }

// stdoutIsTTY gates the Setup block's color, and nothing else. Separate from the
// prompt gate above: one asks whether a person can answer, the other whether a
// terminal is reading.
func stdoutIsTTY() bool { return fdIsTTY(os.Stdout.Fd()) }
