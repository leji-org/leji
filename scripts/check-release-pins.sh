#!/usr/bin/env sh
# Release-path pin checker.
#
# Every install the release path performs must name an exact version, every
# action must be pinned to a commit SHA, every tool a workflow reaches for must
# name its release, and the local publish gate must use the same twine the
# pinned publish action bundles. Otherwise a tag that was green yesterday
# publishes through whatever a resolver picked today, and the failure lands
# after the tag, where nothing can be corrected in place.
#
#   sh scripts/check-release-pins.sh [root]      # scan a tree (default: this repo)
#   sh scripts/check-release-pins.sh --self-test # prove the rules on the fixtures
#
# Scanned: .github/workflows/*.yml, packages/sdk-py/pyproject.toml, scripts/*.sh
# and scripts/lib/*.sh (the guard scans the scripts it adds). Executable
# occurrences only: comment lines and trailing comments are skipped, YAML is read
# inside `run:` blocks (continuation lines joined) and in the keys that select a
# tool, TOML inside string values.
#
# Rules, reported as `path:line: rule N: ...`:
#   1  no floating install: @latest, or pip's --upgrade
#   2  every pip install requirement is name==X.Y.Z; no expansion but a tuple
#      version, no glob, no requirements file (one marked exception, below)
#   3  every `npm install -g` package names an exact @X.Y.Z, and no npm install
#      target is a shell expansion (the same marked exception)
#   4  every uses: is pinned to a 40-character commit SHA (the comment is not a pin)
#   5  every go-version names a patch component
#   6  the Python build requirements and dev extras are exact
#   7  the pinned publish action, its version comment, the twine the local gate
#      installs, and every pip/build/twine/jsr/goreleaser version in the tree
#      equal scripts/release-pins.env
#   8  every `npx <pkg>` / `npm exec <pkg>` names an exact <pkg>@X.Y.Z
#   9  every `version:` input to a `*-action` names an exact version, never a range
#
# The one exception, because a smoke test must install the artifacts it just
# built: an install target on a line ending with the marker
# `# release-pins: local artifact built above`, rooted at $ROOT/ or $TMP/, and
# ending in a literal `.tgz` (npm) or `.whl` / `.tar.gz` (pip). Never a URL,
# never a trailing expansion. Every such line is counted and the count is
# printed on every run, so the allowlist is never invisible.
#
# Exit: 0 clean, 1 violations found, 2 usage or environment error. A file that
# cannot be read or scanned is an environment error, never a clean result.

set -u

usage() {
   echo "usage: sh scripts/check-release-pins.sh [root]"
   echo "       sh scripts/check-release-pins.sh --self-test"
}

self_test=0
scan_target=""
for arg in "$@"; do
   case "$arg" in
      --self-test) self_test=1 ;;
      -h | --help)
         usage
         exit 0
         ;;
      -*)
         echo "check-release-pins: unknown option: $arg" >&2
         usage >&2
         exit 2
         ;;
      *) scan_target="$arg" ;;
   esac
done

# Every tool this script needs, checked before anything is reported: a missing
# awk must not read as a clean tree.
for _tool in awk grep sed sort tr basename mktemp; do
   if ! command -v "$_tool" >/dev/null 2>&1; then
      echo "check-release-pins: required tool not found: $_tool" >&2
      exit 2
   fi
done

unset CDPATH
script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
repo_root="$(dirname -- "$script_dir")"
pins_env="$script_dir/release-pins.env"
pins_lib="$script_dir/lib/release-pins.sh"
if [ ! -f "$pins_lib" ]; then
   echo "check-release-pins: missing scripts/lib/release-pins.sh" >&2
   exit 2
fi
# The tuple always comes from this repository, whatever tree is being scanned:
# it is the one source of truth the scanned tree is compared against, and it is
# validated as data before it is sourced.
# shellcheck source=scripts/lib/release-pins.sh
. "$pins_lib"
load_release_pins "$pins_env" || exit 2

scan_files=0
scan_errors=0

