# -*- coding: utf-8 -*-
"""大肥鱼桌宠动作表：每一段都是“时间 -> 各部位角度/位移”的函数。

约束：
- 头层绕颈支点转，超过 ±4° 会露下巴缝，所以头部角度统一夹在 ±4°。
- faceClosed / mouthClosed 只是补层透明度，默认 0；原画主体永不替换。
- idle / drag / sleep_loop 的首尾帧必须一致，循环不跳。
- 所有动作从 rest 起、回 rest 收，dsh-pet 交叉淡入时不会闪。
"""
from __future__ import annotations

import math
from typing import Callable, Dict, List, Tuple

TAU = math.pi * 2


def clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def smooth(x: float) -> float:
    x = clamp(x, 0.0, 1.0)
    return x * x * (3.0 - 2.0 * x)


def kf(t: float, pts: List[Tuple[float, float]]) -> float:
    """关键帧线性 + smoothstep 过渡；首尾自动夹住。"""
    if t <= pts[0][0]:
        return pts[0][1]
    if t >= pts[-1][0]:
        return pts[-1][1]
    for i in range(len(pts) - 1):
        t0, v0 = pts[i]
        t1, v1 = pts[i + 1]
        if t0 <= t <= t1:
            return v0 + (v1 - v0) * smooth((t - t0) / max(1e-6, t1 - t0))
    return pts[-1][1]


def pulse(t: float, a: float, b: float, c: float, d: float) -> float:
    """a→b 起，b→c 保持 1，c→d 落。"""
    if t <= a or t >= d:
        return 0.0
    if t < b:
        return smooth((t - a) / max(1e-6, b - a))
    if t <= c:
        return 1.0
    return 1.0 - smooth((t - c) / max(1e-6, d - c))


def blink(t: float, times: List[float], fade: float = 0.07, hold: float = 0.05) -> float:
    a = 0.0
    for s in times:
        u = t - s
        if u < 0:
            continue
        if u < fade:
            a = max(a, smooth(u / fade))
        elif u < fade + hold:
            a = 1.0
        elif u < fade * 2 + hold:
            a = max(a, 1.0 - smooth((u - fade - hold) / fade))
    return a


def chew(t: float, rate: float = 4.0, lo: float = 0.15, hi: float = 1.0, phase: float = 0.0) -> float:
    return lo + (hi - lo) * (0.5 + 0.5 * math.sin(TAU * rate * t + phase))


def head(rot: float = 0.0, dx: float = 0.0, dy: float = 0.0) -> Tuple[float, float, float]:
    return clamp(rot, -4.0, 4.0), clamp(dx, -4.0, 4.0), clamp(dy, -4.0, 4.0)


def arms(l: float, lx: float = 0.0, ly: float = 0.0, r: float = 0.0, rx: float = 0.0, ry: float = 0.0):
    return (l, lx, ly), (r, rx, ry)


def hold_pose(t: float, deep: float = 1.0, phase: float = 0.0) -> dict:
    """拿东西时的双臂：往中间收，手在身前。"""
    return {
        "armL": (18 * deep + 2 * math.sin(TAU * t + phase), 7 * deep, 1 * deep),
        "armR": (-18 * deep - 2 * math.sin(TAU * t + phase + 0.8), -7 * deep, 1 * deep),
        "head": head(1.8 * deep, 0.8 * deep, 2.6 * deep),
        "body": (1.0 * deep, 0, 1.0 * deep, 1.0, 1.0 - 0.006 * deep),
    }


# ===================== 待机 =====================
def idle_breathe(t: float) -> dict:
    b = math.sin(TAU * t / 4.0)
    return {
        "body": (0.7 * b, 0, -1.1 * b, 1.0 + 0.012 * b, 1.0 + 0.012 * b),
        "head": head(1.2 * math.sin(TAU * t / 8.0 + 0.5), 0.4 * b, -0.4 * b),
        "armL": (1.6 * math.sin(TAU * t / 4.0 + 0.4), 0, 0),
        "armR": (-1.6 * math.sin(TAU * t / 4.0 + 0.9), 0, 0),
        "legL": (0.7 * math.sin(TAU * t / 4.0 + 0.2), 0, 0),
        "legR": (-0.7 * math.sin(TAU * t / 4.0 + 0.2), 0, 0),
        "tail": (7.0 * math.sin(TAU * t / 4.0 + 0.8), 0, 0),
        "face": blink(t, [2.2, 5.8]),
    }


def idle_look(t: float) -> dict:
    h = 3.0 * math.sin(TAU * t / 8.0) + 1.0 * math.sin(TAU * t / 4.0 + 0.7)
    return {
        "body": (0.9 * math.sin(TAU * t / 8.0 + 0.2), 0, 0, 1.0, 1.0),
        "head": head(h, 2.6 * math.sin(TAU * t / 8.0 + 0.3), -0.4 * math.sin(TAU * t / 4.0)),
        "armL": (1.5 * math.sin(TAU * t / 4.0 + 1.1), 0, 0),
        "armR": (-1.5 * math.sin(TAU * t / 4.0 + 0.3), 0, 0),
        "tail": (9.0 * math.sin(TAU * t / 4.0 + 0.2), 0, 0),
        "face": blink(t, [3.2, 6.6]),
    }


