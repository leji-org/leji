// Package assets embeds the vendored schemas, templates, and cli.json so the
// Go SDK ships them the same way the Node and Python SDKs bundle their copies.
package assets

import "embed"

//go:embed schemas templates cli.json
var FS embed.FS
