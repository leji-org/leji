// Command leji is the Go reference CLI for the Leji specification.
package main

import (
	"os"

	"github.com/leji-org/leji/packages/sdk-go/internal/cli"
)

func main() {
	os.Exit(cli.Run(os.Args[1:]))
}
