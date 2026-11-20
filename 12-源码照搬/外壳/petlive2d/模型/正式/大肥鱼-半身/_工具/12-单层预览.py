import os
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = r"D:\codeData\myself\luanyujia-workbench\12-源码照搬\外壳\petlive2d\模型\正式\大肥鱼-半身"
OUT = os.path.join(ROOT, "分层PNG")
DST = os.path.join(ROOT, "_工具", "单层检查")
os.makedirs(DST, exist_ok=True)

def checker(w_, h_, step=24):
    a = np.zeros((h_, w_, 3), dtype=np.uint8)
    yy, xx = np.mgrid[0:h_, 0:w_]
    a[(yy // step + xx // step) % 2 == 0] = 245
    a[(yy // step + xx // step) % 2 == 1] = 210
    return Image.fromarray(a, "RGB").convert("RGBA")

files = ["04_脸.png", "05_左眼.png", "06_右眼.png", "07_嘴.png", "08_头发前.png", "09_头饰.png"]
try:
    font = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 20)
except Exception:
    font = ImageFont.load_default()
for f in files:
    im = Image.open(os.path.join(OUT, f)).convert("RGBA")
    a = np.asarray(im.getchannel("A"))
    ys, xs = np.where(a > 20)
    if len(xs) == 0:
        continue
    pad = 80
    x0, y0 = max(0, xs.min()-pad), max(0, ys.min()-pad)
    x1, y1 = min(im.width, xs.max()+pad), min(im.height, ys.max()+pad)
    crop = im.crop((x0, y0, x1, y1))
    bg = checker(crop.width, crop.height)
    bg.alpha_composite(crop)
    canvas = Image.new("RGB", (bg.width, bg.height + 34), (255, 255, 255))
    canvas.paste(bg.convert("RGB"), (0, 34))
    d = ImageDraw.Draw(canvas)
    d.text((8, 6), f"{f}  bbox={x0},{y0},{x1},{y1}", fill=(0, 0, 0), font=font)
    canvas.save(os.path.join(DST, f.replace(".png", "-单层.png")))
    print("saved", os.path.join(DST, f.replace(".png", "-单层.png")))
