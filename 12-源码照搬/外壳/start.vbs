Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
' 2026-11-12 fixed: the old line was the placeholder "<workbench>\shell", which never exists.
' Now it resolves from this script's own folder (this file sits in the shell folder).
sh.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "cmd /c ""node_modules\.bin\electron.cmd"" .", 0, False