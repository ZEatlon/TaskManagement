!include FileFunc.nsh
!include nsDialogs.nsh

; ────────────────────────────────────────────────────────────────────────────
; TaskPilot 自定义 NSIS 安装钩子
;
; 目标：当用户已经装过 TaskPilot，再次运行安装包时给一个明显区分于「全新安装」
; 的体验：
;   1. 第一页直接显示「检测到已安装的 TaskPilot，位置：<path>，将就地更新」
;   2. 跳过安装目录选择页（自动用旧路径）
;   3. 跳过 per-user / per-machine 选择页（沿用旧安装的模式）
;   4. 保留安装进度页 + 完成页
;
; 检测逻辑：读 HKCU\Software\com.taskpilot.app\InstallLocation
;           → HKLM\…\InstallLocation
;           → HKCU/HKLM\…\Uninstall\TaskPilot\InstallLocation
; 每个候选都用 FileExists + <APP_EXECUTABLE_FILENAME> 双重校验，防止脏注册表
; 项把 $INSTDIR 写到不存在的路径。
;
; Hook 点：
;   customInit         —— 在 installer.nsi `.onInit` 末尾，initMultiUser 之后
;                          跑，主动探测并把 $INSTDIR 改成旧路径
;   customWelcomePage  —— 取代默认的安装首页；用 nsDialogs 显示更新检测结果
;   customInstallMode  —— 强制使用探测到的 installMode，跳过模式选择页
;
; 静默升级（electron-updater 通过 /S 触发）不走任何 page，但 $INSTDIR 在
; installSection.nsh 之前已被 customInit 改写，所以同样写到旧位置。
; ────────────────────────────────────────────────────────────────────────────

; 探测到的历史安装路径；空字符串 = 全新安装
; 只在安装器脚本里声明变量 —— 卸载器脚本（NSIS 第二次编译）不会调用
; customInit 也不会插入 customWelcomePage，这些 var 会被 NSIS 警告
; 「not referenced or never set」并被 electron-builder 当作错误。
!ifndef BUILD_UNINSTALLER
Var detectedPrevInstallPath
Var detectedPrevInstallMode
; 欢迎页变量（NSIS 风格：声明同名 .Sub 即可访问 $parent.Sub，无需单独声明父 var）
Var welcomePage.Dialog
Var welcomePage.Header
Var welcomePage.SubHeader
Var welcomePage.Body
!endif

!macro customInit
  ; 卸载器不需要探测旧安装路径 —— 整个宏体用条件编译跳过
  !ifndef BUILD_UNINSTALLER
  ; initMultiUser 已经基于注册表选过一次 $INSTDIR，但 ELSE 分支（同时存在
  ; 双份残留或都不存在）会丢失历史位置。我们再独立探测一次。
  StrCpy $detectedPrevInstallPath ""
  StrCpy $detectedPrevInstallMode ""

  ; 优先 HKCU —— 当前用户上下文里最相关的安装
  ReadRegStr $R0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $R0 != ""
    ${If} ${FileExists} "$R0\${APP_EXECUTABLE_FILENAME}"
      StrCpy $detectedPrevInstallPath $R0
      StrCpy $detectedPrevInstallMode "CurrentUser"
    ${EndIf}
  ${EndIf}

  ; 没有 HKCU 候选再回退 HKLM
  ${If} $detectedPrevInstallPath == ""
    ReadRegStr $R0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${If} $R0 != ""
      ${If} ${FileExists} "$R0\${APP_EXECUTABLE_FILENAME}"
        StrCpy $detectedPrevInstallPath $R0
        StrCpy $detectedPrevInstallMode "all"
      ${EndIf}
    ${EndIf}
  ${EndIf}

  ; 兜底：uninstall registry key
  ${If} $detectedPrevInstallPath == ""
    ReadRegStr $R0 HKLM "${UNINSTALL_REGISTRY_KEY}" InstallLocation
    ${If} $R0 == ""
      ReadRegStr $R0 HKCU "${UNINSTALL_REGISTRY_KEY}" InstallLocation
    ${EndIf}
    ${If} $R0 != ""
      ${If} ${FileExists} "$R0\${APP_EXECUTABLE_FILENAME}"
        StrCpy $detectedPrevInstallPath $R0
        ; 这里无法判断模式，留空；multiUser 流程仍会正确处理
      ${EndIf}
    ${EndIf}
  ${EndIf}

  ${If} $detectedPrevInstallPath != ""
    ; MUI_PAGE_DIRECTORY 用 $INSTDIR 作为 dir 页初始值；silent 升级直接
    ; 用 $INSTDIR 作为安装目录。改写它，下游所有路径都跟着走。
    StrCpy $INSTDIR $detectedPrevInstallPath

    ; 跟 assistedInstaller.nsh 的 instFilesPre 行为保持一致：如果 $INSTDIR
    ; 末尾已经包含 APP_FILENAME，就不追加；否则补一个。但这里我们已经在
    ; 探测时验证了 $R0\<APP_EXECUTABLE_FILENAME> 存在，也就是说探测到的
    ; 根目录就是 exe 所在目录，无需追加。
  ${EndIf}
  !endif
!macroend

