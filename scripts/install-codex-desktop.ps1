param(
    [switch]$NoLaunch
)

$ErrorActionPreference = "Stop"

$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$CliPath = Join-Path $ProjectRoot "packages\cli\dist\bin\thearchy.js"

Write-Host "Thearchy - Codex Desktop one-click installer" -ForegroundColor Cyan
Write-Host "Project: $ProjectRoot"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js was not found. Install Node.js 22 or later."
}
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    throw "npm was not found. Install Node.js 22 or later with npm."
}

if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot "node_modules"))) {
    Write-Host "Installing locked dependencies..."
    & npm.cmd ci --prefix $ProjectRoot
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed." }
}

Write-Host "Building the self-contained desktop plugin..."
& npm.cmd run build --prefix $ProjectRoot
if ($LASTEXITCODE -ne 0) { throw "The project build failed." }

Write-Host "Installing into the Codex personal plugin directory..."
$InstallArguments = @($CliPath, "desktop", "install")
if ($NoLaunch) {
    $InstallArguments += "--no-launch"
}
& node @InstallArguments
if ($LASTEXITCODE -ne 0) { throw "Codex desktop installation failed." }

Write-Host ""
Write-Host "Installation complete." -ForegroundColor Green
Write-Host "In Codex, start a new task and ask it to use Thearchy."
