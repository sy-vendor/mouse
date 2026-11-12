#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
app_dir="$script_dir/dist/Mouse Loop.app"

mkdir -p "$app_dir/Contents/MacOS" "$app_dir/Contents/Resources"

clang -fobjc-arc \
  -mmacosx-version-min=12.0 \
  -framework Cocoa \
  -framework ApplicationServices \
  "$script_dir/main.m" \
  -o "$app_dir/Contents/MacOS/MouseLoop"

cp "$script_dir/Info.plist" "$app_dir/Contents/Info.plist"
cp "$script_dir/assets/MouseLoop.icns" "$app_dir/Contents/Resources/MouseLoop.icns"
codesign --force --deep --sign - \
  --requirements '=designated => identifier "local.suyang.mouseloop"' \
  "$app_dir"

echo "$app_dir"
