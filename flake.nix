{
  description = "Leji dev environment — Node 24, Python 3.12, Go 1.26.6";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs_24
            python312
            python312Packages.pip
            go
            goreleaser
            git
            jq
          ];

          shellHook = ''
            if [ -z "$NO_COLOR" ] && [ -t 1 ]; then
              _R=$(printf '\033[0m')
              _B=$(printf '\033[38;2;0;159;113m')
              _D=$(printf '\033[38;2;24;61;59m')
              _M=$(printf '\033[38;2;112;216;194m')
              _DIM=$(printf '\033[2m')
              _BD=$(printf '\033[1m')
            else
              _R=""; _B=""; _D=""; _M=""; _DIM=""; _BD=""
            fi
            _node=$(node --version 2>/dev/null || echo "—")
            _py=$(python3 --version 2>&1 | awk '{print $2}'); [ -z "$_py" ] && _py="—"
            _pip=$(pip --version 2>/dev/null | awk '{print $2}'); [ -z "$_pip" ] && _pip="—"
            _go=$(go version 2>/dev/null | awk '{print $3}' | sed 's/go//'); [ -z "$_go" ] && _go="—"
            _gr=$(goreleaser --version 2>/dev/null | head -n1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1); [ -z "$_gr" ] && _gr="—"
            _git=$(git --version 2>/dev/null | awk '{print $3}'); [ -z "$_git" ] && _git="—"
            _jq=$(jq --version 2>/dev/null | sed 's/jq-//'); [ -z "$_jq" ] && _jq="—"
            printf "\n"
            printf "  %s%sleji%s %s•%s %sdevelopment shell%s\n" "$_B" "$_BD" "$_R" "$_M" "$_R" "$_DIM" "$_R"
            printf "\n"
            printf "  %s─ packages ─────────────────────────────────────%s\n" "$_DIM" "$_R"
            printf "    %s◆%s %-12s %s%s%s  %s(%s)%s\n" "$_M" "$_R" "node" "$_BD" "$_node" "$_R" "$_DIM" "nodejs_24" "$_R"
            printf "    %s◆%s %-12s %s%s%s  %s(%s, pip %s)%s\n" "$_M" "$_R" "python" "$_BD" "$_py" "$_R" "$_DIM" "python312" "$_pip" "$_R"
            printf "    %s◆%s %-12s %s%s%s  %s(%s)%s\n" "$_M" "$_R" "go" "$_BD" "$_go" "$_R" "$_DIM" "go 1.26.6" "$_R"
            printf "    %s◆%s %-12s %s%s%s  %s(%s)%s\n" "$_M" "$_R" "goreleaser" "$_BD" "$_gr" "$_R" "$_DIM" "goreleaser" "$_R"
            printf "    %s◆%s %-12s %s%s%s  %s(%s)%s\n" "$_M" "$_R" "git" "$_BD" "$_git" "$_R" "$_DIM" "git" "$_R"
            printf "    %s◆%s %-12s %s%s%s  %s(%s)%s\n" "$_M" "$_R" "jq" "$_BD" "$_jq" "$_R" "$_DIM" "jq" "$_R"
            printf "  %s────────────────────────────────────────────────%s\n" "$_DIM" "$_R"
            printf "\n"
            unset _R _B _D _M _DIM _BD _node _py _pip _go _gr _git _jq
          '';

          env.PYTHON = "${pkgs.python312}/bin/python3";
        };
      }
    );
}
