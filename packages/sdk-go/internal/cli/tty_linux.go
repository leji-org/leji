//go:build linux

package cli

import (
	"os"
	"syscall"
	"unsafe"
)

// stdinIsTTY is the Linux half of the darwin implementation; see tty_darwin.go for
// why the terminal ioctl replaces a character-device stat. Same call, different
// request constant (TCGETS rather than TIOCGETA).
func stdinIsTTY() bool {
	var t syscall.Termios
	_, _, errno := syscall.Syscall6(
		syscall.SYS_IOCTL,
		os.Stdin.Fd(),
		syscall.TCGETS,
		uintptr(unsafe.Pointer(&t)),
		0, 0, 0,
	)
	return errno == 0
}
