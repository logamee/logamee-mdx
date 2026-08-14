#!/usr/bin/env bash
set -euo pipefail

artifact_dir=${1:?artifact directory required}
target=${2:?target required}
smoke_mode=${3:-instrumented}
[[ "$smoke_mode" == instrumented || "$smoke_mode" == release ]]
artifact_dir=$(CDPATH= cd -- "$artifact_dir" && pwd -P)
[[ "$(uname -m)" == 'x86_64' ]]
node scripts/ci/artifact-manifest.mjs verify "$artifact_dir"

appimage=$(find "$artifact_dir" -maxdepth 1 -type f -name '*.AppImage' -print)
deb=$(find "$artifact_dir" -maxdepth 1 -type f -name '*.deb' -print)
[[ $(printf '%s\n' "$appimage" | sed '/^$/d' | wc -l | tr -d ' ') == 1 ]]
[[ $(printf '%s\n' "$deb" | sed '/^$/d' | wc -l | tr -d ' ') == 1 ]]
dpkg-deb --info "$deb"
sudo apt-get update
sudo apt-get install -y "$deb"
sudo update-desktop-database /usr/share/applications
mime_association=$(gio mime text/markdown)
printf '%s\n' "$mime_association"
[[ "$mime_association" == *mdx.desktop* ]]

installed_binary=$(command -v mdx)
run_with_window_manager=(bash scripts/ci/run-xvfb-with-window-manager.sh)
if [[ "$smoke_mode" == release ]]; then
  run_for_five_seconds() {
    local log=$1
    shift
    local status
    set +e
    "${run_with_window_manager[@]}" timeout --signal=TERM --kill-after=5s 5s "$@" >"$log" 2>&1
    status=$?
    set -e
    [[ "$status" == 124 ]]
  }

  run_for_five_seconds "$RUNNER_TEMP/mmd-deb.log" "$installed_binary"
  [[ -c /dev/fuse ]]
  ldconfig -p | grep -q 'libfuse\.so\.2'
  chmod +x "$appimage"
  run_for_five_seconds "$RUNNER_TEMP/mmd-appimage.log" "$appimage"
  exit 0
fi

deb_challenge="$RUNNER_TEMP/mmd-packaged-lifecycle-deb.json"
node scripts/ci/packaged-lifecycle-runner.mjs \
  --evidence "$artifact_dir/m2-lifecycle-evidence.json" \
  --package-variant deb \
  --target "$target" \
  --challenge-output "$deb_challenge" \
  -- "${run_with_window_manager[@]}" "$installed_binary"
for profile in apply-reobserve restore-cancel; do
  deb_open_challenge="$RUNNER_TEMP/mmd-packaged-open-deb-$profile.json"
  node scripts/ci/packaged-open-evidence.mjs issue \
    --target "$target" \
    --package-variant deb \
    --platform linux \
    --profile "$profile" \
    --output "$deb_open_challenge"
  "${run_with_window_manager[@]}" node scripts/ci/packaged-open-runner.mjs \
    --challenge "$deb_open_challenge" \
    --binary "$installed_binary" \
    --output "$artifact_dir/m3-native-open-deb-$profile.json"
done

[[ -c /dev/fuse ]]
ldconfig -p | grep -q 'libfuse\.so\.2'
chmod +x "$appimage"
appimage_challenge="$RUNNER_TEMP/mmd-packaged-lifecycle-appimage.json"
node scripts/ci/packaged-lifecycle-runner.mjs \
  --evidence "$artifact_dir/m2-lifecycle-evidence.json" \
  --package-variant appimage \
  --target "$target" \
  --challenge-output "$appimage_challenge" \
  -- "${run_with_window_manager[@]}" "$appimage"
for profile in apply-reobserve restore-cancel; do
  appimage_open_challenge="$RUNNER_TEMP/mmd-packaged-open-appimage-$profile.json"
  node scripts/ci/packaged-open-evidence.mjs issue \
    --target "$target" \
    --package-variant appimage \
    --platform linux \
    --profile "$profile" \
    --output "$appimage_open_challenge"
  "${run_with_window_manager[@]}" node scripts/ci/packaged-open-runner.mjs \
    --challenge "$appimage_open_challenge" \
    --binary "$appimage" \
    --output "$artifact_dir/m3-native-open-appimage-$profile.json"
done
node scripts/ci/lifecycle-evidence.mjs verify-packaged \
  --evidence "$artifact_dir/m2-lifecycle-evidence.json" \
  --artifact-directory "$artifact_dir" \
  --packaged-challenge "$deb_challenge" \
  --packaged-challenge "$appimage_challenge" \
  --output "$artifact_dir/m2-lifecycle-evidence.json"
node scripts/ci/artifact-manifest.mjs create "$artifact_dir" \
  "$(basename "$appimage")" "$(basename "$deb")" m2-lifecycle-evidence.json \
  m3-native-open-deb-apply-reobserve.json m3-native-open-deb-restore-cancel.json \
  m3-native-open-appimage-apply-reobserve.json m3-native-open-appimage-restore-cancel.json
node scripts/ci/artifact-manifest.mjs verify "$artifact_dir"
