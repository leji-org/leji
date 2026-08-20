package initcmd

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"

	"github.com/leji-org/leji/packages/sdk-go/internal/ecosystem"
)

// --- the generated CI job -------------------------------------------------
// One table, one job resolution, four renderers. Every cell an adopter's pipeline
// runs is stated here rather than assembled at the call site, so the three SDKs
// transcribe data instead of re-deriving prose, and a reviewer reads the matrix.

// CIProviders is every provider `leji ci` generates for, in a fixed order.
var CIProviders = []string{"github", "gitlab", "circleci", "azure"}

// ciManagerCell holds one package manager's CI facts. pipBootstrap names a tool
// that has to be installed with pip wherever the provider offers no dedicated
// setup action; unpinned names a bootstrap tool the job installs unpinned,
// disclosed in one comment line.
type ciManagerCell struct {
	runtime      string
	install      string
	pipBootstrap string
	unpinned     string
}

// ciManagerOrder is the fixed enumeration order of the manager cells; Go maps do
// not preserve insertion order and the golden fixtures depend on it.
var ciManagerOrder = []string{"npm", "pnpm", "yarn", "bun", "uv", "poetry", "pdm", "pipenv", "go"}

// ciManagers maps a manager to its install command and runtime. The runner argv is
// NOT duplicated here: it comes from the detection report, which owns the one
// runner table.
var ciManagers = map[string]ciManagerCell{
	"npm":    {runtime: "node", install: "npm ci"},
	"pnpm":   {runtime: "node", install: "corepack enable && pnpm install --frozen-lockfile"},
	"yarn":   {runtime: "node", install: "corepack enable && yarn install --frozen-lockfile"},
	"bun":    {runtime: "bun", install: "bun install --frozen-lockfile"},
	"uv":     {runtime: "python", install: "uv sync --locked", pipBootstrap: "uv"},
	"poetry": {runtime: "python", install: "pip install poetry && poetry install", unpinned: "poetry"},
	"pdm":    {runtime: "python", install: "pip install pdm && pdm install", unpinned: "pdm"},
	"pipenv": {runtime: "python", install: "pip install pipenv && pipenv install --dev", unpinned: "pipenv"},
	"go":     {runtime: "go", install: "go mod download"},
}

// ciJob is the one job a provider renders: what to set up, what to install, what
// to run.
type ciJob struct {
	runtime  string
	install  []string
	runner   []string
	unpinned string
	uvAction bool
	local    bool
}

// The CLI as CI reaches it when the repository does not declare it: version-pinned
// to the current major, which is additive-only, so a valid layer stays valid and a
// breaking major never reaches adopter CI without a bump.
var ciFallbackNode = []string{"npx", "-y", ecosystem.DepName + "@1"}

const ciFallbackPyInstall = "pip install 'leji>=1,<2'"
const ciFallbackGoInstall = "go install github.com/leji-org/leji/packages/sdk-go/cmd/leji@latest"

// resolveCiJob decides which job this repository gets. Local-first: a repository
// that DECLARES the CLI and has the manager's lock evidence installs its own
// locked dependencies and runs the local binary. Everything else — undeclared,
// unlocked, ambiguous, unsupported, unreadable, refused evidence, several
// ecosystems, none — takes the fallback for its ecosystem, which needs no manifest
// and no lockfile.
func resolveCiJob(report ecosystem.Report, provider string) ciJob {
	selected := report.Selected
	if selected != nil && selected.Manager != nil && selected.DirectDeclared && selected.LockEvidenced && selected.Runner != nil {
		if cell, ok := ciManagers[*selected.Manager]; ok {
			// uv is the one manager with a first-party setup action; everywhere else it
			// is pip-installed like poetry/pdm/pipenv, and disclosed the same way.
			uvAction := provider == "github" && cell.pipBootstrap == "uv"
			bootstrap := ""
			if cell.pipBootstrap != "" && !uvAction {
				bootstrap = cell.pipBootstrap
			}
			install := cell.install
			if bootstrap != "" {
				install = "pip install " + bootstrap + " && " + cell.install
			}
			unpinned := cell.unpinned
			if unpinned == "" {
				unpinned = bootstrap
			}
			return ciJob{
				runtime: cell.runtime, install: []string{install}, runner: selected.Runner,
				unpinned: unpinned, uvAction: uvAction, local: true,
			}
		}
	}
	eco := ""
	if len(report.All) == 1 {
		eco = report.All[0].Ecosystem
	}
	if eco == "python" {
		return ciJob{runtime: "python", install: []string{ciFallbackPyInstall}, runner: []string{"leji"}}
	}
	if eco == "go" {
		return ciJob{runtime: "go", install: []string{ciFallbackGoInstall}, runner: []string{"leji"}}
	}
	// Node, several ecosystems, and none alike: the job that needs no package manager.
	return ciJob{runtime: "node", install: []string{}, runner: ciFallbackNode}
}

