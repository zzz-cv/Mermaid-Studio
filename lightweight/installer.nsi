Unicode True
!include "MUI2.nsh"

Name "Mermaid Studio"
OutFile "..\release\Mermaid-Studio-Setup.exe"
Icon "app.ico"
UninstallIcon "app.ico"
InstallDir "$LOCALAPPDATA\Programs\Mermaid Studio"
RequestExecutionLevel user
SetCompressor /SOLID lzma
ShowInstDetails nevershow
ShowUninstDetails nevershow

!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Section "安装 Mermaid Studio" MainSection
  RMDir /r "$INSTDIR"
  SetOutPath "$INSTDIR"
  File /r "..\release\Mermaid-Studio-Windows-x64\*.*"
  WriteUninstaller "$INSTDIR\卸载 Mermaid Studio.exe"
  CreateDirectory "$SMPROGRAMS\Mermaid Studio"
  CreateShortcut "$SMPROGRAMS\Mermaid Studio\Mermaid Studio.lnk" "$INSTDIR\Mermaid Studio.exe"
  CreateShortcut "$SMPROGRAMS\Mermaid Studio\卸载 Mermaid Studio.lnk" "$INSTDIR\卸载 Mermaid Studio.exe"
  CreateShortcut "$DESKTOP\Mermaid Studio.lnk" "$INSTDIR\Mermaid Studio.exe"
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\Mermaid Studio.lnk"
  RMDir /r "$SMPROGRAMS\Mermaid Studio"
  RMDir /r "$INSTDIR"
SectionEnd
