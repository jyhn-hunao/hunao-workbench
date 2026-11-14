# blender-embed-agent.ps1 —— 把 Blender 主窗口「贴」进工作台面板（创意工坊）
#
# ⚠ 本文件必须以 **UTF-8 带 BOM** 保存：Windows PowerShell 5.1 读无 BOM 文件按 ANSI 解，中文注释会把语法读坏
#   （2026-11-13 实测：无 BOM 时 PS 5.1 直接 ParserError，主进程只能报 agent-unavailable）。
#
# 为什么要单独一个代理进程：改窗口归属 / 摆位是 Win32 的活，放主进程里一旦卡住就是整个界面卡住。
# 协议（文件通道，跟 main.js 的 blenderEmbedCommand 对应）：
#   命令：$Cmd 文件里一行 JSON {cmd, seq, ...}；结果：$Res 文件里 {seq, ok, ...}
#   cmd = embed   {parent:<十进制句柄>, x, y, w, h}   → 把 Blender 主窗口的 owner 设成面板所在窗口，并摆到屏幕矩形
#   cmd = move    {x, y, w, h}                        → 只挪位置（面板拖动/缩放时高频调用）
#   cmd = release                                    → 还原 owner 与原始位置（面板切走 / 关闭 Blender 前）
#   cmd = status                                     → 报 found / embedded / rect
#   cmd = quit                                       → 还原后退出（工作台退出时用）
#
# 三条纪律：
#   ① **不用 SetParent**（子窗口会随父窗口一起被系统销毁，壳崩了会把 Blender 带走）——只设 owner + 去边框 + 摆位；
#      去边框 = 摘掉 WS_CAPTION/WS_THICKFRAME/WS_SYSMENU/WS_*BOX，加 WS_POPUP；exstyle 加 WS_EX_TOOLWINDOW（不进任务栏/alt-tab）。
#      这样窗口铺满面板矩形后看起来就是面板内容，也不会盖住旁边面板；退出/释放时样式与矩形整套还原。
#   ② 任何退出路径（quit / 父进程消失）都必须先把 Blender 还回桌面、还原原始矩形；
#   ③ 结果文件落盘用「临时文件 + 改名」，避免主进程读到半截 JSON。
#
# 用法（由 main.js 拉起，一般不用手跑）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File blender-embed-agent.ps1 `
#     -Cmd data\blender-embed.cmd.json -Res data\blender-embed.res.json -ParentPid <GUI 进程号> [-Proc blender]

param(
  [Parameter(Mandatory = $true)][string]$Cmd,
  [Parameter(Mandatory = $true)][string]$Res,
  [Parameter(Mandatory = $true)][int]$ParentPid,
  [string]$Proc = 'blender'
)

$ErrorActionPreference = 'Stop'

Add-Type -Namespace DshBlender -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
[DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowW(string lpClassName, string lpWindowName);
[DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint = "FindWindowW")] public static extern IntPtr FindWindowWPtr(string lpClassName, IntPtr lpWindowName);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, System.Text.StringBuilder sb, int max);
public delegate bool EnumProc(IntPtr h, IntPtr p);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
[DllImport("user32.dll")] public static extern IntPtr SetParent(IntPtr hWndChild, IntPtr hWndNewParent);
[DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT lpPoint);
[DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT lpRect);
[DllImport("user32.dll")] public static extern int SetWindowRgn(IntPtr hWnd, IntPtr hRgn, bool bRedraw);
[DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int x1, int y1, int x2, int y2);
public struct POINT { public int X; public int Y; }
[DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr64(IntPtr hWnd, int nIndex);
[DllImport("user32.dll", EntryPoint = "GetWindowLongW")] static extern int GetWindowLong32(IntPtr hWnd, int nIndex);
[DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] static extern IntPtr SetWindowLongPtr64(IntPtr hWnd, int nIndex, IntPtr dwNewLong);
[DllImport("user32.dll", EntryPoint = "SetWindowLongW")] static extern int SetWindowLong32(IntPtr hWnd, int nIndex, int dwNewLong);
public static IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex) {
  if (IntPtr.Size == 8) return GetWindowLongPtr64(hWnd, nIndex);
  return new IntPtr(GetWindowLong32(hWnd, nIndex));
}
public static IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong) {
  if (IntPtr.Size == 8) return SetWindowLongPtr64(hWnd, nIndex, dwNewLong);
  return new IntPtr(SetWindowLong32(hWnd, nIndex, dwNewLong.ToInt32()));
}
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
'@