// ciGeneratorVersion is the generator schema version. Bumped when the generated
// shape changes, so the marker says which generation wrote a file; pre-1.4 output
// is implicitly v1.
const ciGeneratorVersion = "2"

// CIMarker is the ownership claim every generated whole file opens with.
const CIMarker = "# generated by leji ci (managed) v" + ciGeneratorVersion

// unpinnedNote is the one disclosure line for a job that installs a bootstrap tool
// unpinned.
func unpinnedNote(job ciJob) string {
	if job.unpinned == "" {
		return ""
	}
	return "# " + job.unpinned + " is installed unpinned here; pin it if your project pins it."
}

// githubSetup renders the GitHub Actions setup steps for a runtime, already at the
// steps' indentation.
func githubSetup(job ciJob) []string {
	switch job.runtime {
	case "node":
		return []string{"      - uses: actions/setup-node@v4", "        with:", "          node-version: '22'"}
	case "bun":
		return []string{"      - uses: oven-sh/setup-bun@v2"}
	case "python":
		lines := []string{"      - uses: actions/setup-python@v5", "        with:", "          python-version: '3.12'"}
		if job.uvAction {
			lines = append(lines, "      - uses: astral-sh/setup-uv@v5")
		}
		return lines
	default:
		return []string{"      - uses: actions/setup-go@v5", "        with:", "          go-version: '1.24'"}
	}
}

func buildGithubWorkflow(job ciJob) string {
	lines := []string{
		CIMarker,
		"name: leji",
		"on: [push, pull_request]",
		"jobs:",
		"  validate:",
		"    runs-on: ubuntu-latest",
		"    steps:",
		"      - uses: actions/checkout@v4",
	}
	lines = append(lines, githubSetup(job)...)
	if note := unpinnedNote(job); note != "" {
		lines = append(lines, "      "+note)
	}
	for _, cmd := range job.install {
		lines = append(lines, "      - run: "+cmd)
	}
	runner := strings.Join(job.runner, " ")
	lines = append(lines, "      - run: "+runner+" validate", "      - run: "+runner+" index --check")
	return strings.Join(lines, "\n") + "\n"
}

// ciImage is the container image a job runs in on the image-based providers.
func ciImage(runtime string) string {
	switch runtime {
	case "node":
		return "node:22"
	case "bun":
		return "oven/bun:1"
	case "python":
		return "python:3.12"
	default:
		return "golang:1.24"
	}
}

func buildGitlabBlock(job ciJob) string {
	// `.pre` is always available. Without an explicit stage GitLab assigns `test`,
	// and a pipeline whose own `stages:` list omits `test` rejects the whole
	// configuration, so the generated job would break an existing pipeline it was
	// merged into.
	lines := []string{
		gitlabMarkerStart,
		"leji-validate:",
		"  stage: .pre",
		"  image: " + ciImage(job.runtime),
		"  script:",
	}
	if note := unpinnedNote(job); note != "" {
		lines = append(lines, "    "+note)
	}
	for _, cmd := range job.install {
		lines = append(lines, "    - "+cmd)
	}
	runner := strings.Join(job.runner, " ")
	lines = append(lines, "    - "+runner+" validate", "    - "+runner+" index --check", gitlabMarkerEnd)
	return strings.Join(lines, "\n") + "\n"
}

