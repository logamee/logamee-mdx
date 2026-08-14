param(
  [Parameter(Mandatory = $true)][string]$ArtifactDirectory,
  [Parameter(Mandatory = $true)][string]$Target,
  [ValidateSet('instrumented', 'release')][string]$Mode = 'instrumented'
)

$ErrorActionPreference = 'Stop'

if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') {
  throw "Expected Windows x64, found $([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture)"
}
node scripts/ci/artifact-manifest.mjs verify $ArtifactDirectory
if ($LASTEXITCODE -ne 0) { throw 'Artifact manifest verification failed' }

$installers = @(Get-ChildItem -LiteralPath $ArtifactDirectory -Filter '*-setup.exe' -File)
if ($installers.Count -ne 1) { throw "Expected one NSIS installer, found $($installers.Count)" }
$signature = Get-AuthenticodeSignature -LiteralPath $installers[0].FullName
"Windows Authenticode classification: $($signature.Status)"
if ($signature.Status -notin @('Valid', 'NotSigned')) { throw "Unexpected Authenticode status: $($signature.Status)" }

$install = Start-Process -FilePath $installers[0].FullName -ArgumentList '/S' -Wait -PassThru
if ($install.ExitCode -ne 0) { throw "NSIS install failed with exit code $($install.ExitCode)" }

$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\mdx'
if (-not (Test-Path -LiteralPath $uninstallKey)) { throw 'Tauri NSIS uninstall registry entry is missing' }
$installation = Get-ItemProperty -LiteralPath $uninstallKey
$installDirectory = ([string]$installation.InstallLocation).Trim('"')
$mainBinary = [string]$installation.MainBinaryName
if (-not $installDirectory -or -not $mainBinary) { throw 'Tauri NSIS install metadata is incomplete' }
$appPath = Join-Path $installDirectory $mainBinary
if (-not (Test-Path -LiteralPath $appPath -PathType Leaf)) { throw "Installed application is missing: $appPath" }

if ($Mode -eq 'release') {
  $app = Start-Process -FilePath $appPath -PassThru
  Start-Sleep -Seconds 5
  if ($app.HasExited) { throw "Installed mdx exited early with code $($app.ExitCode)" }
  $app.Kill()
  $app.WaitForExit()
} else {
  $localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
  if ([string]::IsNullOrWhiteSpace($localAppData)) {
    throw 'Windows LocalApplicationData is unavailable'
  }
  $lifecycleTemp = Join-Path $localAppData 'Temp'
  $systemVolume = [IO.Path]::GetPathRoot([Environment]::SystemDirectory)
  $lifecycleVolume = [IO.Path]::GetPathRoot($lifecycleTemp)
  if ($lifecycleVolume -ine $systemVolume) {
    throw "Windows packaged lifecycle temp must use the system volume: $lifecycleTemp"
  }
  New-Item -ItemType Directory -Path $lifecycleTemp -Force | Out-Null
  $env:TEMP = $lifecycleTemp
  $env:TMP = $lifecycleTemp
  $env:TMPDIR = $lifecycleTemp

  $challenge = Join-Path $env:RUNNER_TEMP 'mmd-packaged-lifecycle-nsis.json'
  node scripts/ci/packaged-lifecycle-runner.mjs `
    --evidence (Join-Path $ArtifactDirectory 'm2-lifecycle-evidence.json') `
    --package-variant nsis `
    --target $Target `
    --challenge-output $challenge `
    -- $appPath
  if ($LASTEXITCODE -ne 0) { throw 'Packaged lifecycle runner failed' }
  node scripts/ci/lifecycle-evidence.mjs verify-packaged `
    --evidence (Join-Path $ArtifactDirectory 'm2-lifecycle-evidence.json') `
    --artifact-directory $ArtifactDirectory `
    --packaged-challenge $challenge `
    --output (Join-Path $ArtifactDirectory 'm2-lifecycle-evidence.json')
  if ($LASTEXITCODE -ne 0) { throw 'Packaged lifecycle evidence verification failed' }
  foreach ($profile in @('apply-reobserve', 'restore-cancel')) {
    $openChallenge = Join-Path $env:RUNNER_TEMP "mmd-packaged-open-nsis-$profile.json"
    node scripts/ci/packaged-open-evidence.mjs issue `
      --target $Target `
      --package-variant nsis `
      --platform windows `
      --profile $profile `
      --output $openChallenge
    if ($LASTEXITCODE -ne 0) { throw "Packaged native-open challenge creation failed: $profile" }
    node scripts/ci/packaged-open-runner.mjs `
      --challenge $openChallenge `
      --binary $appPath `
      --output (Join-Path $ArtifactDirectory "m3-native-open-nsis-$profile.json")
    if ($LASTEXITCODE -ne 0) { throw "Packaged native-open runner failed: $profile" }
  }
  node scripts/ci/artifact-manifest.mjs create $ArtifactDirectory `
    $installers[0].Name m2-lifecycle-evidence.json `
    m3-native-open-nsis-apply-reobserve.json m3-native-open-nsis-restore-cancel.json
  if ($LASTEXITCODE -ne 0) { throw 'Verified artifact manifest creation failed' }
  node scripts/ci/artifact-manifest.mjs verify $ArtifactDirectory
  if ($LASTEXITCODE -ne 0) { throw 'Verified artifact manifest verification failed' }
}

$uninstaller = Join-Path $installDirectory 'uninstall.exe'
if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) { throw 'NSIS uninstaller is missing' }
$uninstall = Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru
if ($uninstall.ExitCode -ne 0) { throw "NSIS uninstall failed with exit code $($uninstall.ExitCode)" }
if (Test-Path -LiteralPath $uninstallKey) { throw 'NSIS uninstall registry entry was not removed' }