# ★ 2026-11-13：本进程默认是 DPI 不感知的 —— 这时 SetWindowPos 收的是"逻辑像素"，
#   Windows 会按系统缩放（本机 125%）再乘一次，导致内置窗口比面板大 25%、右下越界。
#   先把本进程声明成 PER_MONITOR_AWARE_V2（Win10 1703+；失败退回系统级 DPI 感知），
#   坐标才是真物理像素，和主进程 toScreenPhysicalRect 换出来的矩形一致。
$dpiOk = $false
try { $dpiOk = [DshBlender.Win]::SetProcessDpiAwarenessContext([IntPtr]::new(-4)) } catch { $dpiOk = $false }
if (-not $dpiOk) { try { $dpiOk = [DshBlender.Win]::SetProcessDPIAware() } catch { $dpiOk = $false } }

$GWL_HWNDPARENT = -8
$GWL_STYLE = -16
$GWL_EXSTYLE = -20
$WS_CAPTION = 0x00C00000
$WS_THICKFRAME = 0x00040000
$WS_SYSMENU = 0x00080000
$WS_MINIMIZEBOX = 0x00020000
$WS_MAXIMIZEBOX = 0x00010000
$WS_CHILD = 1073741824        # 0x40000000（写十进制，避免 PowerShell 把 0x80000000 解析成负的 int32）
$WS_POPUP = 2147483648        # 0x80000000
$WS_VISIBLE = 268435456       # 0x10000000
$WS_EX_TOOLWINDOW = 0x00000080
$WS_EX_APPWINDOW = 0x00040000
$SWP_NOACTIVATE = 0x0010
$SWP_SHOWWINDOW = 0x0040
$SWP_NOZORDER = 0x0004
$SWP_FRAMECHANGED = 0x0020
$FLAGS = $SWP_NOACTIVATE -bor $SWP_SHOWWINDOW -bor $SWP_NOZORDER
$FLAGS_FRAME = $FLAGS -bor $SWP_FRAMECHANGED
$UTF8 = New-Object System.Text.UTF8Encoding($false)

$state = @{
  Hwnd = [IntPtr]::Zero
  Owner0 = [IntPtr]::Zero
  Rect0 = $null
  Style0 = 0
  Ex0 = 0
  FrameStripped = $false
  Embedded = $false
  Parent = [IntPtr]::Zero   # 壳窗口句柄：Blender 换窗口/重建样式后要重新认父
  Mode = 'owner'            # owner = 无边框顶层窗贴合（稳）；child = SetParent 真子窗（跟着面板裁剪）
  Target = $null      # 目标矩形：内置期间每拍比对，被 Blender 自己改掉就拉回
}
$lastSeq = -1

function Write-Result([int]$seq, [bool]$ok, [string]$err, [hashtable]$extra) {
  $obj = [ordered]@{ seq = $seq; ok = $ok }
  if ($err) { $obj.err = $err }
  if ($extra) { foreach ($k in $extra.Keys) { $obj[$k] = $extra[$k] } }
  $txt = ($obj | ConvertTo-Json -Compress -Depth 6)
  for ($i = 0; $i -lt 4; $i++) {
    try {
      $tmp = "$Res.tmp"
      [System.IO.File]::WriteAllText($tmp, $txt, $UTF8)
      Move-Item -LiteralPath $tmp -Destination $Res -Force
      return
    } catch {
      Start-Sleep -Milliseconds 60
    }
  }
  try { [System.IO.File]::WriteAllText($Res, $txt, $UTF8) } catch { }
}

