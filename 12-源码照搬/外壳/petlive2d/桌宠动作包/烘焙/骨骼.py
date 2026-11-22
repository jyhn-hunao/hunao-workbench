# -*- coding: utf-8 -*-
"""把现有 9 层 PNG 变成 640×360 桌面舞台上的可动骨骼。

不依赖 Cubism：每一层按自己的支点做旋转 / 位移 / 缩放，再按原顺序合成。
默认帧不含 faceClosed / mouthClosed，保持当前面板首帧的原画样子。
"""
from __future__ import annotations

import json
import math
import os
from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from PIL import Image, ImageDraw, ImageFilter, ImageFont

STAGE_W = 640
STAGE_H = 360
FEET_Y = 330
BODY_CENTER_X = 320
# dsh-pet 的命中框；角色本体必须落在这里，否则点不到 / 拖不动
HIT_BOX = (200, 50, 440, 335)
# 原画可见范围（九层合成后的非透明 bbox）
NATIVE_BBOX = (68, 107, 1251, 1782)
BODY_H = 280.0
SCALE = BODY_H / (NATIVE_BBOX[3] - NATIVE_BBOX[1])
BASE_LEFT = int(round(BODY_CENTER_X - ((NATIVE_BBOX[0] + NATIVE_BBOX[2]) / 2) * SCALE))
BASE_TOP = int(round(FEET_Y - NATIVE_BBOX[3] * SCALE))
CANVAS_W = int(round(1254 * SCALE))
CANVAS_H = int(round(1881 * SCALE))

# 从 桌宠动作包/烘焙/骨骼.py 往上：烘焙 -> 桌宠动作包 -> petlive2d
PET_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MODEL_ROOT = os.path.join(PET_ROOT, "模型")
CONFIG_PATH = os.path.join(MODEL_ROOT, "当前.json")
PACK_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


@dataclass
class Layer:
    name: str
    image: Image.Image          # 裁好的 RGBA 小图
    offset: Tuple[int, int]     # 小图左上角在舞台上的位置
    pivot: Tuple[float, float]  # 支点在小图坐标系里的位置


def _alpha_bbox(im: Image.Image, threshold: int = 12) -> Optional[Tuple[int, int, int, int]]:
    a = im.getchannel("A").point(lambda v: 255 if v > threshold else 0)
    return a.getbbox()


