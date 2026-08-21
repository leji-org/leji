//go:build windows

package initcmd

import (
	"strconv"
	"syscall"
)

// signalNames maps the signals a package manager can plausibly die of to their
// canonical names, so the three SDKs print the same word.
//
// Windows table: only the signals Windows' syscall package defines. A Windows
// child is not killed by a POSIX signal, so this exists for shape parity rather
// than for a path a Windows adopter reaches; the SIG<n> fallback covers the rest.
var signalNames = map[syscall.Signal]string{
	syscall.SIGHUP: "SIGHUP", syscall.SIGINT: "SIGINT", syscall.SIGQUIT: "SIGQUIT",
	syscall.SIGILL: "SIGILL", syscall.SIGTRAP: "SIGTRAP", syscall.SIGABRT: "SIGABRT",
	syscall.SIGBUS: "SIGBUS", syscall.SIGFPE: "SIGFPE", syscall.SIGKILL: "SIGKILL",
	syscall.SIGSEGV: "SIGSEGV", syscall.SIGPIPE: "SIGPIPE", syscall.SIGALRM: "SIGALRM",
	syscall.SIGTERM: "SIGTERM",
}

// SignalName is the canonical name of a signal, or SIG<n> for one this table does
// not carry.
func SignalName(sig syscall.Signal) string {
	if name, ok := signalNames[sig]; ok {
		return name
	}
	return "SIG" + strconv.Itoa(int(sig))
}
