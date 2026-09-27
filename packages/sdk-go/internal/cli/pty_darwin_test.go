//go:build darwin

package cli

import (
	"bytes"
	"os"
	"syscall"
	"unsafe"
)

// openPTY opens a pseudo-terminal pair with nothing beyond the standard library: the
// slave answers the terminal ioctl stdinIsTTY asks, so a test can hand it to a run as
// its stdin.
func openPTY() (master, slave *os.File, err error) {
	m, err := os.OpenFile("/dev/ptmx", os.O_RDWR, 0)
	if err != nil {
		return nil, nil, err
	}
	// Grant and unlock take no argument. The name request writes into a buffer, so its
	// pointer is converted inside the syscall expression itself, where the unsafe
	// rules keep the memory valid for the call.
	ioctl := func(req uintptr) error {
		if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, m.Fd(), req, 0); errno != 0 {
			return errno
		}
		return nil
	}
	if err := ioctl(syscall.TIOCPTYGRANT); err != nil {
		m.Close()
		return nil, nil, err
	}
	if err := ioctl(syscall.TIOCPTYUNLK); err != nil {
		m.Close()
		return nil, nil, err
	}
	var name [128]byte
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, m.Fd(), syscall.TIOCPTYGNAME, uintptr(unsafe.Pointer(&name[0]))); errno != 0 {
		m.Close()
		return nil, nil, errno
	}
	n := bytes.IndexByte(name[:], 0)
	if n < 0 {
		n = len(name)
	}
	s, err := os.OpenFile(string(name[:n]), os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		m.Close()
		return nil, nil, err
	}
	return m, s, nil
}
