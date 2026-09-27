//go:build !darwin && !linux

package cli

import (
	"errors"
	"os"
)

// openPTY has no standard-library implementation here; the terminal cases skip.
func openPTY() (master, slave *os.File, err error) {
	return nil, nil, errors.New("no pseudo-terminal on this platform")
}