# scan_one <path> <path-relative-to-root> <yml|toml|sh>; prints one line per
# violation. An unreadable file or a failed awk is counted as an error, not as
# an absence of violations.
scan_one() {
   if [ ! -r "$1" ]; then
      echo "check-release-pins: cannot read $2" >&2
      scan_errors=$((scan_errors + 1))
      return
   fi
   if awk -v relpath="$2" -v type="$3" \
      -v pip_v="$PIP_VERSION" -v build_v="$BUILD_VERSION" -v twine_v="$TWINE_VERSION" \
      -v jsr_v="$JSR_VERSION" -v goreleaser_v="$GORELEASER_VERSION" \
      -v action_v="$PYPI_PUBLISH_ACTION_VERSION" -v action_sha="$PYPI_PUBLISH_ACTION_SHA" '
   BEGIN {
      DQ = sprintf("%c", 34)
      SQ = sprintf("%c", 39)
      SEP = sprintf("%c", 1)
      # Assembled from pieces: this file is itself inside the scanned set, and a
      # scanner that reports its own rule text is a scanner nobody can run.
      LATEST_TAG = "@" "lat" "est"
      UPGRADE_FLAG = "--up" "grade"
      MARKER = "# release-pins: local artifact built above"
      marked_installs = 0
      used_marker = 0
      pending = ""
      pend_ln = 0
      in_run = 0
      run_ind = 0
      in_arr = 0
      sect = ""
      last_action = ""
      twine_from_env = 0
   }

   function fail(ln, rule, msg) {
      printf "%s:%d: rule %d: %s\n", relpath, ln, rule, msg
   }

   function trim(s) {
      sub(/^[ \t]+/, "", s)
      sub(/[ \t]+$/, "", s)
      return s
   }

   function unquote(s,   c) {
      c = substr(s, 1, 1)
      if (length(s) > 1 && (c == DQ || c == SQ) && substr(s, length(s), 1) == c)
         s = substr(s, 2, length(s) - 2)
      return s
   }

   function indent(s,   i, c) {
      i = 0
      while (i < length(s)) {
         c = substr(s, i + 1, 1)
         if (c != " " && c != "\t") break
         i++
      }
      return i
   }

   # A trailing shell comment is not part of the command. Quote state is tracked
   # so a # inside a string, or inside ${VAR#...}, stays where it is.
   function strip_comment(s,   i, c, p, q) {
      q = ""
      for (i = 1; i <= length(s); i++) {
         c = substr(s, i, 1)
         if (q != "") {
            if (c == q) q = ""
            continue
         }
         if (c == DQ || c == SQ) {
            q = c
            continue
         }
         if (c == "#") {
            if (i == 1) return ""
            p = substr(s, i - 1, 1)
            if (p == " " || p == "\t") return substr(s, 1, i - 2)
         }
      }
      return s
   }

   # --- rule 7: every pip/build/twine version literal equals the tuple ---
   function check_tuple(ln, s,   rest, m, pre, name, ver, want, p) {
      rest = s
      while (match(rest, /(pip|build|twine)==[0-9][0-9A-Za-z._+!-]*/)) {
         m = substr(rest, RSTART, RLENGTH)
         pre = (RSTART > 1) ? substr(rest, RSTART - 1, 1) : ""
         rest = substr(rest, RSTART + RLENGTH)
         if (pre ~ /[A-Za-z0-9_.-]/) continue   # rebuild==, pip-audit==, ...
         p = index(m, "==")
         name = substr(m, 1, p - 1)
         ver = substr(m, p + 2)
         want = (name == "pip") ? pip_v : ((name == "build") ? build_v : twine_v)
         if (ver != want)
            fail(ln, 7, name " " ver " does not equal the " name " " want " in scripts/release-pins.env")
      }
   }

   function is_pinned_req(t,   p, name, ver) {
      p = index(t, "==")
      if (p == 0) return 0
      name = substr(t, 1, p - 1)
      ver = substr(t, p + 2)
      if (name !~ /^[A-Za-z0-9._-]+(\[[A-Za-z0-9,._-]+\])?$/) return 0
      if (ver ~ /^[0-9][0-9A-Za-z._+!-]*$/) return 1
      # The only expansions accepted anywhere: the tuple versions, in this shape.
      if (ver ~ /^\$\{?(PIP|BUILD|TWINE|JSR)_VERSION\}?$/) return 1
      return 0
   }

   # The line carries the marker that declares its install a locally built
   # artifact. It must close the line, so it cannot hide mid-command.
   function line_has_marker(s,   t) {
      t = s
      sub(/[ \t]+$/, "", t)
      return (length(t) > length(MARKER) && substr(t, length(t) - length(MARKER) + 1) == MARKER)
   }

   # The one exception, and both halves are the same shape: an artifact this run
   # built, on a line closed by the marker, rooted at $ROOT/ or $TMP/, ending in
   # a literal archive suffix, never a URL. A slash proves nothing and a trailing
   # expansion proves nothing either, so a caller that wants the exception spells
   # the suffix out.
   function is_marked_local(t, suffixes,   n, i) {
      if (index(t, "://") > 0) return 0
      if (t !~ /^\$\{?(ROOT|TMP)\}?\//) return 0
      n = split(suffixes, SUF, " ")
      for (i = 1; i <= n; i++)
         if (length(t) > length(SUF[i]) && substr(t, length(t) - length(SUF[i]) + 1) == SUF[i])
            return 1
      return 0
   }

   # --- rule 2: pip install requirements ---
   function check_pip(ln, seg, marked,   n, i, j, cmd, tok) {
      n = split(seg, T, /[ \t]+/)
      for (i = 1; i < n; i++) {
         cmd = unquote(T[i])
         if (cmd !~ /^pip3?$/ && cmd !~ /\/pip3?$/) continue
         if (unquote(T[i + 1]) != "install") continue
         for (j = i + 2; j <= n; j++) {
            tok = unquote(T[j])
            if (tok == "") continue
            if (tok ~ /^[0-9]?[<>]/) break                      # redirection
            if (tok ~ /^-/) {
               # A requirements file is a second, unscanned list of installs.
               if (tok ~ /^(-r|--requirement)(=.*)?$/) {
                  fail(ln, 2, "requirements file on the release path: " tok)
                  if (tok !~ /=/) j++
                  continue
               }
               if (tok ~ /^(-e|--editable|-c|--constraint|-f|--find-links|--index-url|--extra-index-url|--target|--prefix|--python|--report)$/)
                  j++                                           # the option owns the next word
               continue
            }
            if (index(tok, "*") > 0 || index(tok, "?") > 0) {
               fail(ln, 2, "glob in an install target: " tok)
               continue
            }
            if (index(tok, "==") > 0) {
               if (is_pinned_req(tok)) {
                  if (tok ~ /^twine==\$\{?TWINE_VERSION\}?$/) twine_from_env = 1
                  continue
               }
               fail(ln, 2, "pip install requirement is not exactly pinned: " tok)
               continue
            }
            if (index(tok, "$") > 0) {
               if (marked && is_marked_local(tok, ".whl .tar.gz")) {
                  used_marker = 1
                  continue
               }
               fail(ln, 2, "install target comes from a shell expansion: " tok)
               continue
            }
            if (tok ~ /^[.\/~]/) continue                                 # local path
            if (tok ~ /^[a-z][a-z0-9+.-]*:\/\//) continue                 # URL
            if (tok ~ /\.(whl|zip)$/ || tok ~ /\.tar\.gz$/) continue      # built artifact
            fail(ln, 2, "pip install requirement is not exactly pinned: " tok)
         }
         return
      }
   }

   function spec_pinned(s,   p, i, ver) {
      p = 0
      for (i = 2; i <= length(s); i++)
         if (substr(s, i, 1) == "@") p = i
      if (p == 0) return 0
      ver = substr(s, p + 1)
      return (ver ~ /^[0-9]+\.[0-9]+\.[0-9]+[0-9A-Za-z._+-]*$/)
   }

   function spec_name(s,   p, i) {
      p = 0
      for (i = 2; i <= length(s); i++)
         if (substr(s, i, 1) == "@") p = i
      return (p > 0) ? substr(s, 1, p - 1) : s
   }

   function spec_version(s,   p, i) {
      p = 0
      for (i = 2; i <= length(s); i++)
         if (substr(s, i, 1) == "@") p = i
      return (p > 0) ? substr(s, p + 1) : ""
   }

   # --- rule 3: npm install ---
   function check_npm(ln, seg, marked,   n, i, j, k, cmd, verb, tok, global, nspecs) {
      n = split(seg, U, /[ \t]+/)
      for (i = 1; i < n; i++) {
         cmd = unquote(U[i])
         if (cmd != "npm" && cmd !~ /\/npm$/) continue
         verb = unquote(U[i + 1])
         if (verb != "install" && verb != "i" && verb != "add") continue
         global = 0
         nspecs = 0
         for (j = i + 2; j <= n; j++) {
            tok = unquote(U[j])
            if (tok == "") continue
            if (tok == "-g" || tok == "--global") { global = 1; continue }
            if (tok ~ /^[0-9]?[<>]/) break
            if (tok ~ /^-/) {
               if (tok ~ /^(--prefix|--registry|--userconfig|--cache|--workspace|-w)$/) j++
               continue
            }
            # Expansions and globs are judged on every npm install, global or
            # not: a local tarball is installed without -g too.
            if (index(tok, "$") > 0) {
               if (marked && is_marked_local(tok, ".tgz")) {
                  used_marker = 1
                  continue
               }
               fail(ln, 3, "npm install target comes from a shell expansion: " tok)
               continue
            }
            if (index(tok, "*") > 0 || index(tok, "?") > 0) {
               fail(ln, 3, "glob in the install target: " tok)
               continue
            }
            if (tok ~ /^[.\/~]/) continue
            if (tok ~ /^[a-z][a-z0-9+.-]*:\/\//) continue
            if (tok ~ /\.(tgz|zip)$/ || tok ~ /\.tar\.gz$/) continue
            if (substr(tok, 1, 1) != "@" && index(tok, "/") > 0) continue   # a path, not a name
            nspecs++
            SPECS[nspecs] = tok
         }
         if (global)
            for (k = 1; k <= nspecs; k++)
               if (!spec_pinned(SPECS[k]))
                  fail(ln, 3, "global npm install without an exact @X.Y.Z: " SPECS[k])
         return
      }
   }

   # --- rule 8: npx / npm exec ---
   function check_npx(ln, seg,   n, i, j, cmd, tok, spec) {
      n = split(seg, V, /[ \t]+/)
      for (i = 1; i <= n; i++) {
         cmd = unquote(V[i])
         spec = ""
         if (cmd == "npx" || cmd ~ /\/npx$/) j = i + 1
         else if ((cmd == "npm" || cmd ~ /\/npm$/) && unquote(V[i + 1]) == "exec") j = i + 2
         else continue
         for (; j <= n; j++) {
            tok = unquote(V[j])
            if (tok == "") continue
            if (tok ~ /^[0-9]?[<>]/) return
            if (tok == "--") continue
            if (tok ~ /^-/) {
               # -p/--package names the package; the words after it are the command.
               if (tok ~ /^(-p|--package|-c|--call)$/) {
                  j++
                  if (tok ~ /^(-p|--package)$/) spec = unquote(V[j])
                  if (spec != "") break
               }
               continue
            }
            spec = tok
            break
         }
         if (spec == "") return
         # No exception here: npx fetches whatever the expansion names, and the
         # local-artifact case does not exist for it.
         if (index(spec, "$") > 0) {
            fail(ln, 8, "npx package comes from a shell expansion: " spec)
            return
         }
         if (index(spec, "*") > 0 || index(spec, "?") > 0) {
            # Worded without the command name: this file is inside the scanned
            # set, and a message that reads as an invocation reports itself.
            fail(ln, 8, "glob in the package selector: " spec)
            return
         }
         if (spec ~ /^[.\/~]/) return   # a local binary, not a fetched package
         if (!spec_pinned(spec)) {
            fail(ln, 8, "npx package without an exact @X.Y.Z: " spec)
            return
         }
         if (spec_name(spec) == "jsr" && spec_version(spec) != jsr_v)
            fail(ln, 7, "jsr " spec_version(spec) " does not equal the JSR_VERSION " jsr_v " in scripts/release-pins.env")
         return
      }
   }

   function process(ln, s,   n, i, marked) {
      marked = line_has_marker(s)
      s = strip_comment(s)
      if (s == "") return
      if (index(s, LATEST_TAG) > 0)
         fail(ln, 1, "floating version " LATEST_TAG)
      if (index(s, UPGRADE_FLAG) > 0)
         fail(ln, 1, "floating install: " UPGRADE_FLAG)
      check_tuple(ln, s)
      # Split on the shell operators, so a second command on the line is read as
      # its own command and not as arguments of the first.
      gsub(/&&|\|\||;/, SEP, s)
      gsub(/\|/, SEP, s)
      n = split(s, SEGS, SEP)
      used_marker = 0
      for (i = 1; i <= n; i++) {
         check_pip(ln, SEGS[i], marked)
         check_npm(ln, SEGS[i], marked)
         check_npx(ln, SEGS[i])
      }
      # One count per line that used the exception, not per target: the line is
      # what a reader reviews and what the marker sits on.
      if (used_marker) {
         marked_installs++
         printf "marked-local-artifact %s:%d\n", relpath, ln
      }
   }

   function flush() {
      if (pending != "") process(pend_ln, pending)
      pending = ""
   }

   function push(ln, text) {
      if (pending == "") pend_ln = ln
      if (text ~ /\\[ \t]*$/) {
         sub(/\\[ \t]*$/, "", text)
         pending = pending (pending == "" ? "" : " ") text
         return
      }
      pending = pending (pending == "" ? "" : " ") text
      flush()
   }

   # --- rule 4 and the action half of rule 7 ---
   function check_uses(ln, val,   comment, ref, p, i, name) {
      comment = ""
      if (match(val, /[ \t]+#/)) {
         comment = trim(substr(val, RSTART))
         val = substr(val, 1, RSTART - 1)
      }
      val = unquote(trim(val))
      if (val ~ /^\.\// || val ~ /^docker:\/\//) return   # local action or image
      p = 0
      for (i = 1; i <= length(val); i++)
         if (substr(val, i, 1) == "@") p = i
      ref = (p > 0) ? substr(val, p + 1) : ""
      last_action = (p > 0) ? substr(val, 1, p - 1) : val
      if (length(ref) != 40 || ref !~ /^[0-9a-f]+$/) {
         fail(ln, 4, "action is not pinned to a 40-character commit SHA: " val)
         return
      }
      if (last_action != "pypa/gh-action-pypi-publish") return
      if (ref != action_sha) {
         fail(ln, 7, "pypi-publish SHA does not equal PYPI_PUBLISH_ACTION_SHA in scripts/release-pins.env")
         return
      }
      sub(/^#[ \t]*/, "", comment)
      if (comment != action_v)
         fail(ln, 7, "pypi-publish version comment (" comment ") does not equal PYPI_PUBLISH_ACTION_VERSION (" action_v ")")
   }

   # --- rule 5 ---
   function check_go(ln, val) {
      sub(/[ \t]+#.*$/, "", val)
      val = unquote(trim(val))
      if (val !~ /^[0-9]+\.[0-9]+\.[0-9]+$/)
         fail(ln, 5, "go-version without a patch component: " val)
   }

   # --- rule 9: a version: input selects a tool, so it is a pin like any other ---
   function check_action_version(ln, val) {
      sub(/[ \t]+#.*$/, "", val)
      val = unquote(trim(val))
      if (val !~ /^v?[0-9]+\.[0-9]+\.[0-9]+$/) {
         fail(ln, 9, "version input to " last_action " is not an exact version: " val)
         return
      }
      if (last_action == "goreleaser/goreleaser-action" && val != goreleaser_v)
         fail(ln, 7, "goreleaser " val " does not equal the GORELEASER_VERSION " goreleaser_v " in scripts/release-pins.env")
   }

   # --- TOML string values ---
   function each_string(s, arr,   n, rest, p, q) {
      n = 0
      rest = s
      while (1) {
         p = index(rest, DQ)
         if (p == 0) break
         rest = substr(rest, p + 1)
         q = index(rest, DQ)
         if (q == 0) break
         n++
         arr[n] = substr(rest, 1, q - 1)
         rest = substr(rest, q + 1)
      }
      return n
   }

   function scan_toml(ln, s, target,   n, i) {
      n = each_string(s, STRS)
      for (i = 1; i <= n; i++) {
         if (index(STRS[i], LATEST_TAG) > 0)
            fail(ln, 1, "floating version " LATEST_TAG)
         check_tuple(ln, STRS[i])
         # rule 6: inside the build requirements and the dev extras, every
         # requirement is exact.
         if (target && STRS[i] != "" && index(STRS[i], "==") == 0)
            fail(ln, 6, "requirement is not exactly pinned: " STRS[i])
      }
   }

   type == "sh" {
      if ($0 ~ /^[ \t]*#/ || $0 ~ /^[ \t]*$/) next
      push(FNR, $0)
      next
   }

   type == "yml" {
      line = $0
      if (in_run) {
         if (line ~ /^[ \t]*$/) next
         if (indent(line) > run_ind) {
            if (line !~ /^[ \t]*#/) push(FNR, line)
            next
         }
         flush()
         in_run = 0
      }
      if (line ~ /^[ \t]*#/) next
      if (match(line, /^[ \t]*(-[ \t]+)?uses:[ \t]*/)) {
         check_uses(FNR, substr(line, RSTART + RLENGTH))
         next
      }
      # A new sequence item that is not the uses: line ends that action block, so
      # a later version: cannot be attributed to the action above it.
      if (line ~ /^[ \t]*-[ \t]/) last_action = ""
      if (match(line, /^[ \t]*(-[ \t]+)?run:[ \t]*/)) {
         val = substr(line, RSTART + RLENGTH)
         if (match(line, /run:/)) run_ind = RSTART - 1
         if (val ~ /^[|>][-+0-9]*[ \t]*$/) {
            in_run = 1
            next
         }
         push(FNR, unquote(trim(val)))
         flush()
         next
      }
      if (match(line, /^[ \t]*(-[ \t]+)?go-version:[ \t]*/)) {
         check_go(FNR, substr(line, RSTART + RLENGTH))
         next
      }
      if (last_action ~ /-action$/ && match(line, /^[ \t]*version:[ \t]*/)) {
         check_action_version(FNR, substr(line, RSTART + RLENGTH))
         next
      }
      next
   }

   type == "toml" {
      line = $0
      if (line ~ /^[ \t]*#/) next
      if (match(line, /^[ \t]*\[[^]]*\]/)) {
         sect = substr(line, RSTART, RLENGTH)
         gsub(/[ \t]/, "", sect)
         in_arr = 0
         next
      }
      if (in_arr) {
         scan_toml(FNR, line, 1)
         if (index(line, "]") > 0) in_arr = 0
         next
      }
      if (match(line, /^[ \t]*[A-Za-z0-9_.-]+[ \t]*=/)) {
         key = substr(line, RSTART, RLENGTH)
         sub(/[ \t]*=$/, "", key)
         key = trim(key)
         target = ((sect == "[build-system]" && key == "requires") || (sect == "[project.optional-dependencies]" && key == "dev"))
         rest = substr(line, RSTART + RLENGTH)
         scan_toml(FNR, rest, target)
         if (target && index(rest, "[") > 0 && index(rest, "]") == 0) in_arr = 1
         next
      }
      scan_toml(FNR, line, 0)
      next
   }

   END {
      flush()
      # The local gate must take its twine from the tuple, not from a literal
      # that an action bump would leave behind.
      if (type == "sh" && relpath ~ /twine-check\.sh$/ && !twine_from_env)
         fail(1, 7, "the twine gate must install twine==${TWINE_VERSION} from scripts/release-pins.env")
   }
   ' "$1"; then
      scan_files=$((scan_files + 1))
   else
      echo "check-release-pins: scan failed for $2" >&2
      scan_errors=$((scan_errors + 1))
   fi
}

# scan_tree <root>; prints one line per violation found anywhere in the scanned
# set and leaves the file and error counts in scan_files / scan_errors. Call it
# with a redirection, never in a command substitution, or the counts are lost.
scan_tree() {
   _root="$1"
   scan_files=0
   scan_errors=0
   for _f in "$_root"/.github/workflows/*.yml "$_root"/.github/workflows/*.yaml; do
      if [ -f "$_f" ]; then scan_one "$_f" "${_f#"$_root"/}" yml; fi
   done
   _f="$_root/packages/sdk-py/pyproject.toml"
   if [ -f "$_f" ]; then scan_one "$_f" "${_f#"$_root"/}" toml; fi
   for _f in "$_root"/scripts/*.sh "$_root"/scripts/lib/*.sh; do
      if [ -f "$_f" ]; then scan_one "$_f" "${_f#"$_root"/}" sh; fi
   done
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT INT TERM

# scan_into <root> <outfile>; prints its own environment errors and returns 2 on
# any of them, so an empty result can only mean a tree that scanned clean.
scan_into() {
   scan_tree "$1" > "$2"
   if [ "$scan_errors" -ne 0 ]; then
      echo "check-release-pins: $scan_errors file(s) could not be scanned under $1" >&2
      return 2
   fi
   if [ "$scan_files" -eq 0 ]; then
      echo "check-release-pins: nothing to scan under $1" >&2
      return 2
   fi
   return 0
}

count_violations() {
   grep -c "rule " "$1" || true
}

# Every use of the local-artifact exception, counted so the allowlist is visible
# in every run rather than only in the fixtures.
count_marked() {
   grep -c "^marked-local-artifact " "$1" || true
}

rules_reported() {
   sed -n 's/.*rule \([0-9]*\):.*/\1/p' "$1" | sort -u | tr '\n' ' '
}

# Every rule must own at least one bad fixture. Deleting a rule's fixtures is
# otherwise a silent way to stop testing that rule.
ALL_RULES="1 2 3 4 5 6 7 8 9"

run_self_test() {
   _fixtures="$repo_root/fixtures/release-path/pins"
   if [ ! -d "$_fixtures/good" ]; then
      echo "check-release-pins: missing fixtures/release-path/pins/good" >&2
      exit 2
   fi
   _missing=""
   for _rule in $ALL_RULES; do
      _found=0
      for _dir in "$_fixtures"/bad/"$_rule"-*/; do
         [ -d "$_dir" ] && _found=1
      done
      [ "$_found" -eq 1 ] || _missing="$_missing $_rule"
   done
   if [ -n "$_missing" ]; then
      printf 'self-test FAIL roster: no bad fixture for rule(s):%s\n' "$_missing"
      echo "check-release-pins: self-test RED"
      exit 1
   fi
   printf 'self-test PASS roster: good/ present, a bad fixture for each of rules %s\n' "$ALL_RULES"

   _failed=0
   if ! scan_into "$_fixtures/good" "$work/good"; then
      echo "self-test FAIL good: the fixture tree did not scan"
      _failed=1
   elif [ "$(count_violations "$work/good")" -gt 0 ]; then
      printf 'self-test FAIL good: expected 0 violations in %s files, got:\n' "$scan_files"
      grep "rule " "$work/good"
      _failed=1
   else
      printf 'self-test PASS good: 0 violations (%s files scanned, %s marked local-artifact installs)\n' \
         "$scan_files" "$(count_marked "$work/good")"
   fi

   for _dir in "$_fixtures"/bad/*/; do
      [ -d "$_dir" ] || continue
      _name="$(basename "$_dir")"
      _want="${_name%%-*}"   # the fixture directory names the rule it must trip
      if ! scan_into "${_dir%/}" "$work/case"; then
         printf 'self-test FAIL bad/%s: the fixture tree did not scan\n' "$_name"
         _failed=1
         continue
      fi
      _n="$(count_violations "$work/case")"
      _got="$(rules_reported "$work/case")"
      if [ "$_n" -eq 1 ] && [ "$_got" = "$_want " ]; then
         printf 'self-test PASS bad/%s: rule %s\n' "$_name" "$_want"
      else
         printf 'self-test FAIL bad/%s: expected exactly rule %s, got %s violation(s):\n' \
            "$_name" "$_want" "$_n"
         grep "rule " "$work/case" || true
         _failed=1
      fi
   done

   if [ "$_failed" -ne 0 ]; then
      echo "check-release-pins: self-test RED"
      exit 1
   fi
   echo "check-release-pins: self-test GREEN"
   exit 0
}

if [ "$self_test" -eq 1 ]; then
   run_self_test
fi

root="${scan_target:-$repo_root}"
if [ ! -d "$root" ]; then
   echo "check-release-pins: not a directory: $root" >&2
   exit 2
fi
scan_into "$root" "$work/out" || exit 2
violations="$(count_violations "$work/out")"
marked="$(count_marked "$work/out")"
if [ "$violations" -gt 0 ]; then
   grep "rule " "$work/out"
   printf 'check-release-pins: %s violation(s) (%s files scanned, %s marked local-artifact installs)\n' \
      "$violations" "$scan_files" "$marked"
   exit 1
fi
printf 'check-release-pins: 0 violations (%s files scanned, %s marked local-artifact installs)\n' \
   "$scan_files" "$marked"
