# Builds the Android APK on this PC.
#   .\build-apk.ps1
# Needs Java 17 and the Android SDK in D:\android-build (see README). The first
# run downloads Gradle and the libraries, so it takes much longer than later runs.
# Output: mobile\android\app\build\outputs\apk\release\app-release.apk

param(
  [string]$Tools = 'D:\android-build',
  [string]$Proxy = ''
)
$ErrorActionPreference = 'Stop'

$jdk = Get-ChildItem (Join-Path $Tools 'jdk') -Directory | Select-Object -First 1
if (-not $jdk) { throw "Java was not found in $Tools\jdk." }
$env:JAVA_HOME        = $jdk.FullName
$env:ANDROID_HOME     = Join-Path $Tools 'sdk'
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:GRADLE_USER_HOME = Join-Path $Tools 'gradle-home'
$env:NODE_ENV         = 'production'
$env:PATH             = "$($jdk.FullName)\bin;$env:PATH"
if ($Proxy) { $env:HTTPS_PROXY = $Proxy; $env:HTTP_PROXY = $Proxy }

$android = Join-Path $PSScriptRoot 'android'
if (-not (Test-Path (Join-Path $android 'gradlew.bat'))) {
  Push-Location $PSScriptRoot
  try { & npx.cmd expo prebuild --platform android --no-install } finally { Pop-Location }
}
$props = @("sdk.dir=" + ($env:ANDROID_HOME -replace '\\', '/'))
# Use the newest CMake in the SDK: its ninja (1.12+) handles Windows paths longer
# than 260 characters, which this build produces. The default 3.22.1 does not.
$cmake = Get-ChildItem (Join-Path $env:ANDROID_HOME 'cmake') -Directory -ErrorAction SilentlyContinue |
  Sort-Object { [version]$_.Name } | Select-Object -Last 1
if ($cmake) { $props += "cmake.dir=" + ($cmake.FullName -replace '\\', '/') }
Set-Content -Path (Join-Path $android 'local.properties') -Value $props
Remove-Item (Join-Path $android 'app\.cxx') -Recurse -Force -ErrorAction SilentlyContinue

Push-Location $android
try {
  # arm64-v8a covers practically every Android phone made since 2017.
  & .\gradlew.bat assembleRelease '-PreactNativeArchitectures=arm64-v8a' '--console=plain'
  if ($LASTEXITCODE -ne 0) { throw "Gradle build failed (exit code $LASTEXITCODE)." }
} finally {
  Pop-Location
}
$apk = Join-Path $android 'app\build\outputs\apk\release\app-release.apk'
Write-Host "APK: $apk"
