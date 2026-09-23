Set shell = CreateObject("WScript.Shell")
lms = shell.ExpandEnvironmentStrings("%USERPROFILE%") & "\.lmstudio\bin\lms.exe"
' Unload everything first: LM Studio's JIT auto-loading can leave stray duplicate
' instances loaded under other identifiers, which silently doubles VRAM usage.
shell.Run """" & lms & """ unload --all", 0, True
shell.Run """" & lms & """ load dolphin3.0-llama3.1-8b --gpu max -c 24576 --identifier local-coder -y", 0, True
shell.Run """" & lms & """ server start", 0, True