def idle_tail(t: float) -> dict:
    tw = 14.0 * math.sin(TAU * t / 4.0) + 3.0 * math.sin(TAU * t / 2.0 + 0.4)
    return {
        "body": (1.2 * math.sin(TAU * t / 8.0 + 0.5), 0, -0.3 * math.sin(TAU * t / 4.0), 1.0, 1.0),
        "head": head(1.0 * math.sin(TAU * t / 8.0 + 1.0), 0.6 * math.sin(TAU * t / 4.0), 0),
        "armL": (1.0 * math.sin(TAU * t / 4.0 + 0.6), 0, 0),
        "armR": (-1.0 * math.sin(TAU * t / 4.0 + 0.2), 0, 0),
        "tail": (tw, 0, 0),
        "face": blink(t, [2.6, 6.0]),
    }


# ===================== 转向 / 拖拽 =====================
def turn_hop(t: float) -> dict:
    crouch = pulse(t, 0.0, 0.16, 0.22, 0.34)
    air = pulse(t, 0.20, 0.36, 0.62, 0.86)
    land = pulse(t, 0.78, 0.90, 0.98, 1.12)
    return {
        "body": (0, 0, 2 * crouch + 2 * land, 1.0 + 0.02 * air, 1.0 - 0.05 * crouch + 0.02 * air - 0.03 * land),
        "head": head(1.5 * air, 0, -1.5 * air + 2 * crouch),
        "armL": (24 * air + 6 * crouch - 8 * land, 0, -4 * air),
        "armR": (-24 * air - 6 * crouch + 8 * land, 0, -4 * air),
        "legL": (5 * air + 3 * crouch, 0, 0),
        "legR": (-5 * air - 3 * crouch, 0, 0),
        "tail": (10 * math.sin(TAU * t / 1.2 * 2) * air, 0, 0),
        "global": (0, -18 * air + 3 * crouch, 1.5 * air, 1.0, 1.0 + 0.02 * air - 0.04 * crouch),
    }


def drag_hold(t: float) -> dict:
    b = math.sin(TAU * t / 4.0)
    return {
        "body": (-4.0 + 1.3 * b, 0, 0, 1.0, 1.0),
        "head": head(2.0 + 0.8 * b, 0.8 * b, -0.8 * b),
        "armL": (28.0 + 3.0 * b, 2.0, -2.0),
        "armR": (-28.0 - 3.0 * b, -2.0, -2.0),
        "legL": (7.0 * math.sin(TAU * t / 4.0 + 0.5), 0, 0),
        "legR": (-7.0 * math.sin(TAU * t / 4.0 + 1.2), 0, 0),
        "tail": (11.0 * math.sin(TAU * t / 4.0 + 0.3), 0, 0),
        "global": (0, -10 + 2.4 * b, -1.8 * b, 1.0, 1.0),
        "face": 0.10 + 0.05 * b,
        "mouth": 0.10,
        "fx": [{"kind": "sweat", "pos": (365, 118), "alpha": 0.35 + 0.2 * b}],
    }


# ===================== 点击回应 =====================
def click_happy(t: float) -> dict:
    jump = pulse(t, 0.18, 0.42, 1.02, 1.42)
    settle = pulse(t, 1.30, 1.55, 1.85, 2.10)
    return {
        "body": (0, 0, -1.5 * jump + 1.0 * settle, 1.0 + 0.02 * jump, 1.0 - 0.03 * jump),
        "head": head(2.5 * jump - 1.0 * settle, 0, -2.0 * jump + 1.0 * settle),
        "armL": (34 * jump, 4 * jump, -4 * jump),
        "armR": (-34 * jump, -4 * jump, -4 * jump),
        "legL": (5 * jump, 0, 0),
        "legR": (-5 * jump, 0, 0),
        "tail": (16 * math.sin(TAU * t * 2.0) * jump, 0, 0),
        "global": (0, -16 * jump, 1.5 * jump, 1.0, 1.0 + 0.02 * jump - 0.02 * settle),
        "mouth": 0.0,
        "fx": [{"kind": "blush", "alpha": 0.9 * jump}, {"kind": "sparkles", "alpha": 0.7 * jump}],
    }


def click_shy(t: float) -> dict:
    shy = pulse(t, 0.15, 0.50, 1.90, 2.50)
    return {
        "body": (2.0 * shy, 0, 1.5 * shy, 1.0, 1.0 - 0.008 * shy),
        "head": head(3.0 * shy, -1.0 * shy, 2.8 * shy),
        "armL": (18 * shy, 8 * shy, 0),
        "armR": (-18 * shy, -8 * shy, 0),
        "legL": (2.0 * shy, 0, 0),
        "legR": (-2.0 * shy, 0, 0),
        "tail": (5.0 * math.sin(TAU * t / 3.0 + 0.3) * shy, 0, 0),
        "face": 0.45 * shy,
        "mouth": 0.55 * shy,
        "fx": [{"kind": "blush", "alpha": 1.0 * shy}],
    }