# ★ 2026-11-13：Blender 的 MainWindowHandle 会是 0（GHOST 窗口不算"主窗口"），
#   所以按窗口类名找：Blender 主窗口类固定为 GHOST_WindowClass；找不到再退回 MainWindowHandle。
# ⚠ 2026-11-13 真机坑：FindWindowW 的第二个参数不能写 $null —— PowerShell 会把 $null 转成空串 ""，
#   等于要求"标题为空"，只能匹配到 Blender 还没打开文件时的无标题窗口；一旦标题变成 "xxx.blend - Blender"，
#   FindWindowW 永远返回 0 ⇒ embed 报 window-not-found、钉住拿旧句柄也纠不了偏。
#   必须传 [NullString]::Value（真 NULL）；并且加一条"按 pid 枚举 + 类名比对"的兜底。
function Find-Target {
  $pids = @()
  try { $pids = @(Get-Process -Name $Proc -ErrorAction Stop | ForEach-Object { $_.Id }) } catch { return [IntPtr]::Zero }
  if ($pids.Count -eq 0) { return [IntPtr]::Zero }

  # 1. 手里的句柄还活着、且仍属于 blender 进程 → 直接复用（避免每拍重找）
  if ($state.Hwnd -ne [IntPtr]::Zero -and [DshBlender.Win]::IsWindow($state.Hwnd)) {
    $pid0 = 0
    [void][DshBlender.Win]::GetWindowThreadProcessId($state.Hwnd, [ref]$pid0)
    if ($pids -contains $pid0) { return $state.Hwnd }
  }

  # 2. FindWindowW：标题必须传真 NULL —— 走 IntPtr 重载；传 $null / [NullString]::Value 都会被 PowerShell 转成空串，
  #    等于"标题为空"，Blender 打开文件后就再也匹配不上
  $h = [DshBlender.Win]::FindWindowWPtr("GHOST_WindowClass", [IntPtr]::Zero)
  if ($h -ne [IntPtr]::Zero) {
    $pid2 = 0
    [void][DshBlender.Win]::GetWindowThreadProcessId($h, [ref]$pid2)
    if ($pids -contains $pid2) { return $h }
  }

  # 3. 兜底：枚举顶层窗口，挑"类名 GHOST_WindowClass 且 pid 是 blender"的那个
  $script:EnumHit = [IntPtr]::Zero
  $script:EnumPids = $pids
  $cb = [DshBlender.Win+EnumProc]{
    param($wh, $p)
    $sb = New-Object System.Text.StringBuilder 256
    [void][DshBlender.Win]::GetClassNameW($wh, $sb, 256)
    if ($sb.ToString() -eq "GHOST_WindowClass") {
      $pp = 0
      [void][DshBlender.Win]::GetWindowThreadProcessId($wh, [ref]$pp)
      if ($script:EnumPids -contains $pp) { $script:EnumHit = $wh; return $false }
    }
    return $true
  }
  [void][DshBlender.Win]::EnumWindows($cb, [IntPtr]::Zero)
  if ($script:EnumHit -ne [IntPtr]::Zero) { return $script:EnumHit }

  # 4. 最后兜底：MainWindowHandle（Blender 通常为 0，聊胜于无）
  foreach ($id in $pids) {
    try {
      $proc = Get-Process -Id $id -ErrorAction Stop
      $cand = $proc.MainWindowHandle
      if ($cand -ne [IntPtr]::Zero) { return [IntPtr]$cand }
    } catch { }
  }
  return [IntPtr]::Zero
}

function Resolve-Target {
  param([int]$Tries = 30)
  if ($state.Hwnd -ne [IntPtr]::Zero -and [DshBlender.Win]::IsWindow($state.Hwnd)) { return $true }
  for ($i = 0; $i -lt $Tries; $i++) {
    $h = Find-Target
    if ($h -ne [IntPtr]::Zero -and $h -ne $state.Hwnd) {
      $state.Hwnd = $h
      $state.Owner0 = [DshBlender.Win]::GetWindowLongPtr($h, $GWL_HWNDPARENT)
      $state.FrameStripped = $false
      $state.Rect0 = $null
      return $true
    }
    if ($Tries -le 1) { break }
    Start-Sleep -Milliseconds 200
  }
  return $false
}

function Save-OriginalRect {
  if ($state.Hwnd -eq [IntPtr]::Zero) { return }
  if ($state.Rect0) { return }
  $r = New-Object DshBlender.Win+RECT
  if ([DshBlender.Win]::GetWindowRect($state.Hwnd, [ref]$r)) {
    $state.Rect0 = @{
      x = [int]$r.Left; y = [int]$r.Top
      w = ([int]$r.Right - [int]$r.Left); h = ([int]$r.Bottom - [int]$r.Top)
    }
  }
}

