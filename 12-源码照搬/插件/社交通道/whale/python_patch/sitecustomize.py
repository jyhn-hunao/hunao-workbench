# DSH_WHALE_PATCH —— 工作台微信通道的鲸鲸兼容补丁（不要手工编辑运行时副本）
# 鲸鲸桥接的账号窗口探测补丁（工作台集成层，不改鲸鲸源码）
#
# 背景：whale_girl 4.1.7 在确认「哪个微信主窗是已选账号」时会遍历 Weixin.exe
# 的打开文件（psutil.Process.open_files）。微信 4.x 开久了句柄很多，这个调用
# 在这台机器上会卡住并占着 GIL，心跳线程因此发不出 /api/bridge/heartbeat，
# 工作台就显示「桥接离线：进程在但没心跳」。
#
# 这里只在「已选账号 + 当前只有一个可见微信主窗」时走快速路径：
#   · 给 Weixin.exe 的 open_files 返回一个指向已选账号 db_storage 的占位项，
#     让鲸鲸的账号归属判断拿到真账号目录；
#   · 没有可见主窗 / 同时开了多个主窗 / 没选账号时返回空数组，宁可让鲸鲸
#     判「账号未确认」也不乱认窗口（不碰主号，不发错号）。
#
# 注意：这是工作台侧的兼容补丁；鲸鲸升级后如果 bridge 不再调用 psutil.open_files，
# 这里的 monkeypatch 自然就失效，不需要改鲸鲸安装目录。

import os
import sys
import time

try:
    import psutil
except Exception:  # noqa: BLE001
    psutil = None

try:
    import win32gui
except Exception:  # noqa: BLE001
    win32gui = None

_ACCOUNT_DIR = str(os.environ.get('DSH_WX_ACCOUNT_DIR') or '').strip()
_ORIGINAL_OPEN_FILES = getattr(psutil.Process, 'open_files', None) if psutil else None


def _is_weixin(proc):
    try:
        return (proc.name() or '').strip().lower() in ('weixin.exe', 'wechat.exe')
    except Exception:  # noqa: BLE001
        return False


def _open_files(self):
    # 多开/虚拟桌面下不能按「当前桌面可见窗数」伪造账号归属：小号在另一个
    # 虚拟桌面时，当前桌面只看得见大号，旧逻辑会把大号进程伪装成已选小号。
    # 微信进程这里一律返回空；明确钉住的 windowHwnd 由 _install_account_match
    # 用真实 open_files 核对账号目录名，对不上就否决。
    if _ACCOUNT_DIR and _is_weixin(self):
        return []
    if _ORIGINAL_OPEN_FILES:
        return _ORIGINAL_OPEN_FILES(self)
    return []


if psutil is not None and _ORIGINAL_OPEN_FILES is not None:
    psutil.Process.open_files = _open_files


def _install_window_filter():
    """把鲸鲸的候选窗收窄成「真正的主聊天窗」。

    uia_compat 的 _wechat_hwds 会把托盘消息窗（Qt51514WxTrayIconMessageWindowClass）
    和隐藏的小辅助窗也扫进来；同一进程会出现多个候选，账号归属判断就会卡在
    「多个候选无法确认」，UIA 也拿不到主窗。这里在 uia_compat 之后加一层过滤：
      · 只留标题为「微信 / Weixin」、类名像 Qt/mmui 的顶层窗；
      · 排除托盘消息窗、关于窗和面积小于 300×250 的辅助窗；
      · 最小化的主窗用 GetWindowPlacement 的还原矩形算面积，仍然保留。
    """
    home = str(os.environ.get('DSH_WHALE_HOME') or '').strip()
    if not home:
        return
    examples = os.path.join(home, 'examples')
    for p in (home, os.path.join(home, 'vendor', 'wechatauto'), examples):
        if os.path.isdir(p) and p not in sys.path:
            sys.path.insert(0, p)
    try:
        import uia_compat
        uia_compat.apply(False)
    except Exception:  # noqa: BLE001
        return
    try:
        from wechatauto.uia_driver import WeChatUIA
        # whale_girl 4.1.7 的 examples/uia_compat.py 把 ensure_chat_page 挂到类上，
        # 但没有把同文件里的 _chat_page_visible 一起挂；ensure_chat_page 一进页面归位
        # 就 AttributeError，日志形如 “'WeChatUIA' object has no attribute '_chat_page_visible'”，
        # 结果 UIA 发送每次都在找会话前失败。这里补上同名只读判断，不改鲸鲸源码。
        if not getattr(WeChatUIA, '_chat_page_visible', None):
            def _chat_page_visible(self):
                try:
                    if self._chat_input() is not None:
                        return True
                except Exception:  # noqa: BLE001
                    pass
                try:
                    return bool(self._chat_page_ready(self._win))
                except Exception:  # noqa: BLE001
                    return False
            WeChatUIA._chat_page_visible = _chat_page_visible
            WeChatUIA._dsh_chat_page_patch = True
    except Exception:  # noqa: BLE001
        return
    if getattr(WeChatUIA, '_dsh_window_filter', False):
        return
    original = WeChatUIA._wechat_hwnds

    def _main_window_only(self, diag=None):
        hs = list(original(self, diag) or [])
        out = []
        for h in hs:
            try:
                if not win32gui:
                    continue
                title = (win32gui.GetWindowText(h) or '').strip()
                cls = win32gui.GetClassName(h) or ''
                if 'TrayIconMessageWindow' in cls or 'AboutWindow' in cls:
                    continue
                if title not in ('微信', 'Weixin'):
                    continue
                if not (win32gui.IsWindowVisible(h) or win32gui.IsIconic(h)):
                    continue
                if win32gui.IsIconic(h):
                    rc = win32gui.GetWindowPlacement(h)[4]
                else:
                    rc = win32gui.GetWindowRect(h)
                if not rc:
                    continue
                area = max(0, int(rc[2]) - int(rc[0])) * max(0, int(rc[3]) - int(rc[1]))
                if area < 300 * 250:
                    continue
                out.append(h)
            except Exception:  # noqa: BLE001
                continue
        return out

    WeChatUIA._wechat_hwnds = _main_window_only
    WeChatUIA._dsh_window_filter = True


