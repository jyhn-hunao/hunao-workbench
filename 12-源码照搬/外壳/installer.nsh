; 安装器附加动作：把安装器同目录的引擎包拷进安装目录，首启由外壳自动装载。
; ⛔ 不把引擎塞进安装器本体（包会从 313 MB 涨到 450 MB+）；只做“同目录随行文件”的搬运。
!macro customInstall
  CreateDirectory "$INSTDIR\引擎包"
  ; 1. 中文命名（发布产物默认） 引擎-*.tar.gz
  FindFirst $0 $1 "$EXEDIR\引擎-*.tar.gz"
  hunaoCopyEngineCn:
    StrCmp $1 "" hunaoCopyEngineCnDone
    StrCmp $EXEDIR $INSTDIR hunaoCopyEngineCnDone
    DetailPrint "发现引擎包：$1"
    CopyFiles /SILENT "$EXEDIR\$1" "$INSTDIR\引擎包"
    FindNext $0 $1
    Goto hunaoCopyEngineCn
  hunaoCopyEngineCnDone:
  FindClose $0
  ; 2. 英文命名（内部构建 / CI 产物） engine-*.tar.gz
  FindFirst $0 $1 "$EXEDIR\engine-*.tar.gz"
  hunaoCopyEngineEn:
    StrCmp $1 "" hunaoCopyEngineEnDone
    StrCmp $EXEDIR $INSTDIR hunaoCopyEngineEnDone
    DetailPrint "发现引擎包：$1"
    CopyFiles /SILENT "$EXEDIR\$1" "$INSTDIR\引擎包"
    FindNext $0 $1
    Goto hunaoCopyEngineEn
  hunaoCopyEngineEnDone:
  FindClose $0
!macroend

!macro customUnInstall
  ; 引擎包副本属于安装产物，卸载时一并清理；解包后的引擎由安装目录整体删除。
  RMDir /r "$INSTDIR\引擎包"
!macroend