def click_angry(t: float) -> dict:
    p = pulse(t, 0.10, 0.30, 1.70, 2.20)
    shake = math.sin(TAU * 7.0 * t) * 2.2 * p
    return {
        "body": (1.5 * p, 0, 2.0 * p, 1.0, 1.0),
        "head": head(-2.0 * p + shake, 0, -1.0 * p),
        "armL": (22 * p, 5 * p, 2 * p),
        "armR": (-22 * p, -5 * p, 2 * p),
        "legL": (2.0 * p, 0, 0),
        "legR": (-2.0 * p, 0, 0),
        "tail": (14.0 * math.sin(TAU * t * 2.5) * p, 0, 0),
        "mouth": 0.05,
        "fx": [{"kind": "anger", "pos": (366, 110), "alpha": 1.0 * p}],
    }


def click_surprised(t: float) -> dict:
    p = pulse(t, 0.10, 0.26, 1.30, 1.90)
    recoil = pulse(t, 0.16, 0.30, 0.50, 0.70)
    return {
        "body": (-2.0 * p, 0, 0, 1.0, 1.0 + 0.01 * p),
        "head": head(-3.0 * p, 0, -2.0 * p),
        "armL": (30 * p, 5 * p, -3 * p),
        "armR": (-30 * p, -5 * p, -3 * p),
        "legL": (4 * p, 0, 0),
        "legR": (-4 * p, 0, 0),
        "tail": (10 * math.sin(TAU * t * 2.0) * p, 0, 0),
        "global": (0, -8 * recoil, -1.5 * recoil, 1.0, 1.0),
        "face": 0.0,
        "mouth": 0.0,
        "fx": [{"kind": "question", "pos": (380, 92), "alpha": p}],
    }


def click_wave(t: float) -> dict:
    p = pulse(t, 0.10, 0.35, 2.10, 2.70)
    wave = math.sin(TAU * 3.0 * t) * p
    return {
        "body": (1.0 * p, 0, 0, 1.0, 1.0),
        "head": head(2.5 * p, 1.0 * p, 0),
        "armL": (4 * p, 0, 0),
        "armR": (-42 * p + 10 * wave, -2 * p, -5 * p),
        "legL": (1.5 * p, 0, 0),
        "legR": (-1.5 * p, 0, 0),
        "tail": (10 * math.sin(TAU * t * 2.0 + 0.3) * p, 0, 0),
        "mouth": 0.0,
        "fx": [{"kind": "sparkles", "alpha": 0.6 * p}, {"kind": "blush", "alpha": 0.4 * p}],
    }


# ===================== 移动 =====================
def _walk(t: float, dur: float, speed: float, amp_leg: float, amp_arm: float, lift: float) -> dict:
    g = pulse(t, 0.55, 0.95, dur - 0.55, dur - 0.15)
    step = math.sin(TAU * speed * t)
    bob = abs(math.sin(TAU * speed * t))
    return {
        "body": (1.5 * g, 0, -1.4 * bob * g, 1.0, 1.0),
        "head": head(1.0 * g, 0.5 * step * g, -1.0 * bob * g),
        "armL": (amp_arm * step * g, 0, 0),
        "armR": (-amp_arm * step * g, 0, 0),
        "legL": (amp_leg * step * g, 0, 0),
        "legR": (-amp_leg * step * g, 0, 0),
        "tail": (8.0 * math.sin(TAU * speed * t + 0.8) * g, 0, 0),
        "global": (0, -lift * bob * g, 0, 1.0, 1.0),
        "mouth": 0.0,
    }


def walk_slow(t: float) -> dict:
    return _walk(t, 4.0, 1.8, 7.0, 6.0, 1.5)


def walk_fast(t: float) -> dict:
    return _walk(t, 3.0, 2.6, 10.0, 9.0, 2.5)


def walk_tiptoe(t: float) -> dict:
    p = _walk(t, 3.5, 2.1, 4.0, 5.0, 1.0)
    g = pulse(t, 0.55, 0.95, 3.5 - 0.55, 3.5 - 0.15)
    p["global"] = (0, -2.0 * g, 0, 1.0, 1.0)
    p["body"] = (0.5 * g, 0, 0, 1.0, 1.0)
    p["armL"] = (12.0 * g, 4.0 * g, -2.0 * g)
    p["armR"] = (-12.0 * g, -4.0 * g, -2.0 * g)
    return p


