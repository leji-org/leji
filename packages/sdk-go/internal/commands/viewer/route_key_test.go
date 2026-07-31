package viewer

import "testing"

// The server matches routes against a forward-slashed prefix. Deriving the key
// through a platform-dependent clean answers differently per platform for a
// request carrying backslashes, so the prefix test misses and the request falls
// through to the chrome mount. These pin the contract on any platform, and match
// the reference implementation's table exactly.
func TestURLPathToRel(t *testing.T) {
	cases := map[string]string{
		"/content/boot-profile.md":     "content/boot-profile.md",
		"/content/agents/core.md":      "content/agents/core.md",
		"/content/_sidebar.md":         "content/_sidebar.md",
		"/":                            "",
		"/assets/app.js":               "assets/app.js",
		"/content":                     "content",
		"/content/../../etc/passwd":    "etc/passwd",
		"/content/..\\..\\etc\\passwd": "etc/passwd",
		"/content\\agents\\core.md":    "content/agents/core.md",
		"":                             "",
		".":                            "",
		"/content/":                    "content",
		"//content//core.md":           "content/core.md",
		"../../x":                      "x",
	}
	for in, want := range cases {
		if got := urlPathToRel(in); got != want {
			t.Errorf("urlPathToRel(%q) = %q, want %q", in, got, want)
		}
	}
}