// circleCiJob renders the CircleCI job steps, shared by the full config and the
// hand-add snippet.
func circleCiJob(job ciJob) []string {
	lines := []string{
		"jobs:",
		"  leji-validate:",
		"    docker:",
		"      - image: " + ciImage(job.runtime),
		"    steps:",
		"      - checkout",
	}
	if note := unpinnedNote(job); note != "" {
		lines = append(lines, "      "+note)
	}
	for _, cmd := range job.install {
		lines = append(lines, "      - run: "+cmd)
	}
	runner := strings.Join(job.runner, " ")
	lines = append(lines,
		"      - run: "+runner+" validate",
		"      - run: "+runner+" index --check",
		"workflows:", "  leji:", "    jobs:", "      - leji-validate")
	return lines
}

func buildCircleCiConfig(job ciJob) string {
	return strings.Join(append([]string{CIMarker, "version: 2.1"}, circleCiJob(job)...), "\n") + "\n"
}

// buildCircleCiSnippet is the jobs + workflows fragment to add by hand to an
// existing CircleCI config. No marker: it is pasted into a file leji does not own.
func buildCircleCiSnippet(job ciJob) string {
	return strings.Join(circleCiJob(job), "\n") + "\n"
}

// azureSetup renders the Azure Pipelines setup tasks for a runtime, at the steps'
// indentation.
func azureSetup(job ciJob) []string {
	switch job.runtime {
	case "node":
		return []string{"  - task: NodeTool@0", "    inputs:", "      versionSpec: '22.x'"}
	case "bun":
		return []string{
			"  - task: NodeTool@0", "    inputs:", "      versionSpec: '22.x'",
			"  - script: npm install -g bun", "    displayName: install bun",
		}
	case "python":
		return []string{"  - task: UsePythonVersion@0", "    inputs:", "      versionSpec: '3.12'"}
	default:
		return []string{"  - task: GoTool@0", "    inputs:", "      version: '1.24'"}
	}
}

func buildAzurePipeline(job ciJob) string {
	lines := []string{CIMarker, "trigger:", "  - main", "pool:", "  vmImage: ubuntu-latest", "steps:"}
	lines = append(lines, azureSetup(job)...)
	if note := unpinnedNote(job); note != "" {
		lines = append(lines, "  "+note)
	}
	for _, cmd := range job.install {
		lines = append(lines, "  - script: "+cmd, "    displayName: install")
	}
	runner := strings.Join(job.runner, " ")
	lines = append(lines,
		"  - script: "+runner+" validate", "    displayName: leji validate",
		"  - script: "+runner+" index --check", "    displayName: leji index --check")
	return strings.Join(lines, "\n") + "\n"
}

// buildCiFile renders the whole file a provider writes for a job; GitLab's is the
// block it owns inside a shared file.
func buildCiFile(provider string, job ciJob) string {
	switch provider {
	case "github":
		return buildGithubWorkflow(job)
	case "gitlab":
		return buildGitlabBlock(job)
	case "circleci":
		return buildCircleCiConfig(job)
	default:
		return buildAzurePipeline(job)
	}
}

// CiVariant is one artifact of the current generator.
type CiVariant struct {
	Provider string
	Key      string
	Bytes    string
}

// ciJobVariants enumerates every job this generator can produce, in a fixed order:
// the nine local manager cells, then the three ecosystem fallbacks. The
// enumeration is what proves the digest registry complete and what checks the
// golden fixtures.
func ciJobVariants(provider string) []struct {
	key string
	job ciJob
} {
	out := []struct {
		key string
		job ciJob
	}{}
	for _, manager := range ciManagerOrder {
		cell := ciManagers[manager]
		uvAction := provider == "github" && cell.pipBootstrap == "uv"
		bootstrap := ""
		if cell.pipBootstrap != "" && !uvAction {
			bootstrap = cell.pipBootstrap
		}
		install := cell.install
		if bootstrap != "" {
			install = "pip install " + bootstrap + " && " + cell.install
		}
		unpinned := cell.unpinned
		if unpinned == "" {
			unpinned = bootstrap
		}
		runner := ecosystem.ManagerRunnerArgv(manager)
		if runner == nil {
			runner = []string{"leji"}
		}
		out = append(out, struct {
			key string
			job ciJob
		}{
			key: manager + "-local",
			job: ciJob{
				runtime: cell.runtime, install: []string{install}, runner: runner,
				unpinned: unpinned, uvAction: uvAction, local: true,
			},
		})
	}
	out = append(out,
		struct {
			key string
			job ciJob
		}{key: "node-fallback", job: ciJob{runtime: "node", install: []string{}, runner: ciFallbackNode}},
		struct {
			key string
			job ciJob
		}{key: "python-fallback", job: ciJob{runtime: "python", install: []string{ciFallbackPyInstall}, runner: []string{"leji"}}},
		struct {
			key string
			job ciJob
		}{key: "go-fallback", job: ciJob{runtime: "go", install: []string{ciFallbackGoInstall}, runner: []string{"leji"}}},
	)
	return out
}

