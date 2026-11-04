#!/data/data/com.termux/files/usr/bin/bash
# Сборка APK Coting (com.rybinsklab.coting) без Gradle: aapt2 -> javac -> d8 -> zip -> apksigner.
# Донор пайплайна: ~/test/camtrap2/build.sh. Keystore: body3d (pass=android).
set -e

PROJ="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
BUILD="$PROJ/build"
SDK="${ANDROID_HOME:-$HOME/android-sdk}"
API=34
PLATFORM="$SDK/platforms/android-$API/android.jar"
KS="$PROJ/keystore.jks"
KS_PASS=android
OUT="${1:-$PROJ/coting.apk}"

[ -f "$PLATFORM" ] || { echo "НЕТ android.jar: $PLATFORM" >&2; exit 1; }
[ -f "$KS" ] || { echo "НЕТ keystore: $KS" >&2; exit 1; }

echo "==> [1/6] чистка"
rm -rf "$BUILD"
mkdir -p "$BUILD/classes" "$BUILD/gen" "$BUILD/dex" "$BUILD/res-compiled"

echo "==> [2/6] ресурсы (aapt2)"
find "$PROJ/res" -type f | while read -r f; do
  rel="${f#$PROJ/res/}"
  mkdir -p "$BUILD/res-compiled/$(dirname "$rel")"
  aapt2 compile -o "$BUILD/res-compiled" "$f"
done
FLATS=$(find "$BUILD/res-compiled" -name '*.flat' | tr '\n' ' ')
aapt2 link --auto-add-overlay -o "$BUILD/app.unaligned.apk" \
  -I "$PLATFORM" \
  --manifest "$PROJ/AndroidManifest.xml" \
  --min-sdk-version 26 --target-sdk-version "$API" \
  --java "$BUILD/gen" \
  $FLATS

echo "==> [3/6] javac"
SRC=$(find "$PROJ/src" "$BUILD/gen" -name '*.java' | tr '\n' ' ')
JAVAC_LOG="$BUILD/javac.log"
if ! javac -source 8 -target 8 -nowarn -encoding UTF-8 \
  -bootclasspath "$PLATFORM" \
  -d "$BUILD/classes" \
  $SRC > "$JAVAC_LOG" 2>&1; then
  grep -v "^warning:" "$JAVAC_LOG" | grep -v "bootstrap class path" | grep -v "^Note:" >&2
  echo "!!! javac завершился с ошибкой — сборка прервана" >&2
  exit 1
fi
for cls in MainActivity BridgeService BridgeServer AdminReceiver; do
  if [ ! -f "$BUILD/classes/com/rybinsklab/coting/$cls.class" ]; then
    echo "!!! нет класса $cls — сборка прервана" >&2
    exit 1
  fi
done

echo "==> [4/6] d8"
d8 --release --lib "$PLATFORM" --min-api 26 \
  --output "$BUILD/dex" \
  $(find "$BUILD/classes" -name '*.class')

echo "==> [5/6] classes.dex -> apk"
python3 - "$BUILD/app.unaligned.apk" "$BUILD/dex/classes.dex" <<'EOF'
import sys, zipfile
apk, dex = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(apk, 'a', zipfile.ZIP_DEFLATED) as z:
    z.write(dex, 'classes.dex')
print('dex added')
EOF

echo "==> [6/6] подпись"
apksigner sign --ks "$KS" --ks-pass pass:"$KS_PASS" \
  --out "$OUT" "$BUILD/app.unaligned.apk"
apksigner verify --print-certs "$OUT" | head -3
ls -la "$OUT"
echo "==> OK: $OUT"