# ===================== 随机小动作 =====================
def stretch(t: float) -> dict:
    p = pulse(t, 0.12, 0.55, 2.50, 3.20)
    return {
        "body": (0, 0, -2.0 * p, 1.0, 1.0 + 0.045 * p),
        "head": head(-2.5 * p, 0, -2.0 * p),
        "armL": (48 * p, 6 * p, -8 * p),
        "armR": (-48 * p, -6 * p, -8 * p),
        "legL": (2.0 * p, 0, 0),
        "legR": (-2.0 * p, 0, 0),
        "tail": (12 * math.sin(TAU * t / 4.0) * p, 0, 0),
        "global": (0, -4 * p, 0, 1.0, 1.0),
        "mouth": 0.0,
        "fx": [{"kind": "sparkles", "alpha": 0.35 * p}],
    }


def yawn(t: float) -> dict:
    p = pulse(t, 0.10, 0.55, 2.40, 2.95)
    return {
        "body": (0, 0, 1.0 * p, 1.0, 1.0 + 0.02 * p),
        "head": head(-2.0 * p, 0, -2.0 * p),
        "armL": (28 * p, 5 * p, -4 * p),
        "armR": (-28 * p, -5 * p, -4 * p),
        "legL": (1.0 * p, 0, 0),
        "legR": (-1.0 * p, 0, 0),
        "tail": (5.0 * math.sin(TAU * t / 4.0) * p, 0, 0),
        "face": 0.75 * p,
        "mouth": 0.0,
    }


def fix_hair(t: float) -> dict:
    p = pulse(t, 0.15, 0.50, 2.80, 3.40)
    pat = math.sin(TAU * 2.0 * t) * p
    return {
        "body": (1.0 * p, 0, 0, 1.0, 1.0),
        "head": head(2.5 * p, 1.0 * p, 1.0 * p),
        "armL": (4 * p, 0, 0),
        "armR": (-48 * p + 6 * pat, -3 * p, -10 * p),
        "legL": (1.0 * p, 0, 0),
        "legR": (-1.0 * p, 0, 0),
        "tail": (6 * math.sin(TAU * t / 4.0 + 0.4) * p, 0, 0),
        "mouth": 0.0,
    }


def swing_legs(t: float) -> dict:
    p = pulse(t, 0.10, 0.45, 2.80, 3.30)
    s = math.sin(TAU * 2.0 * t)
    return {
        "body": (0, 0, -1.5 * p, 1.0, 1.0),
        "head": head(1.5 * p, 0, -1.0 * p),
        "armL": (8 * p, 3 * p, 0),
        "armR": (-8 * p, -3 * p, 0),
        "legL": (12 * s * p, 0, 0),
        "legR": (-12 * s * p, 0, 0),
        "global": (0, -3 * p, 0, 1.0, 1.0),
        "tail": (8 * math.sin(TAU * t / 3.0) * p, 0, 0),
        "mouth": 0.0,
    }


def play_cube(t: float) -> dict:
    p = pulse(t, 0.10, 0.45, 3.40, 3.85)
    bounce = abs(math.sin(TAU * 1.2 * t)) * p
    return {
        **hold_pose(t, p, 0.2),
        "head": head(2.0 * p, 0, 2.8 * p - 1.2 * bounce),
        "props": [{"name": "魔方", "pos": (320, 240 - 5 * bounce), "w": 64, "h": 64,
                   "rot": 7 * math.sin(TAU * 1.4 * t), "alpha": p}],
        "mouth": 0.0,
        "fx": [{"kind": "sparkles", "alpha": 0.25 * p}],
    }


def play_game(t: float) -> dict:
    p = pulse(t, 0.10, 0.45, 3.40, 3.85)
    tap = math.sin(TAU * 4.0 * t)
    return {
        **hold_pose(t, p, 0.4),
        "head": head(1.5 * p, 0, 2.5 * p),
        "props": [{"name": "游戏手柄", "pos": (320, 245), "w": 80, "h": 52, "alpha": p,
                   "rot": 3 * tap}],
        "body": (0, 0, 0.6 * p, 1.0, 1.0),
        "mouth": 0.0,
        "fx": [{"kind": "sparkles", "alpha": 0.25 * p}],
    }


def peek(t: float) -> dict:
    hide = pulse(t, 0.0, 0.25, 0.85, 1.10)
    peek_open = pulse(t, 0.95, 1.25, 2.40, 2.85)
    return {
        "body": (0, 0, 0.5 * hide, 1.0, 1.0),
        "head": head(2.0 * peek_open, 1.0 * peek_open, 0),
        "armL": (40 * hide, 7 * hide, -5 * hide),
        "armR": (-40 * hide, -7 * hide, -5 * hide),
        "legL": (1.5 * peek_open, 0, 0),
        "legR": (-1.5 * peek_open, 0, 0),
        "tail": (7 * math.sin(TAU * t * 1.5) * peek_open, 0, 0),
        "face": 0.8 * hide,
        "mouth": 0.35 * hide,
        "fx": [{"kind": "sparkles", "alpha": 0.5 * peek_open}],
    }


