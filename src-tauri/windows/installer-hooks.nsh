; Tauri NSIS installer hooks for Sentry Drive.
;
; Moving from the Electron build: before installing, remove an existing
; Electron (electron-builder NSIS) install of Sentry Drive so the user doesn't
; end up with two copies, two Start menu entries and two uninstallers. User
; data in %APPDATA%\sentry-drive is kept (/KEEP_APP_DATA --updated, the same
; flags electron-builder passes when it replaces an old version), and the
; Tauri build keeps using that folder.
;
; electron-builder registers the install under a GUID derived from the appId
; (UUID v5 of "com.jefffromtheirs.sentry-drive" in electron-builder's
; namespace) for both per-user and per-machine installs.

!define SD_ELECTRON_GUID "f802e32b-e809-593b-9b6a-1d3b5aa3f4fe"
!define SD_ELECTRON_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${SD_ELECTRON_GUID}"
!define SD_ELECTRON_INSTALL_KEY "Software\${SD_ELECTRON_GUID}"

;  Plain string helpers, so the hooks don't depend on which NSIS headers the
;  Tauri template includes.
;  SdFirstQuoted: $R1 '"C:\x\u.exe" /a' -> $R3 'C:\x\u.exe' (or $R1 unchanged).
Function SdFirstQuoted
  StrCpy $R3 $R1 1
  ${If} $R3 != '"'
    StrCpy $R3 $R1
    Return
  ${EndIf}
  StrCpy $R4 1
  ${Do}
    StrCpy $R5 $R1 1 $R4
    ${If} $R5 == '"'
    ${OrIf} $R5 == ""
      ${Break}
    ${EndIf}
    IntOp $R4 $R4 + 1
  ${Loop}
  IntOp $R4 $R4 - 1
  StrCpy $R3 $R1 $R4 1
FunctionEnd

;  SdParent: $R3 'C:\x\u.exe' -> $R2 'C:\x'.
Function SdParent
  StrLen $R4 $R3
  ${Do}
    IntOp $R4 $R4 - 1
    ${If} $R4 < 0
      StrCpy $R2 ""
      Return
    ${EndIf}
    StrCpy $R5 $R3 1 $R4
    ${If} $R5 == "\"
      ${Break}
    ${EndIf}
  ${Loop}
  StrCpy $R2 $R3 $R4
FunctionEnd

!macro SD_REMOVE_ELECTRON ROOT FLAG
  ClearErrors
  ReadRegStr $R1 ${ROOT} "${SD_ELECTRON_UNINSTALL_KEY}" "UninstallString"
  ${If} $R1 != ""
    Call SdFirstQuoted
    ReadRegStr $R2 ${ROOT} "${SD_ELECTRON_INSTALL_KEY}" "InstallLocation"
    ${If} $R2 == ""
      Call SdParent
    ${EndIf}
    ${If} ${FileExists} "$R3"
    ${AndIf} $R2 != ""
      DetailPrint "Removing the previous (Electron) Sentry Drive from $R2"
      ; Run a copy so the uninstaller can delete its own folder, and wait for
      ; it with _?= (otherwise NSIS uninstallers return immediately).
      InitPluginsDir
      CopyFiles /SILENT "$R3" "$PLUGINSDIR\sd-old-uninstaller.exe"
      ExecWait '"$PLUGINSDIR\sd-old-uninstaller.exe" /S /KEEP_APP_DATA ${FLAG} --updated _?=$R2' $R5
      Delete "$PLUGINSDIR\sd-old-uninstaller.exe"
      ; With _?= the uninstaller leaves itself behind.
      Delete "$R3"
      RMDir "$R2"
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro SD_REMOVE_ELECTRON HKCU "/currentuser"
  !insertmacro SD_REMOVE_ELECTRON HKLM "/allusers"
!macroend