_install_window_filter()


def _install_account_match():
    """让「配置里明确指定 windowHwnd」的窗口通过账号归属校验。

    微信数据目录是 Junction 时，鲸鲸用 psutil 打开文件拿到的真实路径，和
    配置里的 D:\\MyApp 别名路径字符串不相等，_window_account_matches 会
    返回 False。这里对显式钉住的 hwnd 先用**真实** open_files 核对账号目录名，
    对得上才放行；对不上直接否决，不能只凭 PID 相同就信任——否则双开时把
    另一个账号的窗口写进配置，就会安静地串号发送。
    """
    import threading

    def _run():
        mod = None
        engine = None
        for _ in range(240):
            mod = sys.modules.get('bridge.account_mixin') or sys.modules.get('account_mixin')
            engine = sys.modules.get('bridge.engine') or sys.modules.get('engine')
            if mod is not None and engine is not None:
                break
            time.sleep(0.5)
        else:
            return
        if mod is None or engine is None:
            return
        cls = mod.AccountMixin
        if getattr(cls, '_dsh_hwnd_match', False):
            return
        original = cls._window_account_matches

        def _match(self, pid):
            try:
                import win32gui
                import win32process
                from pathlib import Path
                h = int(getattr(engine, 'WINDOW_HWND', 0) or 0)
                if not h or not win32gui.IsWindow(h):
                    return original(self, pid)
                if int(win32process.GetWindowThreadProcessId(h)[1]) != int(pid):
                    return original(self, pid)
                account_dir = str(getattr(getattr(self, 'db', None), 'account_dir', '') or '')
                account_name = os.path.basename(os.path.normpath(account_dir)).lower() if account_dir else ''
                if not account_name:
                    return original(self, pid)
                if _ORIGINAL_OPEN_FILES is None or psutil is None:
                    return False
                owners = set()
                for item in _ORIGINAL_OPEN_FILES(psutil.Process(int(pid))):
                    for directory in Path(item.path).parents:
                        if directory.name.lower() == 'db_storage':
                            owners.add(directory.parent.name.lower())
                            break
                # 显式 hwnd 必须真的打开着所选账号的 db_storage；查不到也否决，
                # 宁可让桥接报「账号未确认」，也不拿别的账号窗口发消息。
                return account_name in owners if owners else False
            except Exception:  # noqa: BLE001
                return False

        cls._window_account_matches = _match
        cls._dsh_hwnd_match = True

    threading.Thread(target=_run, name='dsh-account-match', daemon=True).start()


_install_account_match()


def _install_foreground_activation():
    """给鲸鲸的窗口激活补一层 ALT 解锁 + 兜底。

    4.1.7 的 window_activation.activate 只做 ShowWindowAsync + SetForegroundWindow；
    微信窗口不在前台、且系统前台锁生效时，SetForegroundWindow 会直接失败，
    表情/图片发送就报 “could not bring the WeChat window to the foreground”。
    window_mixin.restore_win_state 已经有 ALT 解锁 + SwitchToThisWindow 的做法，
    这里只把同一套手法补到 activate 上；不改鲸鲸源码，也不改变窗口归属判断。
    """
    import threading

    def _run():
        mod = None
        for _ in range(240):
            mod = sys.modules.get('window_activation')
            if mod is None:
                try:
                    import window_activation as mod  # noqa: F401
                except Exception:  # noqa: BLE001
                    mod = None
            if mod is not None:
                break
            time.sleep(0.5)
        if mod is None or getattr(mod, '_dsh_activation_patch', False):
            return
        if not win32gui:
            return
        original = mod.activate

        def activate(hwnd):
            try:
                h = int(hwnd or 0)
                if not h or not win32gui.IsWindow(h):
                    return original(hwnd)
                if int(win32gui.GetForegroundWindow() or 0) == h:
                    return True
                try:
                    if win32gui.IsIconic(h):
                        win32gui.ShowWindow(h, 9)
                    else:
                        win32gui.ShowWindow(h, 5)
                except Exception:  # noqa: BLE001
                    pass
                try:
                    import win32api
                    win32api.keybd_event(0x12, 0, 0, 0)
                    win32api.keybd_event(0x12, 0, 2, 0)
                except Exception:  # noqa: BLE001
                    pass
                try:
                    win32gui.SetForegroundWindow(h)
                except Exception:  # noqa: BLE001
                    pass
                time.sleep(0.08)
                try:
                    if int(win32gui.GetForegroundWindow() or 0) == h:
                        return True
                except Exception:  # noqa: BLE001
                    pass
                try:
                    import ctypes
                    ctypes.windll.user32.SwitchToThisWindow(h, True)
                except Exception:  # noqa: BLE001
                    pass
                time.sleep(0.12)
                try:
                    return int(win32gui.GetForegroundWindow() or 0) == h
                except Exception:  # noqa: BLE001
                    return False
            except Exception:  # noqa: BLE001
                return original(hwnd)

        mod.activate = activate
        mod._dsh_activation_patch = True

    threading.Thread(target=_run, name='dsh-foreground-activation', daemon=True).start()


_install_foreground_activation()


