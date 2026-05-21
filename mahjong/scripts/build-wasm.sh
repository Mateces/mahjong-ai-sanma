#!/usr/bin/env bash
# Build libriichi-wasm for Node.js consumption.
#
# Output: libriichi-wasm/pkg/ — contains the wasm binary, JS loader, and
# .d.ts declarations. Add the directory to require()/import as
# './libriichi-wasm/pkg'.
#
# Requirements:
#   - Rust + cargo + wasm32-unknown-unknown target
#   - wasm-bindgen-cli matching the lib's wasm-bindgen version
#
# Run from project root:
#   bash scripts/build-wasm.sh
set -euo pipefail

# Source rustup env if present (handles default rustup install on a fresh box).
[ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/libriichi-wasm"

# Install wasm32 target if missing
if ! rustup target list --installed | grep -q wasm32-unknown-unknown; then
  echo "Installing wasm32-unknown-unknown target..."
  rustup target add wasm32-unknown-unknown
fi

# Get the wasm-bindgen version from Cargo.lock to match the CLI to it.
# (Mismatched versions are the #1 wasm-bindgen footgun.)
cargo build --target wasm32-unknown-unknown --release
WB_VERSION=$(cargo tree -p libriichi-wasm --target wasm32-unknown-unknown --no-default-features 2>/dev/null |
             grep -m1 "^├── wasm-bindgen v\|^└── wasm-bindgen v\| wasm-bindgen v" |
             grep -oE "v[0-9]+\.[0-9]+\.[0-9]+" | head -1 | tr -d v)
WB_VERSION="${WB_VERSION:-0.2.121}"

# Install wasm-bindgen-cli if missing or wrong version
INSTALLED_VERSION=$(wasm-bindgen --version 2>/dev/null | awk '{print $2}' || true)
if [ "$INSTALLED_VERSION" != "$WB_VERSION" ]; then
  echo "Installing wasm-bindgen-cli@$WB_VERSION..."
  cargo install -f wasm-bindgen-cli --version "$WB_VERSION"
fi

# Generate Node bindings
rm -rf pkg
mkdir -p pkg
wasm-bindgen --target nodejs --out-dir pkg \
    target/wasm32-unknown-unknown/release/libriichi_wasm.wasm

# wasm-bindgen --target nodejs emits CommonJS but doesn't write a
# package.json. Our root package.json has "type": "module", so without
# this override Node treats the .js as ESM and the exports go missing.
cat > pkg/package.json <<JSON
{
  "name": "libriichi-wasm",
  "version": "0.1.0",
  "private": true,
  "type": "commonjs",
  "main": "libriichi_wasm.js",
  "types": "libriichi_wasm.d.ts"
}
JSON

echo "Built libriichi-wasm → $(pwd)/pkg"
ls -la pkg/
