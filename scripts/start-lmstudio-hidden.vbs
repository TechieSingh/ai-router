Set shell = CreateObject("WScript.Shell")
lms = shell.ExpandEnvironmentStrings("%USERPROFILE%") & "\.lmstudio\bin\lms.exe"
shell.Run """" & lms & """ load qwen3-8b-abliterated --gpu max -c 24576 --identifier local-coder -y", 0, True
shell.Run """" & lms & """ server start", 0, True
