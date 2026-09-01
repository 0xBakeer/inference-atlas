#!/bin/sh
# Installs the Inference Atlas TUI from source:
#
#   curl -fsSL https://raw.githubusercontent.com/0xBakeer/inference-atlas/main/install.sh | sh
#
# What it does, and nothing else:
#   1. clones (or updates) the repository under ~/.local/share/inference-atlas/src
#   2. installs workspace dependencies with pnpm and builds @atlas/core + @atlas/tui
#   3. writes an `inference-atlas` wrapper into ~/.local/bin
#
# Requirements: git, Node.js >= 20 (pnpm comes via corepack when missing).
# Override the locations with INFERENCE_ATLAS_HOME and BIN_DIR.

set -eu

REPO_URL="https://github.com/0xBakeer/inference-atlas.git"
SRC="${INFERENCE_ATLAS_HOME:-$HOME/.local/share/inference-atlas}/src"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"

say() { printf '\033[1m[inference-atlas]\033[0m %s\n' "$1"; }
die() { printf '\033[1;31m[inference-atlas]\033[0m %s\n' "$1" >&2; exit 1; }

command -v git >/dev/null 2>&1 || die "git is required"
command -v node >/dev/null 2>&1 || die "Node.js >= 20 is required (https://nodejs.org)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node.js >= 20 is required (found $(node --version))"

if command -v pnpm >/dev/null 2>&1; then
  PNPM=pnpm
elif command -v corepack >/dev/null 2>&1; then
  say "enabling pnpm via corepack"
  corepack enable pnpm >/dev/null 2>&1 || true
  PNPM="corepack pnpm"
else
  die "pnpm is required (npm install -g pnpm)"
fi

if [ -d "$SRC/.git" ]; then
  say "updating $SRC"
  git -C "$SRC" fetch --depth 1 origin main
  git -C "$SRC" reset --hard origin/main
else
  say "cloning into $SRC"
  mkdir -p "$(dirname "$SRC")"
  git clone --depth 1 "$REPO_URL" "$SRC"
fi

say "installing dependencies and building"
cd "$SRC"
$PNPM install --frozen-lockfile
$PNPM --filter @atlas/core run build
$PNPM --filter @atlas/tui run build

mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/inference-atlas" <<WRAPPER
#!/bin/sh
exec node "$SRC/packages/tui/dist/cli.js" "\$@"
WRAPPER
chmod +x "$BIN_DIR/inference-atlas"

say "installed: $BIN_DIR/inference-atlas"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "note: $BIN_DIR is not on your PATH — add it to your shell profile" ;;
esac
say "run \`inference-atlas\` to start (config lands in ~/.config/inference-atlas/config.toml)"
