$ErrorActionPreference = "Stop"

$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$CliPath = Join-Path $ProjectRoot "packages\cli\dist\bin\thearchy.js"

if (-not (Test-Path -LiteralPath $CliPath)) {
    throw "The built Thearchy CLI was not found."
}

Write-Host "Removing Thearchy from Codex Desktop..."
& node $CliPath desktop uninstall
if ($LASTEXITCODE -ne 0) { throw "Uninstall failed." }

Write-Host "Uninstall complete." -ForegroundColor Green
