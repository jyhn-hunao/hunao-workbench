import os, glob
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = r"D:\codeData\myself\luanyujia-workbench\12-源码照搬\外壳\petlive2d\模型\正式\大肥鱼-半身"
SRC = r"D:\codeData\myself\luanyujia-workbench\12-源码照搬\外壳\pet3d\概念\07-气氛图.png"
GEN = os.path.join(ROOT, "_工具", "生成层")
OUT = os.path.join(ROOT, "_工具", "生成层-透明")
os.makedirs(OUT, exist_ok=True)

def key_green(src, dst, lo=22, hi=70):
    im = Image.open(src).convert("RGB")
    a = np.asarray(im).astype(np.float32)
    edge = np.concatenate([a[:8].reshape(-1, 3), a[-8:].reshape(-1, 3), a[:, :8].reshape(-1, 3), a[:, -8:].reshape(-1, 3)])
    key = np.median(edge, axis=0)
    dist = np.sqrt(((a - key) ** 2).sum(axis=2))
    alpha = np.clip((dist - lo) / (hi - lo), 0, 1)
    alpha_img = Image.fromarray((alpha * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.6))
    alpha = np.asarray(alpha_img).astype(np.float32) / 255.0
    rgb = a.copy()
    spill = alpha < 0.98
    g_over = rgb[:, :, 1] > np.maximum(rgb[:, :, 0], rgb[:, :, 2]) + 2
    rgb[:, :, 1] = np.where(spill & g_over, np.maximum(rgb[:, :, 0], rgb[:, :, 2]), rgb[:, :, 1])
    rgba = np.dstack([np.clip(rgb, 0, 255).astype(np.uint8), (alpha * 255).astype(np.uint8)])
    Image.fromarray(rgba, "RGBA").save(dst)
    return key, alpha

files = sorted(glob.glob(os.path.join(GEN, "*绿幕.png")))
base = Image.open(SRC).convert("RGBA")
thumb_w = 300
rows = []
for f in files:
    name = os.path.splitext(os.path.basename(f))[0].replace("-绿幕", "")
    dst = os.path.join(OUT, name + "-透明.png")
    key, alpha = key_green(f, dst)
    ys, xs = np.where(alpha > 0.08)
    print(name, "bbox", (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max()), round(float(alpha.mean()), 3), "key", key.astype(int).tolist()))
    # 对齐检查：原图 + 该层红色 55%
    layer = Image.open(dst).convert("RGBA")
    red = Image.new("RGBA", layer.size, (255, 0, 0, 0))
    red.putalpha(layer.getchannel("A").point(lambda x: int(x * 0.55)))
    over = base.copy()
    over.alpha_composite(red)
    rows.append((name, over))

try:
    font = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 18)
except Exception:
    font = ImageFont.load_default()

cols = 2
cell_w = thumb_w
cell_h = int(thumb_w * base.height / base.width) + 30
sheet = Image.new("RGB", (cols * (cell_w + 12) + 12, ((len(rows) + cols - 1) // cols) * (cell_h + 12) + 12), (255, 255, 255))
d = ImageDraw.Draw(sheet)
for i, (name, over) in enumerate(rows):
    small = over.convert("RGB").resize((thumb_w, cell_h - 30), Image.LANCZOS)
    x = 12 + (i % cols) * (cell_w + 12)
    y = 12 + (i // cols) * (cell_h + 12)
    sheet.paste(small, (x, y + 26))
    d.text((x, y + 2), name, fill=(0, 0, 0), font=font)
sheet.save(os.path.join(ROOT, "_工具", "对齐检查-四层.png"))
print("sheet:", os.path.join(ROOT, "_工具", "对齐检查-四层.png"))
