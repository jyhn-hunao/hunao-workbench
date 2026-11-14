# -*- coding: utf-8 -*-
"""blender-bridge.py —— Blender 侧的本机桥接（创意工坊场景）

干什么：在 127.0.0.1:9876 上开一个 JSON 行协议的小服务，把请求排队交回 Blender 主线程执行 bpy 代码。
         工作台/大肥鱼用 `工具\\Blender.mjs exec` 连它，就能在用户正开着的 Blender 里实时加对象、
         改材质、读场景、出图 —— 不需要装任何第三方插件。

协议（一行一个 JSON，回车即回一行 JSON）：
    {"cmd":"ping"}                                  → {"ok":true,"version":"4.5.x","file":"...","objects":N}
    {"cmd":"exec","code":"...","timeout":30}         → {"ok":true,"result":<可 JSON 化的返回值>}
    {"cmd":"exec","code":"...","mode":"exec"}        → 强制按语句执行（结果取变量 result）
    失败 → {"ok":false,"error":"...","trace":"..."}

安全：只绑 127.0.0.1；单条请求上限 1 MB；执行超时返回错误（不会卡死工作台）。
启动方式：`blender.exe --python blender-bridge.py`（工作台「Blender」面板的 ▶ 启动会自动带上它）。

⚠ 本文件只跑在 Blender 的 Python 里，别拿普通 CPython 跑（没有 bpy）。
"""

import json
import os
import queue
import socket
import threading
import traceback

import bpy

PORT = int(os.environ.get('DSH_BLENDER_BRIDGE_PORT') or 9876)
MAX_BYTES = 1024 * 1024
_jobs = queue.Queue()


def _safe(value):
    """把 bpy 的返回值压成能 JSON 化的东西（对象 / 集合 / 向量一律转字符串）。"""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    try:
        if isinstance(value, (list, tuple, dict)):
            return json.loads(json.dumps(value, default=str, ensure_ascii=False))
    except Exception:
        return str(value)
    return str(value)


def _execute(code, mode):
    """在主线程执行一段代码：默认先按表达式求值（写查询最省事），再退回按语句执行。"""
    if mode != 'exec':
        try:
            return True, _safe(eval(compile(code, '<bridge>', 'eval'), {'bpy': bpy}))
        except SyntaxError:
            pass
    namespace = {'bpy': bpy, 'result': None}
    exec(compile(code, '<bridge>', 'exec'), namespace)
    return True, _safe(namespace.get('result'))


def _tick():
    """Blender 主线程定时器：把队列里的请求逐个执行完，再等下一拍。"""
    while True:
        try:
            job = _jobs.get_nowait()
        except queue.Empty:
            break
        req, done, box = job
        try:
            ok, value = _execute(str(req.get('code') or ''), str(req.get('mode') or 'auto'))
            box['reply'] = {'ok': bool(ok), 'result': value}
        except Exception as exc:
            box['reply'] = {
                'ok': False,
                'error': '%s: %s' % (exc.__class__.__name__, exc),
                'trace': traceback.format_exc()[-4000:],
            }
        finally:
            done.set()
    return 0.05


def _handle(conn):
    try:
        conn.settimeout(35)
        buf = b''
        while b'\n' not in buf:
            chunk = conn.recv(65536)
            if not chunk:
                break
            buf += chunk
            if len(buf) > MAX_BYTES:
                raise ValueError('请求超过 1 MB')
        line = buf.split(b'\n', 1)[0].strip()
        if not line:
            return
        req = json.loads(line.decode('utf-8'))

        if req.get('cmd') == 'ping':
            reply = {
                'ok': True,
                'version': bpy.app.version_string,
                'file': bpy.data.filepath,
                'objects': len(bpy.data.objects),
                'port': PORT,
            }
        else:
            done = threading.Event()
            box = {}
            _jobs.put((req, done, box))
            timeout = float(req.get('timeout') or 30)
            if not done.wait(timeout):
                reply = {'ok': False, 'error': '超时 %ss：Blender 主线程没空（可能正弹窗 / 正渲染）' % int(timeout)}
            else:
                reply = box.get('reply') or {'ok': False, 'error': '无结果'}
        conn.sendall((json.dumps(reply, ensure_ascii=False) + '\n').encode('utf-8'))
    except Exception as exc:
        try:
            conn.sendall((json.dumps({'ok': False, 'error': str(exc)}) + '\n').encode('utf-8'))
        except Exception:
            pass
    finally:
        try:
            conn.close()
        except Exception:
            pass


def _serve():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        srv.bind(('127.0.0.1', PORT))
        srv.listen(8)
    except Exception as exc:
        print('[blender-bridge] 端口 %s 绑不上：%s' % (PORT, exc))
        return
    print('[blender-bridge] 监听 127.0.0.1:%s' % PORT)
    while True:
        try:
            conn, _addr = srv.accept()
        except Exception:
            continue
        threading.Thread(target=_handle, args=(conn,), daemon=True).start()


try:
    bpy.app.timers.register(_tick, first_interval=0.05, persistent=True)
    threading.Thread(target=_serve, daemon=True).start()
    print('[blender-bridge] 已挂到 Blender %s，端口 %s' % (bpy.app.version_string, PORT))
except Exception:
    print('[blender-bridge] 启动失败：\n%s' % traceback.format_exc())
