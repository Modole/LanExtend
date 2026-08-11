#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
OUTPUT_DIR="$SCRIPT_DIR/.build"
OUTPUT_PATH="$OUTPUT_DIR/lanextend-vdisplay"
SDK_PATH=$(xcrun --sdk macosx --show-sdk-path)
CLANG_PATH=$(xcrun --sdk macosx --find clang)

mkdir -p "$OUTPUT_DIR"

"$CLANG_PATH" \
  -x objective-c \
  -std=gnu17 \
  -fobjc-arc \
  -fblocks \
  -O2 \
  -arch arm64 \
  -arch x86_64 \
  -Wall \
  -Wextra \
  -Werror \
  -mmacosx-version-min=14.0 \
  -isysroot "$SDK_PATH" \
  -framework AppKit \
  -framework Foundation \
  -framework CoreGraphics \
  "$SCRIPT_DIR/lanextend_vdisplay.m" \
  -o "$OUTPUT_PATH"

printf '%s\n' "Built $OUTPUT_PATH"
