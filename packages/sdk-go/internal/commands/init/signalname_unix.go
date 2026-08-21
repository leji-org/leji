//go:build unix

package initcmd

import (
	"strconv"
	"syscall"
)

// signalNames maps the signals a package manager can plausibly die of to their
// canonical names, so the three SDKs print the same word: Go's Signal.String()
// renders SIGTERM as "terminated", which neither Node nor Python does.
//
// Unix table. The set differs per platform — Windows' syscall package defines a
// smaller one — so each build tag carries its own, and the SIG<n> fallback covers
// anything absent from either.
var signalNames = map[syscall.Signal]string{
	syscall.SIGHUP: "SIGHUP", syscall.SIGINT: "SIGINT", syscall.SIGQUIT: "SIGQUIT",
	syscall.SIGILL: "SIGILL", syscall.SIGTRAP: "SIGTRAP", syscall.SIGABRT: "SIGABRT",
	syscall.SIGBUS: "SIGBUS", syscall.SIGFPE: "SIGFPE", syscall.SIGKILL: "SIGKILL",
	syscall.SIGUSR1: "SIGUSR1", syscall.SIGSEGV: "SIGSEGV", syscall.SIGUSR2: "SIGUSR2",
	syscall.SIGPIPE: "SIGPIPE", syscall.SIGALRM: "SIGALRM", syscall.SIGTERM: "SIGTERM",
	syscall.SIGXCPU: "SIGXCPU", syscall.SIGXFSZ: "SIGXFSZ",
}

// SignalName is the canonical name of a signal, or SIG<n> for one this table does
// not carry.
func SignalName(sig syscall.Signal) string {
	if name, ok := signalNames[sig]; ok {
		return name
	}
	return "SIG" + strconv.Itoa(int(sig))
}