def eat_rice(t: float) -> dict:
    p = pulse(t, 0.10, 0.45, 3.40, 3.85)
    bob = abs(math.sin(TAU * 1.5 * t)) * p
    return {
        **hold_pose(t, p, 0.4),
        "head": head(1.5 * p, 0, 2.8 * p - 1.8 * bob),
        "body": (0, 0, 1.0 * p, 1.0, 1.0),
        "props": [{"name": "饭碗", "pos": (320, 248 - 3 * bob), "w": 94, "h": 82, "alpha": p}],
        "mouth": chew(t, 3.2, 0.15, 1.0) * p,
        "fx": [{"kind": "sparkles", "alpha": 0.2 * p}],
    }


def eat_snack(t: float) -> dict:
    p = pulse(t, 0.10, 0.40, 3.00, 3.40)
    bob = abs(math.sin(TAU * 1.8 * t)) * p
    return {
        **hold_pose(t, p, 0.4),
        "head": head(1.8 * p, -1.0 * p, 2.5 * p - 1.5 * bob),
        "armR": (-22 * p - 2 * math.sin(TAU * 2.0 * t), -9 * p, -2 * p),
        "props": [{"name": "零食袋", "pos": (345, 235 - 3 * bob), "w": 52, "h": 70, "alpha": p,
                   "rot": 4 * math.sin(TAU * 2.0 * t)}],
        "mouth": chew(t, 4.0, 0.2, 1.0) * p,
    }


def drink(t: float) -> dict:
    p = pulse(t, 0.10, 0.45, 2.90, 3.35)
    tilt = math.sin(TAU * 1.2 * t) * p
    return {
        **hold_pose(t, p, 0.4),
        "head": head(-2.0 * p, 0, -1.5 * p),
        "armR": (-30 * p, -10 * p, -6 * p),
        "props": [{"name": "马克杯", "pos": (350, 228), "w": 46, "h": 52, "alpha": p,
                   "rot": -8 * tilt}],
        "mouth": 0.25 * p,
        "fx": [{"kind": "sparkles", "alpha": 0.15 * p}],
    }


def summer_fan(t: float) -> dict:
    p = pulse(t, 0.10, 0.45, 3.40, 3.85)
    fan = math.sin(TAU * 2.2 * t) * p
    return {
        "body": (0, 0, 0.8 * p, 1.0, 1.0),
        "head": head(1.5 * p, 1.0 * p, 0),
        "armL": (4 * p, 0, 0),
        "armR": (-32 * p + 6 * fan, -3 * p, -5 * p),
        "legL": (1.0 * p, 0, 0),
        "legR": (-1.0 * p, 0, 0),
        "tail": (8 * math.sin(TAU * t / 3.0) * p, 0, 0),
        "props": [{"name": "团扇", "pos": (365, 205), "w": 58, "h": 80, "alpha": p,
                   "rot": 12 * fan}],
        "mouth": 0.0,
        "fx": [{"kind": "sweat", "pos": (362, 122), "alpha": 0.6 * p}],
    }


def autumn_leaf(t: float) -> dict:
    p = pulse(t, 0.0, 0.3, 3.4, 3.9)
    fall = smooth(t / 3.2) if t < 3.2 else 1.0
    x = 380 - 55 * fall
    y = 70 + 210 * fall
    return {
        "body": (0.5 * p, 0, 0, 1.0, 1.0),
        "head": head(2.5 * p, 1.0 * p, -1.0 * p),
        "armL": (22 * p, 5 * p, -3 * p),
        "armR": (-22 * p, -5 * p, -3 * p),
        "legL": (1.0 * p, 0, 0),
        "legR": (-1.0 * p, 0, 0),
        "tail": (7 * math.sin(TAU * t / 4.0) * p, 0, 0),
        "props": [{"name": "枫叶", "pos": (x, y), "w": 38, "h": 38, "alpha": p,
                   "rot": 18 * fall * math.sin(TAU * 1.5 * t)}],
        "mouth": 0.0,
        "fx": [{"kind": "sparkles", "alpha": 0.25 * p}],
    }


def winter_shiver(t: float) -> dict:
    p = pulse(t, 0.05, 0.30, 3.10, 3.45)
    shiver = math.sin(TAU * 9.0 * t) * p
    return {
        "body": (1.5 * shiver, 0, 0, 1.0, 1.0 - 0.01 * p),
        "head": head(1.0 * shiver, 0.5 * shiver, 0),
        "armL": (22 * p, 8 * p, -2 * p),
        "armR": (-22 * p, -8 * p, -2 * p),
        "legL": (2 * shiver, 0, 0),
        "legR": (-2 * shiver, 0, 0),
        "tail": (4 * shiver, 0, 0),
        "global": (0, 1.5 * p, 0, 1.0, 1.0),
        "mouth": 0.2,
        "fx": [{"kind": "snow", "alpha": 0.8 * p}, {"kind": "sweat", "pos": (365, 120), "alpha": 0.35 * p}],
    }


