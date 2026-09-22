$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimePath = Join-Path $projectRoot '.runtime'
$fixturePath = Join-Path $runtimePath 'extension-fixture'
New-Item -ItemType Directory -Path $fixturePath -Force | Out-Null
$codeLauncher = (Get-Command code).Source
$codeExe = Join-Path (Split-Path (Split-Path $codeLauncher -Parent) -Parent) 'Code.exe'
$env:ELECTRON_RUN_AS_NODE = $null
$testArgs = @('--disable-gpu', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--disable-extensions', ('--user-data-dir="' + (Join-Path $runtimePath 'vscode-test-user') + '"'), ('--extensions-dir="' + (Join-Path $runtimePath 'vscode-test-extensions') + '"'), ('--extensionDevelopmentPath="' + $projectRoot + '"'), ('--extensionTestsPath="' + (Join-Path $PSScriptRoot 'extension-smoke.cjs') + '"'), ('"' + $fixturePath + '"'))
$process = Start-Process -FilePath $codeExe -ArgumentList $testArgs -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimePath 'extension-test.stdout.log') -RedirectStandardError (Join-Path $runtimePath 'extension-test.stderr.log')
Write-Output "Isolated VS Code test started (PID $($process.Id)). Result: .runtime/extension-smoke-result.json"
