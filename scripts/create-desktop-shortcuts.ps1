$ErrorActionPreference = 'Stop'
$scriptsDir = $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')
$WshShell = New-Object -ComObject WScript.Shell

$start = $WshShell.CreateShortcut("$desktop\Start Local Model.lnk")
$start.TargetPath = "wscript.exe"
$start.Arguments = "`"$scriptsDir\start-lmstudio-hidden.vbs`""
$start.WorkingDirectory = $scriptsDir
$start.IconLocation = "shell32.dll,137"
$start.Description = "Load the local model and start LM Studio's server for Cline"
$start.Save()

$stop = $WshShell.CreateShortcut("$desktop\Stop Local Model.lnk")
$stop.TargetPath = "wscript.exe"
$stop.Arguments = "`"$scriptsDir\stop-lmstudio-hidden.vbs`""
$stop.WorkingDirectory = $scriptsDir
$stop.IconLocation = "shell32.dll,131"
$stop.Description = "Stop LM Studio's server and unload the model"
$stop.Save()

Write-Output "Created 'Start Local Model' and 'Stop Local Model' shortcuts on the Desktop."