def read_book(t: float) -> dict:
    p = pulse(t, 0.10, 0.45, 3.40, 3.85)
    page = math.sin(TAU * 0.6 * t) * p
    return {
        **hold_pose(t, p, 0.3),
        "head": head(2.0 * p, 0, 3.2 * p),
        "props": [{"name": "书本", "pos": (320, 250), "w": 104, "h": 82, "alpha": p,
                   "rot": 2 * page}],
        "mouth": 0.0,
        "fx": [{"kind": "sparkles", "alpha": 0.15 * p}],
    }


def write_note(t: float) -> dict:
    p = pulse(t, 0.10, 0.45, 3.40, 3.85)
    scribble = math.sin(TAU * 3.0 * t) * p
    return {
        **hold_pose(t, p, 0.5),
        "head": head(2.2 * p, 0, 3.2 * p),
        "armR": (-24 * p + 3 * scribble, -10 * p, -3 * p),
        "props": [{"name": "笔记本", "pos": (320, 250), "w": 76, "h": 72, "alpha": p}],
        "mouth": 0.0,
    }


def think_pose(t: float) -> dict:
    p = pulse(t, 0.10, 0.45, 2.90, 3.40)
    return {
        "body": (1.0 * p, 0, 0, 1.0, 1.0),
        "head": head(2.0 * p, 1.0 * p, -1.5 * p),
        "armL": (5 * p, 0, 0),
        "armR": (-46 * p, -4 * p, -10 * p),
        "legL": (1.0 * p, 0, 0),
        "legR": (-1.0 * p, 0, 0),
        "tail": (5 * math.sin(TAU * t / 4.0) * p, 0, 0),
        "mouth": 0.3 * p,
        "fx": [{"kind": "thought", "alpha": p}],
    }


# ===================== 工作状态 =====================
def work_thinking(t: float) -> dict:
    b = math.sin(TAU * t / 4.0)
    return {
        "body": (0.8 * b, 0, -0.8 * b, 1.0, 1.0),
        "head": head(2.0 + 0.6 * b, 0.8, -1.2),
        "armL": (4, 0, 0),
        "armR": (-42 + 2 * b, -4, -9),
        "legL": (0.8 * b, 0, 0),
        "legR": (-0.8 * b, 0, 0),
        "tail": (5 * math.sin(TAU * t / 4.0 + 0.4), 0, 0),
        "mouth": 0.25,
        "fx": [{"kind": "thought", "alpha": 0.75}],
    }


def work_working(t: float) -> dict:
    tap = math.sin(TAU * 3.0 * t)
    bob = abs(math.sin(TAU * 2.0 * t))
    return {
        "body": (0.8 * tap, 0, -1.0 * bob, 1.0, 1.0),
        "head": head(1.5, 0.5 * tap, 2.2),
        "armL": (14 + 4 * tap, 6, 0),
        "armR": (-14 - 4 * tap, -6, 0),
        "legL": (1.0 * tap, 0, 0),
        "legR": (-1.0 * tap, 0, 0),
        "tail": (4 * math.sin(TAU * t / 4.0), 0, 0),
        "mouth": 0.3,
        "fx": [{"kind": "sweat", "pos": (365, 122), "alpha": 0.45 + 0.2 * bob}],
    }


def work_result(t: float) -> dict:
    p = pulse(t, 0.10, 0.45, 2.60, 3.35)
    nod = math.sin(TAU * t / 3.5) * p
    return {
        "body": (0, 0, 0.8 * p, 1.0, 1.0),
        "head": head(1.2 * p, 0, 1.4 * p + 0.8 * nod),
        "armL": (16 * p, 5 * p, 0),
        "armR": (-16 * p, -5 * p, 0),
        "tail": (6 * math.sin(TAU * t / 3.5) * p, 0, 0),
        "mouth": 0.0,
        "fx": [{"kind": "sparkles", "alpha": 0.5 * p}],
    }


def work_waiting(t: float) -> dict:
    look = math.sin(TAU * t / 4.0)
    tap = math.sin(TAU * 2.5 * t)
    return {
        "body": (0, 0, 0, 1.0, 1.0),
        "head": head(2.0 * look, 1.8 * look, 0),
        "armL": (6, 0, 0),
        "armR": (-6, 0, 0),
        "legL": (2.0 * tap, 0, 0),
        "legR": (-2.0 * tap, 0, 0),
        "tail": (5 * math.sin(TAU * t / 4.0), 0, 0),
        "mouth": 0.2,
        "fx": [{"kind": "question", "pos": (380, 94), "alpha": 0.8}],
    }