// CiVariants returns every generated artifact of the CURRENT generator: provider,
// variant key, and bytes. Exported for the tests that check
// fixtures/ci-goldens/ and prove the digest registry lists every variant this
// release can write.
func CiVariants() []CiVariant {
	out := []CiVariant{}
	for _, provider := range CIProviders {
		for _, v := range ciJobVariants(provider) {
			out = append(out, CiVariant{Provider: provider, Key: v.key, Bytes: buildCiFile(provider, v.job)})
		}
	}
	return out
}

// knownGenerated holds digests of every whole file this generator has ever
// written, so a file leji created in an EARLIER release is still recognized as its
// own and upgraded rather than abandoned. Appended at each release; the marker line
// carries the generator version that wrote a file, and these digests carry the ones
// that predate it.
//
// Keyed by provider, and consulted only for the provider whose path is being
// written: the same bytes are leji's workflow at .github/workflows/leji.yml and
// somebody else's file at .azure-pipelines/leji.yml.
//
// Seeded with the pre-1.4 (1.3.x) variants, which carry no marker at all: two per
// whole-file provider, the local-install job and the `npx @leji-org/leji@1`
// fallback. Each release since appends its own twelve at pre-flight, enumerated by
// CiVariants() and printed by a test, so the next release still recognizes them;
// while a release is current its variants are also compared by bytes, which is
// strictly stronger.
var knownGenerated = map[string][]string{
	// 1.3.x GitHub Actions: local install, then the npx fallback.
	"github": {
		"ef38ea0bc0daa13b9856ca9abeb5f2229ae2465aeed2f61bd94f557a1806f13d",
		"1c2afeb4d3043f94823ac0c1a254a8735c0fe87844cd454cf8ae07fbfa6588d4",
		// 1.4.0: the twelve job variants, in ciVariants() order.
		"616638c5c1594e8faeb38cd476b9c5e0a4d12889a01b54076a0f8ffceba8a1a8", // npm-local
		"1b9afce2109d75c86ba3e3b33abd2466d55509d7e46b5ef79a9407d3df566154", // pnpm-local
		"e16f877d33a5be6e2c720112692167e9442fb5c63a2335f95401b7a891d46e18", // yarn-local
		"e0819c85b4b3e540472fa5d2a3820ae0c4837a41b66cc97de84581c1b19ede96", // bun-local
		"7b3d400ea23799ebf26541bffe059db4e9f60021fdf0f783c1f1cfa7a532816d", // uv-local
		"87089be204a85a61dfcfbcb9f4a9f2ad2f5afc8b00f384d52dfbd81c63e0296f", // poetry-local
		"48b3c7a1751b65bbea29421e7e952ac8c2720169ff332ea0e277573a2fb582c0", // pdm-local
		"809d7ee991b8c1182442d93e326d4dc3ad9e0993f91f4da83aac8187c98e90bb", // pipenv-local
		"e952a6109a05d97adc2791f641f807245c75ba401ced279964b06fcc2987b92e", // go-local
		"ae3385d9deac83936000100621078011b1918a66237d4ae1ef72770dc677914a", // node-fallback
		"b0be130068ad150eb7f59a2166a4fc22601e10ec961d2144d4c158602fde1f9c", // python-fallback
		"91b37a1c14fcc6f237d9600b8f49bb936eb2091f418fe8932fc94cdbfe91454f", // go-fallback
	},
	// GitLab owns a marked block inside a shared file, never a whole file, so it
	// recognizes its own output by the markers and registers no digests.
	"gitlab": {},
	"circleci": {
		"99a942be4f0ac62672af68a9d33e17328441e64f3b28b52ff8dafede0a5ce9f0",
		"cf813aa8c65a5efa64500628bc51c73d3ae3a5f56ec47386f5525de0828818d3",
		// 1.4.0: the twelve job variants, in ciVariants() order.
		"e72c78146170d54a4b79326b3a8933ba0ca54bf76be665b45f47009729a864b1", // npm-local
		"039559039ccda2dca14da3366cb1ca56895f4eaf48a395a7dd75f4a3614dabc1", // pnpm-local
		"ba5303502b7fc3e70174b163666fe27af855663b2b66900a0e1affcd3ee3290b", // yarn-local
		"e46e865183f764c1d6bf594e9d074744911221232db2805ea3de3896fa920ce4", // bun-local
		"4b974432dc0d1939a89e8ca9c130ec16c70e1aeb1252fd5895785018e9e84f98", // uv-local
		"3cc62af0609c563e0268e632285d28d7365c4ce81652e1c0d9f3f62496f01665", // poetry-local
		"b519fa8e216b62a8da7ce0f98b53de81dde62f4c3bed924b7fbc59b7b5f8af1f", // pdm-local
		"6786b3df303d00239170bf0365e7ff66662fcfc0912ea6cd992547e1422eed9a", // pipenv-local
		"43ca7c5fce284555d5b72a6cd69c153e295ae01f921dd5e2b755e11d4e3e9e8f", // go-local
		"b82f65f616ec46445e43b8c1680618428cce89ee17e69f0a1e2b94b4ace2fc9b", // node-fallback
		"0d2135d41e50be5fa6811bdc9aa85fc0ce4110ec918e17c139cd969087834e4b", // python-fallback
		"704a4b3c3f8880c505e181eed154234e4640cdad5d13a3c9dfe5b4cdcdfbd3d9", // go-fallback
	},
	"azure": {
		"71fb19e18660e84ec4a2b9364ea6a9dea0ca7aff8bb52ede8d5c3f4d77c68669",
		"7a086e5cd0f2e8a2e67b925ec54b8e8febb1bca016e1893c95fd00815d86c63a",
		// 1.4.0: the twelve job variants, in ciVariants() order.
		"9c8127bfb670731eb08089b02a1adecc135bc32524699793e83e23eb4143e4f1", // npm-local
		"099befce80e7420297583ee3a88bed97f01c073dbb756bbf64ad37b321eb506a", // pnpm-local
		"5d1f2642c97954b6fca52fa8239534c5633cc3bc512c7946f2515473bde58bb7", // yarn-local
		"9e60a214631033172e3021d773581f15db14c3e1e05d1673f05d7752ff054b03", // bun-local
		"c4d041736cedbd2092667480bbaf91711f3696997256456fa276a59660c66555", // uv-local
		"2913197fc21a1fbf3587695af2b2d2215b6f9966507b542ecc08e44727b5bf2b", // poetry-local
		"f756c8ea1ff653d4bed01ac60aa9ba26b426936cf19a5be54508a166e66ca6f6", // pdm-local
		"7a452ce135e706fdada5f953a18bdaafb0fd453650d061b0e07f62e5309d6d58", // pipenv-local
		"ce1b7546d140ba09838e9af8dab92ecebf75f20c7e7714c2eeb210ab1f1422d3", // go-local
		"1a4167a0b4b3a5b7528d7a6d0bcefeabd37f617b02f82772fd6c74c148d9e17e", // node-fallback
		"c9cd3d115cb4f4d9db1b3f523cfbbf1397923df6142c58e5e6c8562ff57fa908", // python-fallback
		"23679c491cbd53e39ffc5d940de7b97865f1b944bf55ad1bd7e73b8c57520606", // go-fallback
	},
}

// isLejiGenerated reports whether this file is leji's to replace: yes when its
// bytes are one this generator can write right now, or when its digest is one an
// earlier release wrote. A file the user edited matches neither, and is left alone
// with a snippet — editing a generated file, or deleting its marker, is the
// explicit opt-out, and it is honored.
func isLejiGenerated(provider, text string) bool {
	for _, v := range CiVariants() {
		if v.Provider == provider && v.Bytes == text {
			return true
		}
	}
	sum := sha256.Sum256([]byte(text))
	digest := hex.EncodeToString(sum[:])
	// Scoped to THIS provider: a file that is leji's at one provider's path is a
	// foreign file at another's, and a foreign file is never replaced.
	for _, known := range knownGenerated[provider] {
		if known == digest {
			return true
		}
	}
	return false
}
