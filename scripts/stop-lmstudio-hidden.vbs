Set shell = CreateObject("WScript.Shell")
lms = shell.ExpandEnvironmentStrings("%USERPROFILE%") & "\.lmstudio\bin\lms.exe"
shell.Run """" & lms & """ server stop", 0, True
shell.Run """" & lms & """ unload local-coder", 0, True
