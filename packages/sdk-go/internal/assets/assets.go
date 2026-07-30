// Package assets embeds the vendored schemas, templates, and cli.json.
package assets

import "embed"

//go:embed schemas templates cli.json
var FS embed.FS
