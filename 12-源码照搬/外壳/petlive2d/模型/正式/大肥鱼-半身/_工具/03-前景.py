import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy import ndimage
import os

SRC = r"D:\codeData\myself\luanyujia-workbench\12-源码照搬\外壳\pet3d\概念\07-气氛图.png"
OUT = r"D:\codeData\myself\luanyujia-workbench\12-源码照搬\外壳\petlive2d\模型\正式\大肥鱼-半身\_工具"
os.makedirs(OUT, exist_ok=True)

im = Image.open(SRC).convert("RGB")
arr = np.asarray(im).astype(np.float32)
h, w, _ = arr.shape

# 1. 用边缘像素拟合一张平滑背景（3 次多项式），再用颜色距离取前景
border = 14
ys, xs = np.mgrid[0:h, 0:w]
edge = (xs < border) | (xs >= w - border) | (ys < border) | (ys >= h - border)
px = xs[edge].astype(np.float64) / w
py = ys[edge].astype(np.float64) / h
terms = np.stack([np.ones_like(px), px, py, px*px, px*py, py*py, px**3, px*px*py, px*py*py, py**3], axis=1)
coef = []
for c in range(3):
    v = arr[:, :, c][edge]
    coef.append(np.linalg.lstsq(terms, v, rcond=None)[0])
bg = np.zeros_like(arr)
gx = (xs.astype(np.float64) / w).ravel()
gy = (ys.astype(np.float64) / h).ravel()
T = np.stack([np.ones_like(gx), gx, gy, gx*gx, gx*gy, gy*gy, gx**3, gx*gx*gy, gx*gy*gy, gy**3], axis=1)
for c in range(3):
    bg[:, :, c] = (T @ coef[c]).reshape(h, w)

dist = np.sqrt(((arr - bg) ** 2).sum(axis=2))
alpha = np.clip((dist - 8.0) / (26.0 - 8.0), 0, 1)
alpha = ndimage.gaussian_filter(alpha, 1.2)

# 2. 闭运算接上描边/白色围裙，再填内部空洞
fg = alpha > 0.38
fg = ndimage.binary_closing(fg, structure=np.ones((5, 5)), iterations=1)
fg = ndimage.binary_fill_holes(fg)
fg = ndimage.binary_opening(fg, structure=np.ones((3, 3)), iterations=1)
# 只保留最大连通块（角色本体），去掉零散背景噪点
lab, n = ndimage.label(fg)
sizes = ndimage.sum(fg, lab, range(1, n + 1))
if len(sizes):
    keep = (np.argmax(sizes) + 1)
    fg = lab == keep
fg = ndimage.gaussian_filter(fg.astype(np.float32), 1.0)
fg = np.clip(fg, 0, 1)

rgba = np.dstack([arr.astype(np.uint8), (fg * 255).astype(np.uint8)])
Image.fromarray(rgba, "RGBA").save(os.path.join(OUT, "前景-手动.png"))

mask = Image.fromarray((fg * 255).astype(np.uint8), "L")
mask.save(os.path.join(OUT, "前景-手动-遮罩.png"))

# 3. 红边预览
prev = arr.astype(np.uint8).copy()
edgepix = (fg > 0.1) & (ndimage.gaussian_filter(fg, 1.5) < 0.9)
prev[edgepix] = [255, 0, 0]
Image.fromarray(prev).save(os.path.join(OUT, "前景-预览.png"))

print("foreground ratio", float(fg.mean()), "max dist", float(dist.max()))
