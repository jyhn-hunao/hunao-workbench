import os
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = r"D:\codeData\myself\luanyujia-workbench\12-源码照搬\外壳\petlive2d\模型\正式\大肥鱼-半身"
SRC = r"D:\codeData\myself\luanyujia-workbench\12-源码照搬\外壳\pet3d\概念\07-气氛图.png"
GEN = os.path.join(ROOT, "_工具", "生成层")
OUT = os.path.join(ROOT, "_工具", "生成层-透明")
base = Image.open(SRC).convert("RGBA")

def key_black(src):
    im = Image.open(src).convert("RGB")
    a = np.asarray(im).astype(np.float32)
    # 黑底键控：用亮度 + 颜色距离；保留深色睫毛
    mx = a.max(axis=2)
    alpha = np.clip((mx - 4) / 26.0, 0, 1)
    alpha = np.asarray(Image.fromarray((alpha * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.5)).astype(np.float32) if False else Image.fromarray((alpha * 255).astype(np.uint8))).astype(np.float32) / 255.0
    rgba = np.dstack([a.astype(np.uint8), (alpha * 255).astype(np.uint8)])
    return Image.fromarray(rgba, "RGBA")

def key_black2(src):
    im = Image.open(src).convert("RGB")
    a = np.asarray(im).astype(np.float32)
    mx = a.max(axis=2)
    alpha = np.clip((mx - 4) / 26.0, 0, 1)
    alpha_img = Image.fromarray((alpha * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.5))
    alpha = np.asarray(alpha_img).astype(np.float32) / 255.0
    rgba = np.dstack([a.astype(np.uint8), (alpha * 255).astype(np.uint8)])
    return Image.fromarray(rgba, "RGBA")

def overlay(name, img):
    a = np.asarray(img.getchannel("A"))
    ys, xs = np.where(a > 20)
    bbox = (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())) if len(xs) else None
    red = Image.new("RGBA", img.size, (255, 0, 0, 0))
    red.putalpha(img.getchannel("A").point(lambda x: int(x * 0.55)))
    o = base.copy()
    o.alpha_composite(red)
    print(name, "bbox", bbox, "alpha>20", int((a > 20).sum()))
    return o

items = []
items.append(("右眼-透明", Image.open(os.path.join(GEN, "右眼-透明原图.png")).convert("RGBA")))
items.append(("左眼-黑底键控", key_black2(os.path.join(GEN, "左眼-透明原图.png"))))
items.append(("嘴-黑底键控", key_black2(os.path.join(GEN, "嘴-透明原图.png"))))
for n, img in items:
    img.save(os.path.join(OUT, n + ".png"))
    items[items.index((n, img))] = (n, img)
    overlay(n, img)

try:
    font = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 18)
except Exception:
    font = ImageFont.load_default()

thumb_w = 300
rows = []
for n, img in items:
    red = Image.new("RGBA", img.size, (255, 0, 0, 0))
    red.putalpha(img.getchannel("A").point(lambda x: int(x * 0.55)))
    o = base.copy(); o.alpha_composite(red)
    rows.append((n, o, img))

cell_h = int(thumb_w * base.height / base.width) + 30
sheet = Image.new("RGB", (2 * (thumb_w + 12) + 12, ((len(rows) + 1) // 2) * (cell_h + 12) + 12), (255, 255, 255))
d = ImageDraw.Draw(sheet)
for i, (n, o, img) in enumerate(rows):
    small = o.convert("RGB").resize((thumb_w, cell_h - 30), Image.LANCZOS)
    x = 12 + (i % 2) * (thumb_w + 12)
    y = 12 + (i // 2) * (cell_h + 12)
    sheet.paste(small, (x, y + 26))
    d.text((x, y + 2), n, fill=(0, 0, 0), font=font)
sheet.save(os.path.join(ROOT, "_工具", "对齐检查-眼嘴.png"))
print("sheet", os.path.join(ROOT, "_工具", "对齐检查-眼嘴.png"))
