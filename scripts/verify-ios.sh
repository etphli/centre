#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .runtime/ios-evidence
xcodebuild -version
xcodegen generate --spec ios/project.yml
CENTRE_SIMULATOR_UDID=$(xcrun simctl list devices available -j | python3 -c 'import json,sys; devices=json.load(sys.stdin)["devices"]; candidates=[d for runtime,items in devices.items() if "iOS" in runtime for d in items if d["name"].startswith("iPhone") and d.get("isAvailable",True)]; print(next((d["udid"] for d in candidates if d["state"]=="Booted"), candidates[0]["udid"] if candidates else ""))')
if [ -z "$CENTRE_SIMULATOR_UDID" ]; then
  echo 'No available iPhone simulator runtime. Install an iOS runtime in Xcode.'
  exit 1
fi
xcrun simctl boot "$CENTRE_SIMULATOR_UDID" 2>/dev/null || true
xcrun simctl bootstatus "$CENTRE_SIMULATOR_UDID" -b
xcrun simctl status_bar "$CENTRE_SIMULATOR_UDID" override --time '9:41' --dataNetwork wifi --wifiMode active --wifiBars 3 --batteryState charged --batteryLevel 100
xcodebuild test -project ios/Centre.xcodeproj -scheme Centre -configuration Debug -destination "platform=iOS Simulator,id=$CENTRE_SIMULATOR_UDID" -derivedDataPath .runtime/ios-build -resultBundlePath .runtime/ios-evidence/ios.xcresult CODE_SIGNING_ALLOWED=NO 2>&1 | tee .runtime/ios-evidence/xcodebuild.log
xcrun xcresulttool export attachments --path .runtime/ios-evidence/ios.xcresult --output-path .runtime/ios-evidence/screenshots
xcrun simctl io "$CENTRE_SIMULATOR_UDID" screenshot .runtime/ios-evidence/final-screen.png
