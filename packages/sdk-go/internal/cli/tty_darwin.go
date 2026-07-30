//go:build darwin

package cli

import (
	"os"
	"syscall"
	"unsafe"
)

// stdinIsTTY gates the host prompt and the post-scaffold handoff offer. Node
// (process.stdin.isTTY) and Python (sys.stdin.isatty) both ask isatty(3), so this
// asks the same terminal ioctl rather than os.Stdin.Stat(): a character-device
// test also answers true for /dev/null, /dev/zero, and /dev/urandom, so
// `leji start < /dev/zero` prompted and then blocked forever on a line that never
// arrives, where the other two printed the fallback and exited 0. Dependency-free.
func stdinIsTTY() bool {
	var t syscall.Termios
	_, _, errno := syscall.Syscall6(
		syscall.SYS_IOCTL,
		os.Stdin.Fd(),
		syscall.TIOCGETA,
		uintptr(unsafe.Pointer(&t)),
		0, 0, 0,
	)
	return errno == 0
}
