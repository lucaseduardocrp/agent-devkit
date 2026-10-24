# ADK launcher for Windows. Run it through adk.cmd (double-click it, or type `.\adk` in a terminal):
#
#   adk.cmd           start ADK; opens the setup wizard first when there is no configuration
#   adk.cmd setup     open the setup wizard to change the configuration, then restart
#   adk.cmd stop      stop ADK (data is kept)
#   adk.cmd logs      follow the logs (optionally of one service: adk.cmd logs api)
#   adk.cmd status    list the services and their health
#   adk.cmd update    download the latest version and restart
param(
  [Parameter(Position = 0)][string]$Command = 'start',
  [Parameter(Position = 1, ValueFromRemainingArguments = $true)][string[]]$Rest = @()
)

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$SetupPort = if ($env:ADK_SETUP_PORT) { $env:ADK_SETUP_PORT } else { '4000' }
$AllProfiles = @('--profile', 'e2e', '--profile', 'mcp', '--profile', 'mail')

function Say([string]$Text) { Write-Host "> $Text" -ForegroundColor Cyan }
function Ok([string]$Text) { Write-Host "OK $Text" -ForegroundColor Green }
function Fail([string]$Text) {
  Write-Host "X $Text" -ForegroundColor Red
  exit 1
}

# Reads KEY from .env (the wizard writes plain or single-quoted values).
function Get-EnvValue([string]$Key, [string]$Default) {
  $envFile = Join-Path $Root '.env'
  if (Test-Path $envFile) {
    $line = Get-Content $envFile | Where-Object { $_ -match "^$Key=" } | Select-Object -Last 1
    if ($line) {
      $value = $line.Substring($Key.Length + 1)
      if ($value -match "^'(.*)'$") { $value = $Matches[1] }
      if ($value) { return $value }
    }
  }
  return $Default
}

# Docker Desktop installs for all users (Program Files) or for the current one (AppData).
function Find-DockerDesktop {
  $candidates = @(
    (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\Docker Desktop.exe')
  )
  return $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}

function Test-DockerEngine {
  docker info *> $null
  return $LASTEXITCODE -eq 0
}

function Test-Docker {
  $desktop = Find-DockerDesktop
  if (-not (Get-Command docker -ErrorAction SilentlyContinue) -and -not $desktop) {
    $download = 'https://docs.docker.com/desktop/setup/install/windows-install/'
    try { Start-Process $download -ErrorAction Stop } catch {}
    Fail "Docker Desktop is not installed. Install it from $download (the page was opened), then start ADK again."
  }
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    # Installed but the terminal predates it: its bin folder is not on PATH yet.
    $env:Path = "$(Join-Path (Split-Path $desktop) 'resources\bin');$env:Path"
  }
  if (-not (Test-DockerEngine)) {
    if (-not $desktop) { Fail 'Docker is not running. Start Docker, wait until it is ready, and try again.' }
    Say 'Starting Docker Desktop. The first time it can take a couple of minutes...'
    Start-Process -FilePath $desktop
    $deadline = (Get-Date).AddMinutes(4)
    while (-not (Test-DockerEngine)) {
      if ((Get-Date) -gt $deadline) {
        Fail 'Docker Desktop did not start in 4 minutes. Open it, accept any prompt it shows, wait until it says "Engine running", and start ADK again.'
      }
      Start-Sleep -Seconds 3
    }
    Ok 'Docker is running.'
  }
  docker compose version *> $null
  if ($LASTEXITCODE -ne 0) { Fail 'Docker Compose v2 is missing. Update Docker Desktop.' }
}

function Stop-Setup {
  docker compose -f setup/compose.yaml down *> $null
}