def work_success(t: float) -> dict:
    p = pulse(t, 0.10, 0.35, 1.80, 2.40)
    jump = pulse(t, 0.16, 0.42, 0.80, 1.15)
    return {
        "body": (0, 0, -1.0 * jump, 1.0, 1.0 + 0.02 * jump),
        "head": head(2.0 * jump, 0, -1.5 * jump),
        "armL": (38 * p, 5 * p, -5 * p),
        "armR": (-38 * p, -5 * p, -5 * p),
        "legL": (4 * jump, 0, 0),
        "legR": (-4 * jump, 0, 0),
        "tail": (14 * math.sin(TAU * t * 2.0) * p, 0, 0),
        "global": (0, -12 * jump, 0, 1.0, 1.0),
        "mouth": 0.0,
        "fx": [{"kind": "blush", "alpha": 0.6 * p}, {"kind": "sparkles", "alpha": 0.8 * p}],
    }


def work_error(t: float) -> dict:
    p = pulse(t, 0.10, 0.40, 3.10, 3.70)
    return {
        "body": (-2.0 * p, 0, 1.5 * p, 1.0, 1.0 - 0.015 * p),
        "head": head(2.5 * p, 0, 3.0 * p),
        "armL": (-6 * p, 0, 2 * p),
        "armR": (6 * p, 0, 2 * p),
        "legL": (2 * p, 0, 0),
        "legR": (-2 * p, 0, 0),
        "tail": (-4 * p, 0, 0),
        "mouth": 0.2,
        "fx": [{"kind": "sweat", "pos": (365, 120), "alpha": 0.8 * p},
               {"kind": "anger", "pos": (368, 112), "alpha": 0.45 * p}],
    }


# ===================== 碎碎念 =====================
def whisper_soft(t: float) -> dict:
    p = pulse(t, 0.0, 0.3, 2.5, 2.95)
    return {
        "body": (0.8 * p, 0, 0, 1.0, 1.0),
        "head": head(2.0 * p, 1.0 * p, 0),
        "armL": (4 * p, 0, 0),
        "armR": (-26 * p + 3 * math.sin(TAU * 2.0 * t), -4 * p, -6 * p),
        "legL": (1.0 * p, 0, 0),
        "legR": (-1.0 * p, 0, 0),
        "tail": (6 * math.sin(TAU * t / 3.0) * p, 0, 0),
        "mouth": chew(t, 3.0, 0.15, 0.8) * p,
        "fx": [{"kind": "blush", "alpha": 0.35 * p}],
    }


def whisper_think(t: float) -> dict:
    p = pulse(t, 0.0, 0.3, 2.5, 2.95)
    return {
        "body": (0.5 * p, 0, 0, 1.0, 1.0),
        "head": head(2.2 * p, 1.2 * p, -1.5 * p),
        "armL": (4 * p, 0, 0),
        "armR": (-44 * p, -4 * p, -9 * p),
        "legL": (1.0 * p, 0, 0),
        "legR": (-1.0 * p, 0, 0),
        "tail": (4 * math.sin(TAU * t / 4.0) * p, 0, 0),
        "mouth": 0.25 * p,
        "fx": [{"kind": "thought", "alpha": 0.6 * p}],
    }


def whisper_look(t: float) -> dict:
    p = pulse(t, 0.0, 0.3, 2.5, 2.95)
    look = math.sin(TAU * 0.7 * t) * p
    return {
        "body": (0, 0, 0, 1.0, 1.0),
        "head": head(2.0 * look, 2.2 * look, 0),
        "armL": (5 * p, 0, 0),
        "armR": (-5 * p, 0, 0),
        "legL": (1.0 * p, 0, 0),
        "legR": (-1.0 * p, 0, 0),
        "tail": (8 * math.sin(TAU * t / 3.0) * p, 0, 0),
        "mouth": 0.2 * p,
        "fx": [{"kind": "blush", "alpha": 0.25 * p}],
    }


# ===================== 睡觉 =====================
def _sleep_pose(t: float, deep: float, zzz_alpha: float = 1.0) -> dict:
    b = math.sin(TAU * t / 4.0)
    return {
        "body": (1.0, 0, 1.8 + 0.8 * b, 1.0, 0.94),
        "head": head(2.0, 0, 3.0 + 0.4 * b),
        "armL": (-4, 0, 1),
        "armR": (4, 0, 1),
        "legL": (0, 0, 0),
        "legR": (0, 0, 0),
        "tail": (2.0 * b, 0, 0),
        "global": (0, 2.0, 0, 1.0, 0.94),
        "face": 1.0,
        "mouth": 1.0,
        "props": [{"name": "小毯子", "pos": (320, 300), "w": 190, "h": 100, "alpha": deep}],
        "fx": [{"kind": "zzz", "t": t, "alpha": zzz_alpha * deep}],
    }


def sleep_start(t: float) -> dict:
    p = smooth(t / 2.2)
    pose = _sleep_pose(t, p, p)
    pose["head"] = head(2.0 * p, 0, 3.0 * p)
    pose["body"] = (1.0 * p, 0, 1.8 * p, 1.0, 1.0 - 0.06 * p)
    pose["global"] = (0, 2.0 * p, 0, 1.0, 1.0 - 0.06 * p)
    pose["face"] = p
    pose["mouth"] = p
    return pose


