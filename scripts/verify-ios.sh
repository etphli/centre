#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
CENTRE_EVIDENCE_DIR=".runtime/ios-evidence/run-$(date -u +%Y%m%dT%H%M%SZ)-$$"
CENTRE_SIMULATOR_UDID=''
mkdir -p "$CENTRE_EVIDENCE_DIR"
preserve_evidence() {
  CENTRE_EXIT_STATUS=$?
  trap - EXIT
  set +e
  if [ -d "$CENTRE_EVIDENCE_DIR/ios.xcresult" ]; then
    xcrun xcresulttool export attachments --path "$CENTRE_EVIDENCE_DIR/ios.xcresult" --output-path "$CENTRE_EVIDENCE_DIR/screenshots" > "$CENTRE_EVIDENCE_DIR/export.log" 2>&1
  fi
  if [ -n "$CENTRE_SIMULATOR_UDID" ]; then
    xcrun simctl io "$CENTRE_SIMULATOR_UDID" screenshot "$CENTRE_EVIDENCE_DIR/final-screen.png" 2>> "$CENTRE_EVIDENCE_DIR/export.log"
  fi
  printf 'Verification exit status: %s\n' "$CENTRE_EXIT_STATUS" >> "$CENTRE_EVIDENCE_DIR/summary.txt"
  exit "$CENTRE_EXIT_STATUS"
}
trap preserve_evidence EXIT
xcodebuild -version
xcodegen generate --spec ios/project.yml
CENTRE_RELEASE_STATUS=0
if xcodebuild build -project ios/Centre.xcodeproj -scheme Centre -configuration Release -destination 'generic/platform=iOS' -derivedDataPath .runtime/ios-build CODE_SIGNING_ALLOWED=NO 2>&1 | tee "$CENTRE_EVIDENCE_DIR/release-build.log"; then
  printf 'Unsigned Release build: passed\n' >> "$CENTRE_EVIDENCE_DIR/summary.txt"
else
  CENTRE_RELEASE_STATUS=$?
  printf 'Unsigned Release build: failed (%s)\n' "$CENTRE_RELEASE_STATUS" >> "$CENTRE_EVIDENCE_DIR/summary.txt"
fi
CENTRE_SIMULATOR_UDID=$(xcrun simctl list devices available -j | python3 -c 'import json,sys; devices=json.load(sys.stdin)["devices"]; candidates=[d for runtime,items in devices.items() if "iOS" in runtime for d in items if d["name"].startswith("iPhone") and d.get("isAvailable",True)]; print(next((d["udid"] for d in candidates if d["state"]=="Booted"), candidates[0]["udid"] if candidates else ""))')
if [ -z "$CENTRE_SIMULATOR_UDID" ]; then
  echo 'No available iPhone simulator runtime. Install an iOS runtime in Xcode.'
  exit 1
fi
xcrun simctl boot "$CENTRE_SIMULATOR_UDID" 2>/dev/null || true
xcrun simctl bootstatus "$CENTRE_SIMULATOR_UDID" -b
xcrun simctl status_bar "$CENTRE_SIMULATOR_UDID" override --time '9:41' --dataNetwork wifi --wifiMode active --wifiBars 3 --batteryState charged --batteryLevel 100
CENTRE_TEST_STATUS=0
if xcodebuild test -project ios/Centre.xcodeproj -scheme Centre -configuration Debug -destination "platform=iOS Simulator,id=$CENTRE_SIMULATOR_UDID" -parallel-testing-enabled NO -derivedDataPath .runtime/ios-build -resultBundlePath "$CENTRE_EVIDENCE_DIR/ios.xcresult" CODE_SIGNING_ALLOWED=NO 2>&1 | tee "$CENTRE_EVIDENCE_DIR/xcodebuild.log"; then
  printf 'Simulator UI tests: passed\n' >> "$CENTRE_EVIDENCE_DIR/summary.txt"
else
  CENTRE_TEST_STATUS=$?
  printf 'Simulator UI tests: failed (%s)\n' "$CENTRE_TEST_STATUS" >> "$CENTRE_EVIDENCE_DIR/summary.txt"
fi
if [ "$CENTRE_TEST_STATUS" -ne 0 ]; then exit "$CENTRE_TEST_STATUS"; fi
exit "$CENTRE_RELEASE_STATUS"
