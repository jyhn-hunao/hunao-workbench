import os
import numpy as np
from PIL import Image

ROOT = r"D:\codeData\myself\luanyujia-workbench\12-源码照搬\外壳\petlive2d\模型\正式\大肥鱼-半身"
SRC = r"D:\codeData\myself\luanyujia-workbench\12-源码照搬\外壳\pet3d\概念\07-气氛图.png"
LAY = os.path.join(ROOT, "分层PNG")

src = np.asarray(Image.open(SRC).convert("RGB")).astype(np.int16)
R, G, B = src[:, :, 0], src[:, :, 1], src[:, :, 2]
skin = (R > 150) & (G > 100) & (B > 80) & (R > G + 8) & (G > B + 3)
yy, xx = np.mgrid[0:src.shape[0], 0:src.shape[1]]
head_roi = (yy > 400) & (yy < 920) & (xx > 180) & (xx < 950)
ys, xs = np.where(skin & head_roi)
print("orig head skin bbox", xs.min(), ys.min(), xs.max(), ys.max(), "center", (xs.min()+xs.max())/2, (ys.min()+ys.max())/2)

head = np.asarray(Image.open(os.path.join(LAY, "04_头.png")).convert("RGBA"))
a = head[:, :, 3]
rgb = head[:, :, :3].astype(np.int16)
hr, hg, hb = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
hskin = (hr > 140) & (hg > 90) & (hb > 70) & (hr > hg + 5) & (hg > hb + 2) & (a > 60)
ys, xs = np.where(hskin)
print("ai head skin bbox", xs.min(), ys.min(), xs.max(), ys.max(), "center", (xs.min()+xs.max())/2, (ys.min()+ys.max())/2)
ys, xs = np.where(a > 30)
print("ai head alpha bbox", xs.min(), ys.min(), xs.max(), ys.max())

body = np.asarray(Image.open(os.path.join(LAY, "03_身体.png")).convert("RGBA"))
ab = body[:, :, 3]
ys, xs = np.where(ab > 30)
print("ai body alpha bbox", xs.min(), ys.min(), xs.max(), ys.max())
# 原图身体区域粗估：下半身非背景像素（用饱和度/暗色/白色）
rgb2 = src
sat = (rgb2.max(axis=2) - rgb2.min(axis=2))
bodyish = ((sat > 25) | (rgb2.min(axis=2) > 180)) & (yy > 800) & (yy < 1820) & (xx > 60) & (xx < 950)
# 排除尾巴：尾巴在右侧 x>880
bodyish &= ~((xx > 880) & (yy > 1050))
ys, xs = np.where(bodyish)
print("orig body rough bbox", xs.min(), ys.min(), xs.max(), ys.max())
