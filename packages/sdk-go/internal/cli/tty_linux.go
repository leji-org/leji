//go:build linux

package cli

import (
	"os"
	"syscall"
	"unsafe"
)

// fdIsTTY is the Linux half of the darwin implementation; see tty_darwin.go for why
// the terminal ioctl replaces a character-device stat. Same call, different request
// constant (TCGETS rather than TIOCGETA).
func fdIsTTY(fd uintptr) bool {
	var t syscall.Termios
	_, _, errno := syscall.Syscall6(
		syscall.SYS_IOCTL,
		fd,
		syscall.TCGETS,
		uintptr(unsafe.Pointer(&t)),
		0, 0, 0,
	)
	return errno == 0
}

// stdinIsTTY gates the host prompt and the post-scaffold handoff offer.
func stdinIsTTY() bool { return fdIsTTY(os.Stdin.Fd()) }

// stdoutIsTTY gates the Setup block's color, and nothing else.
func stdoutIsTTY() bool { return fdIsTTY(os.Stdout.Fd()) }
