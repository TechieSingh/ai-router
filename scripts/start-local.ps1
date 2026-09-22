param([int]$Port = 8080, [ValidateSet(8192,16384,40960)][int]$Context = 40960)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimePath = Join-Path $projectRoot '.runtime'
$manifest = Get-Content -LiteralPath (Join-Path $runtimePath 'local-model.json') -Raw | ConvertFrom-Json
foreach ($target in @($manifest.llamaServer, $manifest.modelPath)) {
    $resolved = [IO.Path]::GetFullPath($target)
    if (-not $resolved.StartsWith($runtimePath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Runtime path must remain inside this project.' }
    if (-not (Test-Path -LiteralPath $resolved)) { throw "Missing file: $resolved" }
}
$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listener) { throw "Port $Port is already in use. Check Connections in the extension or choose another port." }
$serverArgs = @('-m', ('"' + $manifest.modelPath + '"'), '--alias', 'local-coder', '--host', '127.0.0.1', '--port', "$Port", '--ctx-size', "$Context", '--parallel', '1', '--n-gpu-layers', '99', '--threads', '4', '--jinja', '--flash-attn', 'on', '--cache-type-k', 'q8_0', '--cache-type-v', 'q8_0', '--batch-size', '8192', '--ubatch-size', '4096')
$process = Start-Process -FilePath $manifest.llamaServer -ArgumentList $serverArgs -WorkingDirectory (Split-Path -Parent $manifest.llamaServer) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimePath 'local.stdout.log') -RedirectStandardError (Join-Path $runtimePath 'local.stderr.log')
@{ pid = $process.Id; executable = $manifest.llamaServer; port = $Port; context = $Context } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtimePath 'local-process.json')
Write-Output "Local model loading in the background (PID $($process.Id)). Endpoint: http://127.0.0.1:$Port/v1"
Write-Output "Set Jev Router local context to $Context. Logs: $runtimePath"