function Do-Release {
  if ($state.Hwnd -eq [IntPtr]::Zero) { $state.Embedded = $false; $state.Mode = 'owner'; return }
  if (-not [DshBlender.Win]::IsWindow($state.Hwnd)) {
    $state.Hwnd = [IntPtr]::Zero; $state.Embedded = $false; $state.Mode = 'owner'; return
  }
  # 真子窗：先还原样式（去掉 WS_CHILD），再脱离父窗口，最后按原矩形摆回屏幕
  if ($state.Mode -eq 'child') {
    Restore-Frame
    try { [void][DshBlender.Win]::SetParent($state.Hwnd, [IntPtr]::Zero) } catch { }
  } else {
    if ($state.Mode -eq 'clip') { try { [void][DshBlender.Win]::SetWindowRgn($state.Hwnd, [IntPtr]::Zero, $true) } catch { } }
    Restore-Frame
    try { [void][DshBlender.Win]::SetWindowLongPtr($state.Hwnd, $GWL_HWNDPARENT, $state.Owner0) } catch { }
  }
  if ($state.Rect0) {
    try {
      [void][DshBlender.Win]::SetWindowPos($state.Hwnd, [IntPtr]::Zero,
        $state.Rect0.x, $state.Rect0.y, $state.Rect0.w, $state.Rect0.h, $FLAGS_FRAME)
    } catch { }
  }
  $state.Rect0 = $null
  $state.Embedded = $false
  $state.Mode = 'owner'
  $state.Target = $null
}

# 去边框：让 Blender 窗口变成「无标题栏的弹出窗」——铺满面板矩形后就是面板内容，也不会盖住旁边面板
# 原始样式全存进 state，release / quit 时整套还原（Blender 单独用时还是正常的带框窗口）
function Save-Frame {
  param([bool]$child = $false)
  if ($state.Hwnd -eq [IntPtr]::Zero) { return }
  if ($state.FrameStripped) { return }
  $st = [DshBlender.Win]::GetWindowLongPtr($state.Hwnd, $GWL_STYLE).ToInt64()
  $ex = [DshBlender.Win]::GetWindowLongPtr($state.Hwnd, $GWL_EXSTYLE).ToInt64()
  $state.Style0 = $st
  $state.Ex0 = $ex
  $mask = -bnot ([int64]$WS_CAPTION -bor [int64]$WS_THICKFRAME -bor [int64]$WS_SYSMENU -bor [int64]$WS_MINIMIZEBOX -bor [int64]$WS_MAXIMIZEBOX)
  if ($child) {
    # 真子窗：去掉 WS_POPUP、加 WS_CHILD|WS_VISIBLE，子窗坐标相对父窗口客户区
    $new = ((($st -band $mask) -band (-bnot [int64]$WS_POPUP)) -bor [int64]$WS_CHILD -bor [int64]$WS_VISIBLE)
  } else {
    $new = ((($st -band $mask) -band (-bnot $WS_CHILD)) -bor $WS_POPUP)
  }
  [void][DshBlender.Win]::SetWindowLongPtr($state.Hwnd, $GWL_STYLE, [IntPtr]$new)
  $newEx = (($ex -band (-bnot $WS_EX_APPWINDOW)) -bor $WS_EX_TOOLWINDOW)
  [void][DshBlender.Win]::SetWindowLongPtr($state.Hwnd, $GWL_EXSTYLE, [IntPtr]$newEx)
  $state.FrameStripped = $true
}

function Restore-Frame {
  if (-not $state.FrameStripped) { return }
  if ($state.Hwnd -ne [IntPtr]::Zero -and [DshBlender.Win]::IsWindow($state.Hwnd)) {
    [void][DshBlender.Win]::SetWindowLongPtr($state.Hwnd, $GWL_STYLE, [IntPtr]$state.Style0)
    [void][DshBlender.Win]::SetWindowLongPtr($state.Hwnd, $GWL_EXSTYLE, [IntPtr]$state.Ex0)
  }
  $state.FrameStripped = $false
}

# Blender 切换工作区/全屏时会自己重建窗口样式：每拍顺手补一次，否则标题栏会突然回来
function Assert-Frames {
  if (-not $state.FrameStripped) { return }
  if ($state.Hwnd -eq [IntPtr]::Zero -or -not [DshBlender.Win]::IsWindow($state.Hwnd)) { return }
  $st = [DshBlender.Win]::GetWindowLongPtr($state.Hwnd, $GWL_STYLE).ToInt64()
  if (($st -band $WS_CAPTION) -ne 0) { $state.FrameStripped = $false; Save-Frame ([bool]($state.Mode -eq 'child')) }
}

