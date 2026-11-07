#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
xcodebuild -project apps/ios/Clippy.xcodeproj -scheme Clippy -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath .build-local/ios CODE_SIGNING_ALLOWED=NO build
