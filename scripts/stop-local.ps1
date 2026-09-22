$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimePath = Join-Path $projectRoot '.runtime'
$record = Get-Content -LiteralPath (Join-Path $runtimePath 'local-process.json') -Raw | ConvertFrom-Json
$process = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
if (-not $process) { Write-Output 'Local model is already stopped.'; exit 0 }
if (-not $process.Path -or $process.Path -ne $record.executable -or -not $process.Path.StartsWith($runtimePath + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Process identity does not match the local model. Refusing to stop it.' }
Stop-Process -Id $process.Id
Write-Output 'Local model stopped.'
