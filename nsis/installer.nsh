; Wired via electron-builder.yml `nsis.include: nsis/installer.nsh`. This
; lives in a tracked dir (the eb-default `build/` is .gitignored). The
; `customHeader` macro is inserted at NSIS attribute scope (app-builder-lib
; templates/nsis/installer.nsi:38-40).
;
; Why CRCCheck off:
; We cross-build the Windows target on macOS WITHOUT wine. electron-builder
; generates the uninstaller by executing the just-built Windows installer
; stub to emit `Uninstall ….exe` — a Windows PE that cannot run on macOS
; without wine. The fallback ships an uninstaller whose embedded NSIS CRC
; does not match its bytes, so launching uninstall.exe on Windows fails
; immediately with "NSIS Error — Installer integrity check has failed" (the
; installer itself installs fine). Compiling the stubs with CRCCheck off
; makes the launch-time self-integrity check a no-op so the uninstaller runs.
;
; Trade-off: installer/uninstaller no longer self-detect corruption or
; tampering. Acceptable — the app is unsigned and per-user (SmartScreen
; already warns). Proper alternative: install wine on the build host
; (see docs/build-windows.md).
!macro customHeader
  CRCCheck off
!macroend
