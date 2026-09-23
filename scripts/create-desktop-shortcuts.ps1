$ErrorActionPreference = 'Stop'
$scriptsDir = $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')
$WshShell = New-Object -ComObject WScript.Shell

$start = $WshShell.CreateShortcut("$desktop\Start Local Model.lnk")
$start.TargetPath = "wscript.exe"
$start.Arguments = "`"$scriptsDir\start-local-hidden.vbs`""
$start.WorkingDirectory = $scriptsDir
$start.IconLocation = "shell32.dll,137"
$start.Description = "Start the local llama.cpp coding model for Cline"
$start.Save()

$stop = $WshShell.CreateShortcut("$desktop\Stop Local Model.lnk")
$stop.TargetPath = "wscript.exe"
$stop.Arguments = "`"$scriptsDir\stop-local-hidden.vbs`""
$stop.WorkingDirectory = $scriptsDir
$stop.IconLocation = "shell32.dll,131"
$stop.Description = "Stop the local llama.cpp coding model"
$stop.Save()

Write-Output "Created 'Start Local Model' and 'Stop Local Model' shortcuts on the Desktop."