def _soft_mask(size: Tuple[int, int], inset: int, radius: int, blur: int) -> Image.Image:
    w, h = size
    mask = Image.new("L", size, 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle((inset, inset, w - inset - 1, h - inset - 1), radius=radius, fill=255)
    if blur:
        mask = mask.filter(ImageFilter.GaussianBlur(blur))
    return mask


def _prepare_overlay_alpha(im: Image.Image) -> Image.Image:
    """去掉闭眼/闭嘴补层自带的柔边矩形底，只留中间的脸/嘴。

    入参是已经放到 640×360 舞台坐标上的整张图层；返回同尺寸，不裁切。
    这样后面的 _crop_with_pad 仍能拿到正确的舞台偏移。
    """
    bbox = _alpha_bbox(im, 8)
    if not bbox:
        return im
    x0, y0, x1, y1 = bbox
    w, h = x1 - x0, y1 - y0
    inset = 8 if w > 200 else 4
    mask = Image.new("L", im.size, 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle((x0 + inset, y0 + inset, x1 - inset - 1, y1 - inset - 1),
                        radius=max(8, min(w, h) // 6), fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(10 if w > 200 else 6))
    im = im.copy()
    im.putalpha(Image.composite(im.getchannel("A"), Image.new("L", im.size, 0), mask))
    return im


def _crop_with_pad(im: Image.Image, pivot_global: Tuple[float, float], pad: int) -> Layer:
    bb = _alpha_bbox(im, 8)
    if not bb:
        return Layer("", Image.new("RGBA", (1, 1), (0, 0, 0, 0)), (0, 0), (0, 0))
    x0 = max(0, bb[0] - pad)
    y0 = max(0, bb[1] - pad)
    x1 = min(im.width, bb[2] + pad)
    y1 = min(im.height, bb[3] + pad)
    crop = im.crop((x0, y0, x1, y1))
    return Layer("", crop, (x0, y0), (pivot_global[0] - x0, pivot_global[1] - y0))


class Rig:
    def __init__(self, props_dir: Optional[str] = None):
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        self.cfg = cfg
        self.layers: Dict[str, Layer] = {}
        self.draw_order: List[str] = []
        for item in cfg["layers"]:
            name = item["name"]
            src = os.path.join(MODEL_ROOT, item["src"])
            im = Image.open(src).convert("RGBA").resize((CANVAS_W, CANVAS_H), Image.LANCZOS)
            stage_im = Image.new("RGBA", (STAGE_W, STAGE_H), (0, 0, 0, 0))
            stage_im.alpha_composite(im, (BASE_LEFT, BASE_TOP))
            im = stage_im
            if name in ("faceClosed", "mouthClosed"):
                im = _prepare_overlay_alpha(im)
            px = float(item["pivot"][0]) * SCALE + BASE_LEFT
            py = float(item["pivot"][1]) * SCALE + BASE_TOP
            pad = 56 if name == "head" else (40 if name == "body" else 28)
            layer = _crop_with_pad(im, (px, py), pad)
            layer.name = name
            self.layers[name] = layer
            self.draw_order.append(name)
        self.props: Dict[str, Image.Image] = {}
        if props_dir and os.path.isdir(props_dir):
            for fn in os.listdir(props_dir):
                if fn.lower().endswith(".png"):
                    im = Image.open(os.path.join(props_dir, fn)).convert("RGBA")
                    self.props[os.path.splitext(fn)[0]] = im
        self._font_path = r"C:\Windows\Fonts\msyh.ttc"
        self._font_cache: Dict[int, ImageFont.FreeTypeFont] = {}

    def font(self, size: int) -> ImageFont.FreeTypeFont:
        if size not in self._font_cache:
            try:
                self._font_cache[size] = ImageFont.truetype(self._font_path, size)
            except Exception:
                self._font_cache[size] = ImageFont.load_default()
        return self._font_cache[size]

    @staticmethod
    def _affine(im: Image.Image, pivot: Tuple[float, float], rot_deg: float,
                dx: float, dy: float, sx: float, sy: float) -> Image.Image:
        if abs(rot_deg) < 1e-6 and abs(sx - 1) < 1e-6 and abs(sy - 1) < 1e-6 and abs(dx) < 1e-6 and abs(dy) < 1e-6:
            return im
        th = math.radians(rot_deg)
        cos, sin = math.cos(th), math.sin(th)
        a = cos / sx
        b = sin / sy
        d = -sin / sx
        e = cos / sy
        c = pivot[0] - a * (pivot[0] + dx) - b * (pivot[1] + dy)
        f = pivot[1] - d * (pivot[0] + dx) - e * (pivot[1] + dy)
        return im.transform(im.size, Image.AFFINE, (a, b, c, d, e, f), resample=Image.BICUBIC)

    def _part(self, stage: Image.Image, name: str, rot: float, dx: float, dy: float,
              sx: float = 1.0, sy: float = 1.0, alpha: float = 1.0) -> None:
        layer = self.layers.get(name)
        if not layer or layer.image.width <= 1:
            return
        im = self._affine(layer.image, layer.pivot, rot, dx, dy, sx, sy)
        if alpha < 0.999:
            if alpha <= 0.001:
                return
            im = im.copy()
            im.putalpha(im.getchannel("A").point(lambda v: int(v * alpha)))
        stage.alpha_composite(im, layer.offset)

    def _global(self, stage: Image.Image, dx: float, dy: float, rot: float,
                sx: float, sy: float) -> Image.Image:
        if abs(dx) < 1e-6 and abs(dy) < 1e-6 and abs(rot) < 1e-6 and abs(sx - 1) < 1e-6 and abs(sy - 1) < 1e-6:
            return stage
        return self._affine(stage, (BODY_CENTER_X, FEET_Y), rot, dx, dy, sx, sy)

    def prop(self, stage: Image.Image, name: str, center: Tuple[float, float],
             max_w: float, max_h: float, rot: float = 0.0, alpha: float = 1.0,
             anchor: str = "center") -> None:
        im = self.props.get(name)
        if im is None:
            return
        bb = _alpha_bbox(im, 20)
        if bb:
            im = im.crop(bb)
        k = min(max_w / im.width, max_h / im.height)
        im = im.resize((max(1, int(round(im.width * k))), max(1, int(round(im.height * k))), ), Image.LANCZOS)
        if abs(rot) > 1e-6:
            im = im.rotate(rot, resample=Image.BICUBIC, expand=True)
        if alpha < 0.999:
            im = im.copy()
            im.putalpha(im.getchannel("A").point(lambda v: int(v * alpha)))
        if anchor == "bottom":
            x = int(round(center[0] - im.width / 2))
            y = int(round(center[1] - im.height))
        else:
            x = int(round(center[0] - im.width / 2))
            y = int(round(center[1] - im.height / 2))
        stage.alpha_composite(im, (x, y))

    def fx_text(self, stage: Image.Image, text: str, pos: Tuple[int, int], size: int,
                fill: Tuple[int, int, int, int], stroke: int = 0) -> None:
        d = ImageDraw.Draw(stage)
        d.text(pos, text, font=self.font(size), fill=fill, stroke_width=stroke,
               stroke_fill=(255, 255, 255, 180))

    def fx_blush(self, stage: Image.Image, alpha: float) -> None:
        if alpha <= 0:
            return
        ov = Image.new("RGBA", (STAGE_W, STAGE_H), (0, 0, 0, 0))
        d = ImageDraw.Draw(ov)
        a = int(110 * alpha)
        for x, y, w, h in ((282, 166, 22, 10), (344, 166, 22, 10)):
            d.ellipse((x, y, x + w, y + h), fill=(255, 142, 165, a))
        ov = ov.filter(ImageFilter.GaussianBlur(5))
        stage.alpha_composite(ov)

    def fx_sweat(self, stage: Image.Image, pos: Tuple[int, int], alpha: float = 1.0) -> None:
        if alpha <= 0:
            return
        ov = Image.new("RGBA", (STAGE_W, STAGE_H), (0, 0, 0, 0))
        d = ImageDraw.Draw(ov)
        x, y = pos
        a = int(210 * alpha)
        d.polygon([(x, y - 14), (x - 7, y + 2), (x + 7, y + 2)], fill=(120, 200, 245, a))
        d.ellipse((x - 7, y - 4, x + 7, y + 10), fill=(120, 200, 245, a))
        d.ellipse((x - 4, y - 1, x - 0, y + 4), fill=(255, 255, 255, int(160 * alpha)))
        stage.alpha_composite(ov)

    def fx_anger(self, stage: Image.Image, pos: Tuple[int, int], alpha: float = 1.0) -> None:
        if alpha <= 0:
            return
        ov = Image.new("RGBA", (STAGE_W, STAGE_H), (0, 0, 0, 0))
        d = ImageDraw.Draw(ov)
        x, y = pos
        a = int(220 * alpha)
        for i in range(4):
            ang = math.radians(45 + i * 90)
            x2, y2 = x + 11 * math.cos(ang), y + 11 * math.sin(ang)
            d.line((x, y, x2, y2), fill=(235, 80, 95, a), width=4)
        stage.alpha_composite(ov)

    def fx_question(self, stage: Image.Image, pos: Tuple[int, int], alpha: float = 1.0) -> None:
        if alpha > 0:
            self.fx_text(stage, "?", pos, 34, (80, 150, 230, int(230 * alpha)), 2)

    def fx_sparkles(self, stage: Image.Image, alpha: float = 1.0) -> None:
        if alpha <= 0:
            return
        ov = Image.new("RGBA", (STAGE_W, STAGE_H), (0, 0, 0, 0))
        d = ImageDraw.Draw(ov)
        a = int(230 * alpha)
        for x, y, r in ((250, 100, 8), (390, 110, 10), (230, 190, 6), (410, 210, 7)):
            d.polygon([(x, y - r), (x + r * 0.3, y - r * 0.3), (x + r, y), (x + r * 0.3, y + r * 0.3),
                       (x, y + r), (x - r * 0.3, y + r * 0.3), (x - r, y), (x - r * 0.3, y - r * 0.3)],
                      fill=(255, 225, 120, a))
        stage.alpha_composite(ov)

    def fx_zzz(self, stage: Image.Image, t: float, alpha: float = 1.0) -> None:
        if alpha <= 0:
            return
        a = int(220 * alpha)
        for i, (x, y, size) in enumerate(((390, 105, 22), (410, 84, 28), (432, 60, 34))):
            phase = (t * 0.125 + i * 0.3) % 1.0
            yy = int(y - phase * 14)
            self.fx_text(stage, "Z", (x, yy), size, (120, 170, 230, int(a * (0.55 + 0.45 * phase))), 2)

    def fx_thought(self, stage: Image.Image, alpha: float = 1.0) -> None:
        if alpha <= 0:
            return
        ov = Image.new("RGBA", (STAGE_W, STAGE_H), (0, 0, 0, 0))
        d = ImageDraw.Draw(ov)
        a = int(200 * alpha)
        for x, y, r in ((380, 112, 7), (394, 96, 10), (412, 76, 14)):
            d.ellipse((x - r, y - r, x + r, y + r), fill=(255, 255, 255, a), outline=(120, 170, 230, a), width=2)
        stage.alpha_composite(ov)

    def fx_snow(self, stage: Image.Image, alpha: float = 1.0) -> None:
        if alpha <= 0:
            return
        ov = Image.new("RGBA", (STAGE_W, STAGE_H), (0, 0, 0, 0))
        d = ImageDraw.Draw(ov)
        a = int(200 * alpha)
        for x, y, r in ((235, 105, 9), (400, 130, 7), (370, 70, 6)):
            for i in range(3):
                ang = math.radians(i * 60)
                d.line((x - r * math.cos(ang), y - r * math.sin(ang),
                        x + r * math.cos(ang), y + r * math.sin(ang)), fill=(150, 200, 245, a), width=2)
        stage.alpha_composite(ov)

    def render(self, pose: dict) -> Image.Image:
        stage = Image.new("RGBA", (STAGE_W, STAGE_H), (0, 0, 0, 0))
        head = pose.get("head", (0, 0, 0))
        body = pose.get("body", (0, 0, 0, 1.0, 1.0))
        armL = pose.get("armL", (0, 0, 0))
        armR = pose.get("armR", (0, 0, 0))
        legL = pose.get("legL", (0, 0, 0))
        legR = pose.get("legR", (0, 0, 0))
        tail = pose.get("tail", (0, 0, 0))
        face = float(pose.get("face", 0.0))
        mouth = float(pose.get("mouth", 0.0))

        # 1. 尾、腿、身体、手臂、头，顺序与当前面板一致
        self._part(stage, "tail", tail[0], tail[1], tail[2])
        self._part(stage, "legL", legL[0], legL[1], legL[2])
        self._part(stage, "legR", legR[0], legR[1], legR[2])
        self._part(stage, "body", body[0], body[1], body[2], body[3], body[4])
        self._part(stage, "armL", armL[0], armL[1], armL[2])
        self._part(stage, "armR", armR[0], armR[1], armR[2])
        self._part(stage, "head", head[0], head[1], head[2])
        # 2. 眨眼整脸层 / 闭嘴层；默认 alpha 0，不污染原画
        self._part(stage, "faceClosed", head[0], head[1], head[2], alpha=max(0.0, min(1.0, face)))
        self._part(stage, "mouthClosed", head[0], head[1], head[2], alpha=max(0.0, min(1.0, mouth)))

        # 3. 道具
        for item in pose.get("props", []):
            self.prop(stage, item["name"], tuple(item["pos"]), item.get("w", 80), item.get("h", 80),
                      item.get("rot", 0.0), item.get("alpha", 1.0), item.get("anchor", "center"))

        # 4. 特效
        for item in pose.get("fx", []):
            kind = item["kind"]
            if kind == "blush":
                self.fx_blush(stage, item.get("alpha", 1.0))
            elif kind == "sweat":
                self.fx_sweat(stage, tuple(item["pos"]), item.get("alpha", 1.0))
            elif kind == "anger":
                self.fx_anger(stage, tuple(item["pos"]), item.get("alpha", 1.0))
            elif kind == "question":
                self.fx_question(stage, tuple(item["pos"]), item.get("alpha", 1.0))
            elif kind == "sparkles":
                self.fx_sparkles(stage, item.get("alpha", 1.0))
            elif kind == "zzz":
                self.fx_zzz(stage, item.get("t", 0.0), item.get("alpha", 1.0))
            elif kind == "thought":
                self.fx_thought(stage, item.get("alpha", 1.0))
            elif kind == "snow":
                self.fx_snow(stage, item.get("alpha", 1.0))
            elif kind == "text":
                self.fx_text(stage, item["text"], tuple(item["pos"]), item.get("size", 24),
                             tuple(item.get("fill", (80, 150, 230, 230))), item.get("stroke", 2))

        # 5. 整体位移 / 倾斜 / 压缩，支点在脚底
        g = pose.get("global", (0.0, 0.0, 0.0, 1.0, 1.0))
        return self._global(stage, g[0], g[1], g[2], g[3], g[4])


def checker_bg(im: Image.Image, size: Tuple[int, int] = (640, 360), cell: int = 16) -> Image.Image:
    bg = Image.new("RGB", size, (245, 245, 245))
    d = ImageDraw.Draw(bg)
    for y in range(0, size[1], cell):
        for x in range(0, size[0], cell):
            if (x // cell + y // cell) % 2:
                d.rectangle((x, y, x + cell - 1, y + cell - 1), fill=(225, 225, 225))
    bg = bg.convert("RGBA")
    bg.alpha_composite(im)
    return bg.convert("RGB")
