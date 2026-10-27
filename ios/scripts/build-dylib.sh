#!/bin/sh
# Builds SimPeek.dylib for the iOS Simulator (arm64 + x86_64) into ios/build/.
set -eu

cd "$(dirname "$0")/.."
SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
MIN_IOS=15.0
OUT=build
mkdir -p "$OUT"

for ARCH in arm64 x86_64; do
  TARGET="$ARCH-apple-ios$MIN_IOS-simulator"
  xcrun --sdk iphonesimulator clang -c -target "$TARGET" -isysroot "$SDK" -O2 Inject/inject.c -o "$OUT/inject-$ARCH.o"
  xcrun swiftc -emit-library -module-name SimPeek -swift-version 5 -O -D DEBUG \
    -target "$TARGET" -sdk "$SDK" \
    -Xlinker -install_name -Xlinker @rpath/SimPeek.dylib \
    Sources/SimPeek/*.swift "$OUT/inject-$ARCH.o" -o "$OUT/SimPeek-$ARCH.dylib"
done

lipo -create "$OUT/SimPeek-arm64.dylib" "$OUT/SimPeek-x86_64.dylib" -output "$OUT/SimPeek.dylib"
codesign --force --sign - "$OUT/SimPeek.dylib"
rm -f "$OUT"/inject-*.o "$OUT"/SimPeek-*.dylib
echo "$PWD/$OUT/SimPeek.dylib"
