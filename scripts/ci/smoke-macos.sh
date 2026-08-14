#!/usr/bin/env bash
set -euo pipefail

artifact_dir=${1:?artifact directory required}
expected_arch=${2:?expected architecture required}
target=${3:?target required}
smoke_mode=${4:-instrumented}
[[ "$smoke_mode" == instrumented || "$smoke_mode" == release ]]
[[ "$(uname -m)" == "$expected_arch" ]]
node scripts/ci/artifact-manifest.mjs verify "$artifact_dir"

mapfile_name="$RUNNER_TEMP/mmd-hdiutil.txt"
mount_point=
install_dir=
app_pid=
cleanup() {
  if [[ -n "$app_pid" ]] && kill -0 "$app_pid" 2>/dev/null; then kill "$app_pid" || true; fi
  if [[ -n "$mount_point" ]]; then hdiutil detach "$mount_point" -force || true; fi
  if [[ -n "$install_dir" ]]; then rm -rf -- "$install_dir"; fi
}
trap cleanup EXIT

dmg=$(find "$artifact_dir" -maxdepth 1 -type f -name '*.dmg' -print)
[[ $(printf '%s\n' "$dmg" | sed '/^$/d' | wc -l | tr -d ' ') == 1 ]]
hdiutil attach -nobrowse -readonly "$dmg" | tee "$mapfile_name"
mount_point=$(awk '/\/Volumes\// { print substr($0, index($0, "/Volumes/")); exit }' "$mapfile_name")
[[ -n "$mount_point" ]]

app=$(find "$mount_point" -maxdepth 2 -type d -name 'mdx.app' -print)
[[ $(printf '%s\n' "$app" | sed '/^$/d' | wc -l | tr -d ' ') == 1 ]]
install_dir=$(mktemp -d "$RUNNER_TEMP/Applications.XXXXXX")
installed_app="$install_dir/mdx.app"
ditto "$app" "$installed_app"
hdiutil detach "$mount_point"
mount_point=

binary=$(find "$installed_app/Contents/MacOS" -maxdepth 1 -type f -perm -111 -print)
[[ $(printf '%s\n' "$binary" | sed '/^$/d' | wc -l | tr -d ' ') == 1 ]]
[[ "$(lipo -archs "$binary")" == "$expected_arch" ]]
codesign --verify --deep --strict --verbose=2 "$installed_app"
signature=$(codesign -dv --verbose=4 "$installed_app" 2>&1 || true)
if grep -q 'Authority=Developer ID Application' <<<"$signature"; then
  echo 'macOS signing classification: Developer ID Application'
elif grep -q 'Signature=adhoc' <<<"$signature"; then
  echo 'macOS signing classification: ad-hoc'
else
  echo "$signature"
  echo 'Unrecognized macOS signing classification.' >&2
  exit 1
fi

if [[ "$smoke_mode" == release ]]; then
  "$binary" >"$RUNNER_TEMP/mmd-macos.log" 2>&1 &
  app_pid=$!
  sleep 5
  kill -0 "$app_pid"
  kill "$app_pid"
  wait "$app_pid" || true
  app_pid=
  exit 0
fi

challenge="$RUNNER_TEMP/mmd-packaged-lifecycle-dmg.json"
node scripts/ci/packaged-lifecycle-runner.mjs \
  --evidence "$artifact_dir/m2-lifecycle-evidence.json" \
  --package-variant dmg \
  --target "$target" \
  --challenge-output "$challenge" \
  -- "$binary"
node scripts/ci/lifecycle-evidence.mjs verify-packaged \
  --evidence "$artifact_dir/m2-lifecycle-evidence.json" \
  --artifact-directory "$artifact_dir" \
  --packaged-challenge "$challenge" \
  --output "$artifact_dir/m2-lifecycle-evidence.json"

for profile in apply-reobserve restore-cancel; do
  open_challenge="$RUNNER_TEMP/mmd-packaged-open-dmg-$profile.json"
  node scripts/ci/packaged-open-evidence.mjs issue \
    --target "$target" \
    --package-variant dmg \
    --platform macos \
    --profile "$profile" \
    --output "$open_challenge"
  node scripts/ci/packaged-open-runner.mjs \
    --challenge "$open_challenge" \
    --binary "$binary" \
    --association-app "$installed_app" \
    --output "$artifact_dir/m3-native-open-dmg-$profile.json"
done
node scripts/ci/artifact-manifest.mjs create "$artifact_dir" \
  "$(basename "$dmg")" m2-lifecycle-evidence.json \
  m3-native-open-dmg-apply-reobserve.json m3-native-open-dmg-restore-cancel.json
node scripts/ci/artifact-manifest.mjs verify "$artifact_dir"
