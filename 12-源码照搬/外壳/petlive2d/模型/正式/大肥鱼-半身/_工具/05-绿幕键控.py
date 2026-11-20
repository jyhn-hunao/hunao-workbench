import os
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = r"D:\codeData\myself\luanyujia-workbench\12-源码照搬\外壳\petlive2d\模型\正式\大肥鱼-半身"
SRC = r"D:\codeData\myself\luanyujia-workbench\12-源码照搬\外壳\pet3d\概念\07-气氛图.png"
GEN = os.path.join(ROOT, "_工具", "生成层")
OUT = os.path.join(ROOT, "_工具", "生成层-透明")
os.makedirs(OUT, exist_ok=True)

def key_green(src, dst, lo=22, hi=70):
    im = Image.open(src).convert("RGB")
    a = np.asarray(im).astype(np.float32)
    # 用四角与边缘采样确定绿幕基色
    edge = np.concatenate([a[:8].reshape(-1, 3), a[-8:].reshape(-1, 3), a[:, :8].reshape(-1, 3), a[:, -8:].reshape(-1, 3)])
    key = np.median(edge, axis=0)
    dist = np.sqrt(((a - key) ** 2).sum(axis=2))
    alpha = np.clip((dist - lo) / (hi - lo), 0, 1)
    alpha_img = Image.fromarray((alpha * 255).astype(np.uint8))
    alpha_img = alpha_img.filter(ImageFilter.GaussianBlur(0.6))
    alpha = np.asarray(alpha_img).astype(np.float32) / 255.0
    # 去绿边：只压绿色通道，避免把蓝色尾巴压灰
    rgb = a.copy()
    spill = alpha < 0.98
    g_over = rgb[:, :, 1] > np.maximum(rgb[:, :, 0], rgb[:, :, 2]) + 2
    rgb[:, :, 1] = np.where(spill & g_over, np.maximum(rgb[:, :, 0], rgb[:, :, 2]), rgb[:, :, 1])
    rgba = np.dstack([np.clip(rgb, 0, 255).astype(np.uint8), (alpha * 255).astype(np.uint8)])
    Image.fromarray(rgba, "RGBA").save(dst)

key_green(os.path.join(GEN, "尾巴-绿幕.png"), os.path.join(OUT, "尾巴-透明.png"))

# 对齐检查：原图 + 尾巴层红色半透明覆盖
base = Image.open(SRC).convert("RGBA")
tail = Image.open(os.path.join(OUT, "尾巴-透明.png")).convert("RGBA")
red = Image.new("RGBA", tail.size, (255, 0, 0, 0))
red.putalpha(tail.getchannel("A").point(lambda x: int(x * 0.55)))
base.alpha_composite(red)
base.convert("RGB").save(os.path.join(ROOT, "_工具", "对齐检查-尾巴.png"))

alpha = np.asarray(tail.getchannel("A"))
ys, xs = np.where(alpha > 20)
print("tail bbox:", xs.min(), ys.min(), xs.max(), ys.max(), "coverage", (alpha > 20).mean())
print("key sample:", np.median(np.concatenate([np.asarray(Image.open(os.path.join(GEN, '尾巴-绿幕.png')).convert('RGB'))[:8].reshape(-1,3)]), axis=0))