# Runs the wizard and returns its exit code: 0 start now, 10 saved only, 2 cancelled.
function Invoke-Setup {
  $env:ADK_SETUP_LAUNCHER = '1'
  $env:ADK_SETUP_PORT = $SetupPort
  Say 'Starting the setup wizard...'
  Stop-Setup
  # Progress and errors go to the console (the first run downloads the Node.js image); Out-Host
  # keeps them out of this function's return value.
  docker compose -f setup/compose.yaml up -d --wait | Out-Host
  if ($LASTEXITCODE -ne 0) {
    Fail "Could not start the setup wizard (see the message above). If port $SetupPort is taken, choose another one with: `$env:ADK_SETUP_PORT='4100'; .\adk setup"
  }
  $url = "http://localhost:$SetupPort"
  Ok "Setup wizard ready: $url"
  Say 'Finish the steps in your browser. Press Ctrl+C here to cancel.'
  try { Start-Process $url -ErrorAction Stop }
  catch { Say "Open $url in your browser." }
  $code = 2
  try {
    $code = [int](docker wait adk-setup)
    # Out-Host keeps the logs out of this function's return value.
    if ($code -ne 0 -and $code -ne 10 -and $code -ne 2) { docker logs adk-setup | Out-Host }
  }
  finally {
    Stop-Setup
  }
  return $code
}

# Removes containers of optional services that the configuration turned off.
function Remove-Disabled {
  $profiles = (Get-EnvValue 'COMPOSE_PROFILES' '') -split ','
  $disabled = @()
  if ($profiles -notcontains 'e2e') { $disabled += 'worker' }
  if ($profiles -notcontains 'mcp') { $disabled += 'mcp' }
  if ($profiles -notcontains 'mail') { $disabled += 'mailpit' }
  if ($disabled.Count -gt 0) {
    docker compose @AllProfiles rm --stop --force @disabled *> $null
  }
}

function Start-Adk([bool]$OpenedBySetup = $false) {
  Remove-Disabled
  Say 'Building and starting ADK. The first start can take 5 to 15 minutes; later starts take seconds.'
  docker compose up -d --build --remove-orphans --wait --wait-timeout 1800
  if ($LASTEXITCODE -ne 0) { Fail 'ADK did not start. See what happened with: .\adk logs' }
  $web = Get-EnvValue 'FRONTEND_URL' 'http://localhost:8080'
  Write-Host ''
  Ok "ADK is running at $web"
  Write-Host '   Stop it with .\adk stop - change settings with .\adk setup - logs with .\adk logs'
  # The wizard page already follows the start and links to the app.
  if (-not $OpenedBySetup) { Start-Process $web }
}

function Invoke-SetupThenStart {
  $code = Invoke-Setup
  switch ($code) {
    0 { Start-Adk $true }
    10 { Ok 'Configuration saved. Start ADK with: .\adk' }
    2 { Say 'Setup cancelled. Nothing was changed.' }
    default { Fail "The setup wizard stopped unexpectedly (exit code $code)." }
  }
}

switch ($Command.ToLowerInvariant()) {
  'start' {
    Test-Docker
    if (Test-Path (Join-Path $Root '.env')) {
      Say 'Using the existing configuration (.env). To open the setup wizard instead, run: .\adk setup'
      Start-Adk
    }
    else { Invoke-SetupThenStart }
  }
  'setup' {
    Test-Docker
    Invoke-SetupThenStart
  }
  { $_ -in @('stop', 'logs', 'status') -and -not (Test-Path (Join-Path $Root '.env')) } {
    Say 'ADK is not set up yet. Double-click adk.cmd (or run .\adk) to open the setup wizard.'
    exit 0
  }
  'stop' {
    Test-Docker
    docker compose @AllProfiles down
    Ok 'ADK stopped. Your data is kept; start again with .\adk'
  }
  'logs' {
    Test-Docker
    docker compose logs --follow --tail 200 @Rest
  }
  'status' {
    Test-Docker
    docker compose ps
  }
  'update' {
    Test-Docker
    if (Test-Path (Join-Path $Root '.git')) {
      Say 'Downloading the latest version...'
      git pull --ff-only
      if ($LASTEXITCODE -ne 0) { Fail 'Could not update. Commit or stash your local changes and try again.' }
    }
    if (Test-Path (Join-Path $Root '.env')) { Start-Adk } else { Invoke-SetupThenStart }
  }
  { $_ -in @('help', '-h', '--help', '/?') } {
    Get-Content $PSCommandPath | Select-Object -First 8 | ForEach-Object { $_ -replace '^# ?', '' }
  }
  default {
    Fail "Unknown command: $Command. Run: .\adk help"
  }
}
