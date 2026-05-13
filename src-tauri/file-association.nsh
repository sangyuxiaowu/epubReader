!macro NSIS_HOOK_POSTINSTALL
  SetOutPath "$INSTDIR"
  File "/oname=epub-file.ico" "${__FILEDIR__}\..\..\..\..\icons\file\icon.ico"
  WriteRegStr HKCU "Software\Classes\epub-reader.epub\DefaultIcon" "" "$INSTDIR\epub-file.ico,0"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$INSTDIR\epub-file.ico"
  DeleteRegKey HKCU "Software\Classes\epub-reader.epub\DefaultIcon"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend