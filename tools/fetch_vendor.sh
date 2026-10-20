#!/bin/bash
# 从 libcimbar 官方 release 下载预编译的 WASM 核心到 vendor/（仓库里已附带，一般无需执行）
# 用法：bash tools/fetch_vendor.sh [版本号，默认 v0.6.8]
set -euo pipefail
VERSION=${1:-v0.6.8}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

curl -fsSL -o "$TMP/cimbar.wasm.tar.gz" "https://github.com/sz3/libcimbar/releases/download/$VERSION/cimbar.wasm.tar.gz"
tar -xzf "$TMP/cimbar.wasm.tar.gz" -C "$TMP"

JS=$(ls "$TMP"/cimbar_js.*.js | head -1)
WASM=$(ls "$TMP"/cimbar_js.*.wasm | head -1)
cp "$JS" "$ROOT/vendor/cimbar_js.js"
cp "$WASM" "$ROOT/vendor/cimbar_js.wasm"
# 去掉 release 里带时间戳的 wasm 文件名（本项目通过 instantiateWasm 加载，不依赖文件名）
sed -i "s/$(basename "$WASM" | sed 's/\./\\./g')/cimbar_js.wasm/g" "$ROOT/vendor/cimbar_js.js"
echo "$VERSION" > "$ROOT/vendor/VERSION"
(cd "$ROOT/vendor" && sha256sum cimbar_js.js cimbar_js.wasm > SHA256SUMS)
echo "vendor updated to $VERSION"