# Blender 换窗口（打开文件/切工作区会重建窗口）后，owner 会丢 —— 每拍补一次，跟着壳一起动
function Assert-Owner {
  if ($state.Parent -eq [IntPtr]::Zero) { return $true }
  if ($state.Hwnd -eq [IntPtr]::Zero -or -not [DshBlender.Win]::IsWindow($state.Hwnd)) { return $false }
  $cur = [DshBlender.Win]::GetWindowLongPtr($state.Hwnd, $GWL_HWNDPARENT)
  if ($cur -ne $state.Parent) {
    $old = [DshBlender.Win]::SetWindowLongPtr($state.Hwnd, $GWL_HWNDPARENT, $state.Parent)
    if ($state.Owner0 -eq [IntPtr]::Zero) { $state.Owner0 = $old }
  }
  return $true
}
# Blender 换窗口（打开文件/切工作区会重建窗口）后，owner / 父窗口会丢 —— 每拍补一次，跟着壳一起动
function Assert-Owner {
  if ($state.Parent -eq [IntPtr]::Zero) { return $true }
  if ($state.Hwnd -eq [IntPtr]::Zero -or -not [DshBlender.Win]::IsWindow($state.Hwnd)) { return $false }
  if ($state.Mode -eq 'child') {
    if ([DshBlender.Win]::GetParent($state.Hwnd) -ne $state.Parent) {
      [void][DshBlender.Win]::SetParent($state.Hwnd, $state.Parent)
    }
    return $true
  }
  $cur = [DshBlender.Win]::GetWindowLongPtr($state.Hwnd, $GWL_HWNDPARENT)
  if ($cur -ne $state.Parent) {
    $old = [DshBlender.Win]::SetWindowLongPtr($state.Hwnd, $GWL_HWNDPARENT, $state.Parent)
    if ($state.Owner0 -eq [IntPtr]::Zero) { $state.Owner0 = $old }
  }
  return $true
}

# 摆到 state.Target：真子窗的坐标是「父窗口客户区左上角」为原点，得先把屏幕坐标换算过去
function Move-ToTarget {
  if ($state.Hwnd -eq [IntPtr]::Zero -or -not $state.Target) { return }
  if ($state.Mode -eq 'child' -and $state.Parent -ne [IntPtr]::Zero) {
    $pt = New-Object DshBlender.Win+POINT
    $pt.X = 0; $pt.Y = 0
    if (-not [DshBlender.Win]::ClientToScreen($state.Parent, [ref]$pt)) { return }
    [void][DshBlender.Win]::SetWindowPos($state.Hwnd, [IntPtr]::Zero,
      ($state.Target.x - $pt.X), ($state.Target.y - $pt.Y),
      $state.Target.w, $state.Target.h, $FLAGS_FRAME)
    return
  }
  [void][DshBlender.Win]::SetWindowPos($state.Hwnd, [IntPtr]::Zero,
    $state.Target.x, $state.Target.y, $state.Target.w, $state.Target.h, $FLAGS_FRAME)
}

# 裁剪模式：窗口仍是顶层窗（不会像子窗那样被壳连带销毁），但用 SetWindowRgn 把可见区域
# 限制在目标矩形内 —— 窗口万一被 Blender 自己撑大，多出来的部分根本不画，绝不越界。
function Apply-Clip {
  if ($state.Mode -ne 'clip') { return }
  if ($state.Hwnd -eq [IntPtr]::Zero -or -not $state.Target) { return }
  if (-not [DshBlender.Win]::IsWindow($state.Hwnd)) { return }
  $rg = New-Object DshBlender.Win+RECT
  if (-not [DshBlender.Win]::GetWindowRect($state.Hwnd, [ref]$rg)) { return }
  $ix = [Math]::Max([int]$state.Target.x, [int]$rg.Left)
  $iy = [Math]::Max([int]$state.Target.y, [int]$rg.Top)
  $ix2 = [Math]::Min([int]$state.Target.x + [int]$state.Target.w, [int]$rg.Right)
  $iy2 = [Math]::Min([int]$state.Target.y + [int]$state.Target.h, [int]$rg.Bottom)
  $w2 = $ix2 - $ix
  $h2 = $iy2 - $iy
  if ($w2 -le 0 -or $h2 -le 0) { return }
  # 区域坐标是「窗口自己的坐标系」，不是屏幕坐标
  $hr = [DshBlender.Win]::CreateRectRgn(($ix - [int]$rg.Left), ($iy - [int]$rg.Top),
    ($ix - [int]$rg.Left + $w2), ($iy - [int]$rg.Top + $h2))
  [void][DshBlender.Win]::SetWindowRgn($state.Hwnd, $hr, $true)   # 句柄交给系统，别再 DeleteObject
}