; ────────────────────────────────────────────────────────────────────────────
; 强制 installMode：检测到旧安装时跳过 per-user / per-machine 选择页。
;
; 模板里 PAGE_INSTALL_MODE 的 Pre 函数会先检查 `customInstallMode` 宏是否
; 存在，存在则按它的判断决定是否走 Abort 路径。
;
; 我们这里：如果探测到旧安装并且模式已知，调用对应宏直接 setInstallMode*
; 然后 Abort，让模式选择页直接跳过；否则什么都不做，按正常流程显示选择页。
; ────────────────────────────────────────────────────────────────────────────
!macro customInstallMode
  ; 卸载器脚本不会调用本宏，但 NSIS 仍会展开宏体（如果 !ifmacrodef 命中）
  ; —— 用 !ifndef 包起来避免引用未声明的变量
  !ifndef BUILD_UNINSTALLER
    ${If} $detectedPrevInstallPath != ""
    ${AndIf} $detectedPrevInstallMode == "CurrentUser"
      StrCpy $isForceCurrentInstall "1"
    ${EndIf}
    ${If} $detectedPrevInstallPath != ""
    ${AndIf} $detectedPrevInstallMode == "all"
      StrCpy $isForceMachineInstall "1"
    ${EndIf}
  !endif
!macroend

; ────────────────────────────────────────────────────────────────────────────
; 跳过安装目录选择页（不通过 MUI_PAGE_CUSTOMFUNCTION_PRE）
;
; 说明：尝试过在 assistedInstaller.nsh 之前 `!define MUI_PAGE_CUSTOMFUNCTION_PRE
; skipDirPageIfUpdated`，但模板的 `!insertmacro skipPageIfUpdated` 在
; `!insertmacro MUI_PAGE_DIRECTORY` 之前又把它重写成 `skipPageIfUpdated_${UniqueID}`，
; 我们的 define 被覆盖。NSIS 不提供「在两个模板调用之间插桩」的 hook。
;
; 折中：让目录选择页保留，customInit 已经把 $INSTDIR 改成探测到的旧路径，
; 页打开时默认就是这个路径，用户看一眼直接点下一步即可。customWelcomePage
; 已经把「检测到旧安装」讲清楚了，目录页是给用户一个「确认 / 改路径」
; 的最后机会。
; ────────────────────────────────────────────────────────────────────────────

; ────────────────────────────────────────────────────────────────────────────
; 自定义首页：基于 nsDialogs，根据 detectedPrevInstallPath 显示不同内容。
;
; 模板用 `!ifmacrodef customWelcomePage / !insertmacro customWelcomePage`
; 把这个宏的内容插在 PAGE_INSTALL_MODE 之前；这里我们直接定义一个 PageEx
; 替换默认的欢迎页。
;
; 注意：变量声明必须在文件顶层（不是宏内），否则 Function body 里 Pop 引用
; 这些变量时 NSIS 在解析阶段就会报「变量未声明」。
; ────────────────────────────────────────────────────────────────────────────

!macro customWelcomePage
  !ifndef BUILD_UNINSTALLER
    PageEx custom
      PageCallbacks welcomePage.Pre welcomePage.Leave
    PageExEnd
  !endif
!macroend

; 函数体必须包在 !ifndef BUILD_UNINSTALLER 里 —— 卸载器脚本不会插入
; customWelcomePage 宏（模板里是 `!ifndef BUILD_UNINSTALLER ... !insertmacro`），
; 如果函数体无条件定义，NSIS 在编卸载器时会告警「function not referenced」
; 且 electron-builder 把告警视为错误。
!ifndef BUILD_UNINSTALLER

Function welcomePage.Pre
  nsDialogs::Create 1018
  Pop $welcomePage.Dialog

  ${If} $detectedPrevInstallPath != ""
    ; 检测到旧安装：标题、副标题、正文全部改成「更新」语义
    ${NSD_CreateLabel} 0u 0u 100% 16u "TaskPilot 更新"
    Pop $welcomePage.Header

    ${NSD_CreateLabel} 0u 22u 100% 14u "正在更新已安装的 TaskPilot"
    Pop $welcomePage.SubHeader

    ${NSD_CreateLabel} 0u 50u 100% 80u "检测到已安装的 TaskPilot。$\r$\n$\r$\n安装位置：$\r$\n$detectedPrevInstallPath$\r$\n$\r$\n安装程序将就地覆盖更新该位置的 TaskPilot。$\r$\n$\r$\n点击「下一步」继续，或点击「取消」退出。"
    Pop $welcomePage.Body
  ${Else}
    ; 全新安装
    ${NSD_CreateLabel} 0u 0u 100% 16u "TaskPilot 安装"
    Pop $welcomePage.Header

    ${NSD_CreateLabel} 0u 22u 100% 14u "欢迎使用 TaskPilot"
    Pop $welcomePage.SubHeader

    ${NSD_CreateLabel} 0u 50u 100% 80u "该向导将引导您完成 TaskPilot 的安装。$\r$\n$\r$\n点击「下一步」继续。"
    Pop $welcomePage.Body
  ${EndIf}

  nsDialogs::Show
FunctionEnd

Function welcomePage.Leave
  ; 直接放行，让流程进入 install mode 页面（如果还存在的话）
FunctionEnd

!endif