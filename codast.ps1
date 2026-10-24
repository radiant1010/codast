param(
    [ValidateSet('init', 'start', 'test', 'help')]
    [string]$Command = 'start'
)

$ErrorActionPreference = 'Stop'
if ($Command -eq 'help') {
    Write-Host '.\codast.cmd init   - Install packages and shared Serena/Context7 tools'
    Write-Host '.\codast.cmd start  - Prepare packages and start CODAST (default)'
    Write-Host '.\codast.cmd test   - Prepare packages and run Python tests'
    exit 0
}

Push-Location -LiteralPath $PSScriptRoot
try {
    $uvPath = Join-Path $PSScriptRoot '.local\uv\uv.exe'
    if (-not (Test-Path -LiteralPath $uvPath -PathType Leaf)) {
        $installed = Get-Command uv -CommandType Application -ErrorAction SilentlyContinue
        if ($installed) {
            $uvPath = $installed.Source
        } else {
            Write-Host 'Installing uv from astral.sh...'
            $localDirectory = Join-Path $PSScriptRoot '.local'
            [IO.Directory]::CreateDirectory($localDirectory) | Out-Null
            $installer = Join-Path $localDirectory 'uv-install.ps1'
            Invoke-WebRequest -UseBasicParsing -Uri 'https://astral.sh/uv/install.ps1' -OutFile $installer -TimeoutSec 60
            $previousInstall = $env:UV_UNMANAGED_INSTALL
            $previousModulePath = $env:PSModulePath
            try {
                $env:UV_UNMANAGED_INSTALL = Split-Path -Parent $uvPath
                # A cmd parent can pass incompatible PowerShell 7 modules to Windows PowerShell.
                $env:PSModulePath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules'
                & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File $installer
                if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $uvPath -PathType Leaf)) {
                    throw 'uv installation failed. Check the download output and try again.'
                }
            } finally {
                $env:UV_UNMANAGED_INSTALL = $previousInstall
                $env:PSModulePath = $previousModulePath
            }
        }
    }
    # Keep setup local even if a different project's environment is active.
    $env:UV_PROJECT_ENVIRONMENT = Join-Path $PSScriptRoot '.venv'
    Write-Host 'Preparing Python and project packages from uv.lock...'
    $syncArgs = @('sync', '--locked', '--inexact')
    if (-not (Test-Path -LiteralPath (Join-Path $env:UV_PROJECT_ENVIRONMENT 'Scripts\python.exe') -PathType Leaf)) {
        $syncArgs += @('--python', '3.12')
    }
    & $uvPath @syncArgs
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'Package setup failed. Fix the error above and run the command again.'
        exit $LASTEXITCODE
    }
    if ($Command -eq 'init') {
        & $uvPath run --no-sync python -m app.core.toolchain --uv $uvPath
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        Write-Host 'Setup complete. Run .\codast.cmd start to open the server.'
        Write-Host 'Install and sign in to Codex or Claude Code separately to use AI.'
        exit 0
    }
    if ($Command -eq 'test') {
        & $uvPath run --no-sync python -m pytest -q
    } else {
        Write-Host 'CODAST: http://127.0.0.1:8765 (Ctrl+C to stop)'
        & $uvPath run --no-sync python start.py
    }
    exit $LASTEXITCODE
} catch {
    [Console]::Error.WriteLine('CODAST setup failed: ' + $_.Exception.Message)
    exit 1
} finally {
    Pop-Location
}