function Do-Embed($parent, $x, $y, $w, $h, $mode) {  if (-not (Resolve-Target)) { return @{ ok = $false; err = "window-not-found（进程 $Proc 没有可用窗口）" } }
  if ([string]::IsNullOrWhiteSpace($parent) -or [int64]$parent -eq 0) {
    # 没给父窗口（自测场景）：只摆位，不设 owner
    Save-OriginalRect
    [void][DshBlender.Win]::SetWindowPos($state.Hwnd, [IntPtr]::Zero, $x, $y, $w, $h, $FLAGS)
    $state.Embedded = $true
    $state.Mode = 'owner'
    $state.Target = @{ x = [int]$x; y = [int]$y; w = [int]$w; h = [int]$h }
    return @{ ok = $true; parent = 0; hwnd = [int64]$state.Hwnd; mode = 'owner' }
  }
  $p = [IntPtr][int64]$parent
  $state.Parent = $p

  # ★ 真嵌入：SetParent + WS_CHILD —— 子窗被父窗口裁掉，绝不越界到别的面板
  #   失败（SetParent 没生效）就地回滚样式，退回覆盖式，不会把窗口留在半残状态
  if ($mode -eq 'child') {
    if ($state.FrameStripped) { Restore-Frame }   # 先回到原始样式，再按子窗样式重做一遍
    Save-OriginalRect
    Save-Frame $true
    [void][DshBlender.Win]::SetParent($state.Hwnd, $p)
    if ([DshBlender.Win]::GetParent($state.Hwnd) -eq $p) {
      $state.Mode = 'child'
      $state.Embedded = $true
      $state.Target = @{ x = [int]$x; y = [int]$y; w = [int]$w; h = [int]$h }
      [void][DshBlender.Win]::ShowWindow($state.Hwnd, 9)
      Move-ToTarget
      return @{ ok = $true; parent = [int64]$p; hwnd = [int64]$state.Hwnd; mode = 'child' }
    }
    Restore-Frame
  }

  $state.Mode = $(if ($mode -eq 'clip') { 'clip' } else { 'owner' })
  $old = [DshBlender.Win]::SetWindowLongPtr($state.Hwnd, $GWL_HWNDPARENT, $p)
  if ($state.Owner0 -eq [IntPtr]::Zero) { $state.Owner0 = $old }
  Save-Frame $false
  [void][DshBlender.Win]::ShowWindow($state.Hwnd, 9)   # SW_RESTORE：窗口被压成一条/最小化时先还原
  $state.Embedded = $true
  $state.Target = @{ x = [int]$x; y = [int]$y; w = [int]$w; h = [int]$h }
  Move-ToTarget
  Apply-Clip
  return @{ ok = $true; parent = [int64]$p; hwnd = [int64]$state.Hwnd; mode = $state.Mode; fallback = [bool]($mode -eq 'child') }
}

function Get-Status {
  $found = ($state.Hwnd -ne [IntPtr]::Zero -and [DshBlender.Win]::IsWindow($state.Hwnd))
  if (-not $found) {
    # 句柄失效（Blender 重建窗口）时补一次定位，否则状态永远是 found=false
    if (Resolve-Target -Tries 1) { $found = $true; [void](Assert-Owner); Assert-Frames }
  }
  $rect = $null
  if ($found) {
    $r = New-Object DshBlender.Win+RECT
    if ([DshBlender.Win]::GetWindowRect($state.Hwnd, [ref]$r)) {
      $rect = @{ x = [int]$r.Left; y = [int]$r.Top; w = ([int]$r.Right - [int]$r.Left); h = ([int]$r.Bottom - [int]$r.Top) }
    }
  }
  return @{ found = [bool]$found; embedded = [bool]$state.Embedded; mode = [string]$state.Mode; parent = [int64]$state.Parent; hwnd = [int64]$state.Hwnd; rect = $rect; pins = [int]($state.PinHits); dpi = [bool]$dpiOk; target = $state.Target }
}