def sleep_loop(t: float) -> dict:
    return _sleep_pose(t, 1.0, 1.0)


def sleep_end(t: float) -> dict:
    p = smooth(t / 2.2)
    wake = pulse(t, 1.2, 1.5, 1.8, 2.2)
    base = _sleep_pose(t, 1.0, 1.0 - p)
    base["body"] = (1.0 - 1.0 * p, 0, 1.8 - 1.8 * p, 1.0, 0.94 + 0.06 * p)
    base["head"] = head(2.0 - 2.0 * p, 0, 3.0 - 3.0 * p)
    base["global"] = (0, 2.0 - 2.0 * p, 0, 1.0, 0.94 + 0.06 * p)
    base["face"] = 1.0 - p
    base["mouth"] = 1.0 - p
    base["armL"] = (-4 + 34 * wake, 4 * wake, -4 * wake)
    base["armR"] = (4 - 34 * wake, -4 * wake, -4 * wake)
    base["props"][0]["alpha"] = 1.0 - p
    base["fx"][0]["alpha"] = 1.0 - p
    return base


# ===================== 注册表 =====================
CLIPS: Dict[str, dict] = {
    "idle_breathe": {"duration": 8.0, "loop": True, "fn": idle_breathe},
    "idle_look": {"duration": 8.0, "loop": True, "fn": idle_look},
    "idle_tail": {"duration": 8.0, "loop": True, "fn": idle_tail},
    "turn_hop": {"duration": 1.2, "loop": False, "fn": turn_hop},
    "drag_hold": {"duration": 4.0, "loop": True, "fn": drag_hold},
    "click_happy": {"duration": 2.8, "loop": False, "fn": click_happy},
    "click_shy": {"duration": 3.0, "loop": False, "fn": click_shy},
    "click_angry": {"duration": 2.6, "loop": False, "fn": click_angry},
    "click_surprised": {"duration": 2.4, "loop": False, "fn": click_surprised},
    "click_wave": {"duration": 3.0, "loop": False, "fn": click_wave},
    "walk_slow": {"duration": 4.0, "loop": False, "fn": walk_slow},
    "walk_fast": {"duration": 3.0, "loop": False, "fn": walk_fast},
    "walk_tiptoe": {"duration": 3.5, "loop": False, "fn": walk_tiptoe},
    "stretch": {"duration": 4.0, "loop": False, "fn": stretch},
    "yawn": {"duration": 3.5, "loop": False, "fn": yawn},
    "fix_hair": {"duration": 4.0, "loop": False, "fn": fix_hair},
    "swing_legs": {"duration": 3.5, "loop": False, "fn": swing_legs},
    "play_cube": {"duration": 4.0, "loop": False, "fn": play_cube},
    "play_game": {"duration": 4.0, "loop": False, "fn": play_game},
    "peek": {"duration": 3.0, "loop": False, "fn": peek},
    "eat_rice": {"duration": 4.0, "loop": False, "fn": eat_rice},
    "eat_snack": {"duration": 3.5, "loop": False, "fn": eat_snack},
    "drink": {"duration": 3.5, "loop": False, "fn": drink},
    "summer_fan": {"duration": 4.0, "loop": False, "fn": summer_fan},
    "autumn_leaf": {"duration": 4.0, "loop": False, "fn": autumn_leaf},
    "winter_shiver": {"duration": 3.5, "loop": False, "fn": winter_shiver},
    "read_book": {"duration": 4.0, "loop": False, "fn": read_book},
    "write_note": {"duration": 4.0, "loop": False, "fn": write_note},
    "think_pose": {"duration": 3.5, "loop": False, "fn": think_pose},
    "work_thinking": {"duration": 4.0, "loop": True, "fn": work_thinking},
    "work_working": {"duration": 4.0, "loop": True, "fn": work_working},
    "work_result": {"duration": 3.5, "loop": True, "fn": work_result},
    "work_waiting": {"duration": 4.0, "loop": True, "fn": work_waiting},
    "work_success": {"duration": 3.0, "loop": False, "fn": work_success},
    "work_error": {"duration": 4.0, "loop": True, "fn": work_error},
    "whisper_soft": {"duration": 3.0, "loop": False, "fn": whisper_soft},
    "whisper_think": {"duration": 3.0, "loop": False, "fn": whisper_think},
    "whisper_look": {"duration": 3.0, "loop": False, "fn": whisper_look},
    "sleep_start": {"duration": 2.5, "loop": False, "fn": sleep_start},
    "sleep_loop": {"duration": 8.0, "loop": True, "fn": sleep_loop},
    "sleep_end": {"duration": 2.5, "loop": False, "fn": sleep_end},
}


def get_clip(name: str) -> dict:
    return CLIPS[name]


def all_names() -> List[str]:
    return list(CLIPS.keys())
