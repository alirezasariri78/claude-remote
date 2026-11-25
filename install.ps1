<#
  Claude Remote - install or update on a Windows PC.

  Put this file in the folder that contains the "server" and "mobile" folders,
  open PowerShell as Administrator there, and run:

      powershell -ExecutionPolicy Bypass -File .\install.ps1

  What it does, in order:
    1. Checks Node.js, npm and Claude Code.
    2. Removes the Claude Remote services from an earlier install. Only the two
       services this project creates are touched ("Claude Remote" and
       "Claude Remote Web", running from this project's daemon folders);
       Claude's own services are never touched.
    3. Runs "npm install" in server, mobile and mobile\service.
    4. Builds the web app.
    5. Installs both Windows services and starts them:
         Claude Remote       the service, running as your Windows account
         Claude Remote Web   the web app (static files, Local System)
    6. Optionally installs the desktop-app permission hook and opens the
       firewall for private networks.

  Options:
    -KeepServices   Update only: keep the installed services (and the saved
                    Windows password), stop them, update, start them again.
    -CheckOnly      Change nothing; show what would be removed.

  Your settings (server\bridge-config.json, mobile\service\web-config.json)
  are kept on updates.
#>

param(
  [switch]$KeepServices,
  [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'

$Root      = $PSScriptRoot
$ServerDir = Join-Path $Root 'server'
$MobileDir = Join-Path $Root 'mobile'
$WebDir    = Join-Path $MobileDir 'service'

# node-windows names a service from its display name: lower case, no spaces, ".exe".
$ServerSvc = @{ Id = 'clauderemote.exe';    Display = 'Claude Remote';     Dir = $ServerDir }
$WebSvc    = @{ Id = 'clauderemoteweb.exe'; Display = 'Claude Remote Web'; Dir = $WebDir }

# ------------------------------------------------------------------ helpers

function Say([string]$Text)  { Write-Host ''; Write-Host "== $Text" -ForegroundColor Cyan }
function Note([string]$Text) { Write-Host "   $Text" }
function Good([string]$Text) { Write-Host "   $Text" -ForegroundColor Green }
function Warn([string]$Text) { Write-Host "   ! $Text" -ForegroundColor Yellow }
function Fail([string]$Text) { Write-Host ''; Write-Host "X  $Text" -ForegroundColor Red; exit 1 }

function Ask([string]$Question, [string]$Default) {
  if ($Default) { $a = Read-Host "   $Question [$Default]" } else { $a = Read-Host "   $Question" }
  if ([string]::IsNullOrWhiteSpace($a)) { return $Default }
  return $a.Trim()
}

function AskYesNo([string]$Question, [bool]$Default = $true) {
  $hint = 'y/N'
  if ($Default) { $hint = 'Y/n' }
  $a = Read-Host "   $Question ($hint)"
  if ([string]::IsNullOrWhiteSpace($a)) { return $Default }
  return $a.Trim().ToLower().StartsWith('y')
}

# The service only if it is really ours: same name AND running from this project's daemon folder.
function Get-OurService($Svc) {
  $s = Get-CimInstance Win32_Service -Filter "Name='$($Svc.Id)'" -ErrorAction SilentlyContinue
  if (-not $s) { return $null }
  $expected = [regex]::Escape((Join-Path $Svc.Dir 'daemon'))
  $path = ([string]$s.PathName).Trim('"')
  if ($path -match "^$expected\\") { return $s }
  # Same name, other folder: an install of this project somewhere else on the PC.
  if ($path -match '\\daemon\\clauderemote(web)?\.exe$') { return $s }
  Warn "A service named $($Svc.Id) exists but does not look like Claude Remote ($path). It is left alone."
  return $null
}

function Wait-ServiceGone([string]$Id) {
  for ($i = 0; $i -lt 30; $i++) {
    if (-not (Get-CimInstance Win32_Service -Filter "Name='$Id'" -ErrorAction SilentlyContinue)) { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}

function Stop-OurService($Svc) {
  $s = Get-OurService $Svc
  if (-not $s) { return }
  if ($s.State -ne 'Stopped') {
    Note "Stopping $($Svc.Display)..."
    Stop-Service -Name $Svc.Id -Force -ErrorAction SilentlyContinue
    (Get-Service -Name $Svc.Id).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
  }
}

function Remove-OurService($Svc) {
  $s = Get-OurService $Svc
  if (-not $s) { return }
  Stop-OurService $Svc
  Note "Removing $($Svc.Display)..."
  $script = Join-Path $Svc.Dir 'service.mjs'
  $removed = $false
  if ((Test-Path (Join-Path $Svc.Dir 'node_modules\node-windows')) -and (Test-Path $script)) {
    Push-Location $Svc.Dir
    try { & node.exe service.mjs uninstall | Out-Null } catch {} finally { Pop-Location }
    $removed = Wait-ServiceGone $Svc.Id
  }
  if (-not $removed) {
    & sc.exe delete $Svc.Id | Out-Null
    if (-not (Wait-ServiceGone $Svc.Id)) { Fail "Could not remove $($Svc.Display). Close services.msc and run this again." }
  }
  Good "$($Svc.Display) removed."
}

function Invoke-Npm([string]$Dir, [string[]]$NpmArgs, [string]$What) {
  Note "$What ($Dir)"
  Push-Location $Dir
  try {
    & npm.cmd @NpmArgs --no-fund --no-audit --loglevel=error
    if ($LASTEXITCODE -ne 0) { Fail "$What failed in $Dir (npm exit code $LASTEXITCODE)." }
  } finally { Pop-Location }
}

# "Log on as a service" right, needed by the account the server runs as.
function Grant-LogonAsService([string]$Account) {
  $sid = (New-Object System.Security.Principal.NTAccount($Account)).Translate([System.Security.Principal.SecurityIdentifier]).Value
  $tmp = Join-Path $env:TEMP "claude-remote-secpol-$PID"
  $inf = "$tmp.inf"; $db = "$tmp.sdb"
  try {
    & secedit.exe /export /cfg $inf /areas USER_RIGHTS | Out-Null
    $lines = Get-Content $inf
    $line = $lines | Where-Object { $_ -like 'SeServiceLogonRight*' }
    if ($line -and $line -match [regex]::Escape("*$sid")) { return }
    $new = if ($line) { "$line,*$sid" } else { "SeServiceLogonRight = *$sid" }
    $out = @('[Unicode]', 'Unicode=yes', '[Version]', 'signature="$CHICAGO$"', 'Revision=1', '[Privilege Rights]', $new)
    Set-Content -Path $inf -Value $out -Encoding Unicode
    & secedit.exe /configure /db $db /cfg $inf /areas USER_RIGHTS | Out-Null
    Good "Granted 'Log on as a service' to $Account."
  } finally {
    Remove-Item $inf, $db, "$tmp.log" -ErrorAction SilentlyContinue
  }
}

function Read-Json([string]$Path) {
  if (-not (Test-Path $Path)) { return $null }
  try { return Get-Content $Path -Raw | ConvertFrom-Json } catch { Warn "$Path is not valid JSON; it will be left as it is."; return $null }
}

# ------------------------------------------------------------------ checks

Write-Host ''
Write-Host 'Claude Remote - install / update' -ForegroundColor White

if (-not (Test-Path (Join-Path $ServerDir 'index.mjs')) -or -not (Test-Path (Join-Path $MobileDir 'package.json'))) {
  Fail "Put install.ps1 in the folder that contains 'server' and 'mobile' (now: $Root)."
}

$existing = @($ServerSvc, $WebSvc) | Where-Object { Get-OurService $_ }
if ($CheckOnly) {
  Say 'Check only - nothing is changed'
  if ($existing) { foreach ($s in $existing) { Note "Would remove/update: $($s.Display) ($($s.Id))" } }
  else { Note 'No Claude Remote services are installed.' }
  exit 0
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Fail 'Run PowerShell as Administrator (right-click > Run as administrator), then run this again.' }

Say 'Checking the tools'
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) { Fail 'Node.js is not installed. Install it from https://nodejs.org (version 20 or newer) and run this again.' }
$nodeMajor = [int]((& node.exe -v).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 20) { Fail "Node.js $(& node.exe -v) is too old; install version 20 or newer." }
Good "Node.js $(& node.exe -v)"
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { Fail 'npm was not found. Reinstall Node.js with npm included.' }
if (Get-Command claude -ErrorAction SilentlyContinue) { Good 'Claude Code found' }
else { Warn "Claude Code was not found in PATH. Install it and sign in ('claude', then '/login') as the account the service will use." }
if ($Root.Length -gt 60) { Warn "This folder's path is long ($Root). If the service cannot start Claude, move the project to a short path such as C:\claude-remote." }

# ------------------------------------------------------------------ questions

$update = $KeepServices -and ((Get-OurService $ServerSvc) -or (Get-OurService $WebSvc))
if ($KeepServices -and -not $update) { Warn 'No installed services found to keep; doing a full install instead.' }

$serverConfig = Read-Json (Join-Path $ServerDir 'bridge-config.json')

if (-not $update) {
  Say 'Settings'
  Note 'The service must run as YOUR Windows account: Claude Code''s sign-in and sessions live in your profile.'
  $account = Ask 'Windows account for the service' "$env:USERDOMAIN\$env:USERNAME"
  $securePw = Read-Host "   Password for $account (not shown, not saved by this script)" -AsSecureString

  $defaultProxy = ''
  if ($serverConfig -and $serverConfig.proxy) { $defaultProxy = [string]$serverConfig.proxy }
  $proxy = Ask 'HTTP proxy this PC needs to reach the internet (empty = none)' $defaultProxy

  $wantHook = AskYesNo 'Send permission prompts from the Claude desktop app to your phone (installs a Claude Code hook)?' $true
  $wantFirewall = AskYesNo 'Allow the phone to connect (open the ports in Windows Firewall, private networks only)?' $true
}

# ------------------------------------------------------------------ stop / remove

if ($update) {
  Say 'Stopping the services'
  Stop-OurService $ServerSvc
  Stop-OurService $WebSvc
} elseif ($existing) {
  Say 'Removing the previous install'
  Remove-OurService $ServerSvc
  Remove-OurService $WebSvc
}

# ------------------------------------------------------------------ packages and build

Say 'Installing packages (this can take a few minutes the first time)'
Invoke-Npm $ServerDir @('install') 'Server packages'
Invoke-Npm $MobileDir @('install') 'App packages'
Invoke-Npm $WebDir @('install') 'Web host packages'

Say 'Building the web app'
Invoke-Npm $MobileDir @('run', 'build:web') 'Web app build'

# Create the settings files (access token, ports) and store the proxy.
Push-Location $ServerDir
try {
  & node.exe --input-type=module -e "import('./config.mjs').then(m => m.loadConfig())"
  if (-not $update) {
    $env:CR_PROXY = $proxy
    & node.exe --input-type=module -e "import('./config.mjs').then(m => { m.loadConfig(); m.saveSetting('proxy', process.env.CR_PROXY || ''); })"
    Remove-Item Env:CR_PROXY
  }
} finally { Pop-Location }
$serverConfig = Read-Json (Join-Path $ServerDir 'bridge-config.json')
$serverPort = 8787
if ($serverConfig -and $serverConfig.port) { $serverPort = [int]$serverConfig.port }

# ------------------------------------------------------------------ services

if ($update) {
  Say 'Starting the services'
  foreach ($svc in @($ServerSvc, $WebSvc)) {
    if (Get-OurService $svc) { Start-Service -Name $svc.Id; Good "$($svc.Display) started." }
    else { Warn "$($svc.Display) is not installed. Run this script without -KeepServices to install it." }
  }
} else {
  Say 'Installing the services'

  Push-Location $ServerDir
  try { & node.exe service.mjs install | Out-Null } finally { Pop-Location }
  for ($i = 0; $i -lt 30 -and -not (Get-OurService $ServerSvc); $i++) { Start-Sleep -Seconds 1 }
  if (-not (Get-OurService $ServerSvc)) { Fail 'The "Claude Remote" service was not created. Check that this terminal runs as Administrator.' }

  Grant-LogonAsService $account
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePw))
  $svcObj = Get-CimInstance Win32_Service -Filter "Name='$($ServerSvc.Id)'"
  $r = Invoke-CimMethod -InputObject $svcObj -MethodName Change -Arguments @{ StartName = $account; StartPassword = $plain }
  $plain = $null
  if ($r.ReturnValue -ne 0) { Fail "Could not set the service account (code $($r.ReturnValue)). Check the account name." }
  Set-Service -Name $ServerSvc.Id -StartupType Automatic
  try {
    Start-Service -Name $ServerSvc.Id
    Good "Claude Remote installed and started as $account."
  } catch {
    Fail "Claude Remote did not start. The password is probably wrong: open services.msc > Claude Remote > Log On, enter it again, then start the service. ($($_.Exception.Message))"
  }

  Push-Location $WebDir
  try { & node.exe service.mjs install | Out-Null } finally { Pop-Location }
  for ($i = 0; $i -lt 30 -and -not (Get-OurService $WebSvc); $i++) { Start-Sleep -Seconds 1 }
  if (Get-OurService $WebSvc) {
    Set-Service -Name $WebSvc.Id -StartupType Automatic
    if ((Get-Service -Name $WebSvc.Id).Status -ne 'Running') { Start-Service -Name $WebSvc.Id }
    Good 'Claude Remote Web installed and started.'
  } else {
    Warn 'The "Claude Remote Web" service was not created; the app still works from Expo or the APK.'
  }

  # ---------------------------------------------------------------- optional parts

  if ($wantHook) {
    Say 'Permission hook for the Claude desktop app'
    if ($account -ieq "$env:USERDOMAIN\$env:USERNAME" -or $account -ieq $env:USERNAME) {
      Push-Location $ServerDir
      try { & node.exe hook/install.mjs install } finally { Pop-Location }
    } else {
      Warn "The hook goes into $account's Claude settings. Sign in as $account and run:"
      Warn "   node `"$ServerDir\hook\install.mjs`" install"
    }
  }

  if ($wantFirewall) {
    Say 'Firewall'
    $webConfig = Read-Json (Join-Path $WebDir 'web-config.json')
    $webPort = 8091
    if ($webConfig -and $webConfig.port) { $webPort = [int]$webConfig.port }
    foreach ($rule in @(@{ Name = 'Claude Remote'; Port = $serverPort }, @{ Name = 'Claude Remote Web'; Port = $webPort })) {
      Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
      New-NetFirewallRule -DisplayName $rule.Name -Direction Inbound -Protocol TCP -LocalPort $rule.Port -Action Allow -Profile Private | Out-Null
      Good "Port $($rule.Port) open on private networks ($($rule.Name))."
    }
  }
}

# ------------------------------------------------------------------ summary

$webConfig = Read-Json (Join-Path $WebDir 'web-config.json')
$webPort = 8091
if ($webConfig -and $webConfig.port) { $webPort = [int]$webConfig.port }
$ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' -and $_.PrefixOrigin -ne 'WellKnown' } |
  Select-Object -First 1).IPAddress
if (-not $ip) { $ip = '<this PC''s address>' }

Say 'Done'
Write-Host "Web app:        http://${ip}:$webPort"
Write-Host "Android app:    address ${ip}:$serverPort"
Write-Host "Access token:   see 'token' in $ServerDir\bridge-config.json"
Write-Host "Telegram bot:   put the bot token in that file (see docs\SETUP.md), then restart the service"
Write-Host "Update later:   .\install.ps1 -KeepServices"
Write-Host ''