function Test-ParentAlive {
  try { $null = Get-Process -Id $ParentPid -ErrorAction Stop; return $true } catch { return $false }
}

# 主循环：40ms 看一次命令文件；父进程没了就释放并退出
while ($true) {
  if (-not (Test-ParentAlive)) { Do-Release; break }

  if (Test-Path -LiteralPath $Cmd) {
    try {
      $raw = [System.IO.File]::ReadAllText($Cmd, $UTF8)
      if ($raw -and $raw.Trim()) {
        $req = $raw | ConvertFrom-Json
        $seq = [int]$req.seq
        if ($seq -ne $lastSeq) {
          $lastSeq = $seq
          $cmdName = [string]$req.cmd
          switch ($cmdName) {
            'embed' {
              $mode = [string]$req.mode
              if (-not $mode) { $mode = 'owner' }
              $r = Do-Embed $req.parent ([int]$req.x) ([int]$req.y) ([int]$req.w) ([int]$req.h) $mode
              Write-Result $seq ([bool]$r.ok) ([string]$r.err) @{ hwnd = $r.hwnd; parent = $r.parent; mode = $r.mode; fallback = $r.fallback }
            }
            'move' {
              if (-not (Resolve-Target -Tries 1)) {
                Write-Result $seq $false 'window-not-found' @{}
              } else {
                [void](Assert-Owner)
                Assert-Frames
                $state.Target = @{ x = [int]$req.x; y = [int]$req.y; w = [int]$req.w; h = [int]$req.h }
                Move-ToTarget
                Apply-Clip
                Write-Result $seq $true '' @{}
              }
            }
            'release' {
              Do-Release
              Write-Result $seq $true '' @{}
            }
            'status' {
              $st = Get-Status
              Write-Result $seq $true '' $st
            }
            'quit' {
              Do-Release
              Write-Result $seq $true '' @{}
              exit 0
            }
            default {
              Write-Result $seq $false ("unknown-cmd: " + $cmdName) @{}
            }
          }
        }
      }
    } catch {
      # 命令文件正在被主进程重写时可能读到半截 JSON：跳过这一次，下一拍再来
    }
  }
  # ★ 2026-11-13：Blender 启动/切工作区时会按自己记住的窗口尺寸把窗口放大
  #   （实测：已内置但窗口 1310×840 浮在面板上）。内置期间每 250ms 比对目标矩形，偏离就拉回。
  #   ★ 句柄失效（Blender 重建了窗口）时先重新定位 + 重新认父，再拉回 —— 否则会"越钉越飞"。
  if ($state.Embedded -and $state.Target) {
    $now = Get-Date
    if (-not $state.NextPin -or $now -ge $state.NextPin) {
      $state.NextPin = $now.AddMilliseconds(250)
      if ($state.Hwnd -eq [IntPtr]::Zero -or -not [DshBlender.Win]::IsWindow($state.Hwnd)) {
        if (Resolve-Target -Tries 1) { $state.PinHits = [int]($state.PinHits) + 1 }
      }
      if ($state.Hwnd -ne [IntPtr]::Zero -and [DshBlender.Win]::IsWindow($state.Hwnd)) {
        [void](Assert-Owner)
        $rg = New-Object DshBlender.Win+RECT
        if ([DshBlender.Win]::GetWindowRect($state.Hwnd, [ref]$rg)) {
          $cw = [int]$rg.Right - [int]$rg.Left
          $ch = [int]$rg.Bottom - [int]$rg.Top
          $off = ([Math]::Abs($rg.Left - $state.Target.x) -gt 2) -or ([Math]::Abs($rg.Top - $state.Target.y) -gt 2) -or ([Math]::Abs($cw - $state.Target.w) -gt 2) -or ([Math]::Abs($ch - $state.Target.h) -gt 2)
          if ($off) {
            if ($state.Mode -ne 'child' -and [DshBlender.Win]::IsZoomed($state.Hwnd)) { [void][DshBlender.Win]::ShowWindow($state.Hwnd, 9) }
            Assert-Frames
            Move-ToTarget
            $state.PinHits = [int]($state.PinHits) + 1
          } else {
            Assert-Frames
          }
          Apply-Clip
        }
      }
    }
  }
  Start-Sleep -Milliseconds 40
}
