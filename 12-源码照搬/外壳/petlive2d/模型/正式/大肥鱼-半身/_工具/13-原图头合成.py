import os
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy import ndimage
from psd_tools import PSDImage

ROOT = r"D:\codeData\myself\luanyujia-workbench\12-源码照搬\外壳\petlive2d\模型\正式\大肥鱼-半身"
SRC = r"D:\codeData\myself\luanyujia-workbench\12-源码搬\外壳\pet3d\概念\07-气氛图.png"
# 修正上一条笔误路径
SRC = r"D:\codeData\myself\luanyujia-workbench\12-源码照搬\外壳\pet3d\概念\07-气氛图.png"
OUT = os.path.join(ROOT, "分层PNG")
os.makedirs(OUT, exist_ok=True)
src = Image.open(SRC).convert("RGB")
arr = np.asarray(src).astype(np.uint8)
h, w, _ = arr.shape

def poly(points, blur=1.2):
    m = Image.new("L", (w, h), 0)
    ImageDraw.Draw(m).polygon(points, fill=255)
    if blur:
        m = m.filter(ImageFilter.GaussianBlur(blur))
    return np.asarray(m).astype(np.float32) / 255.0

def alpha_bbox(img):
    a = np.asarray(img.getchannel("A"))
    ys, xs = np.where(a > 20)
    return (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())) if len(xs) else None

fg_path = os.path.join(ROOT, "_工具", "前景-手动-遮罩.png")
fg = np.asarray(Image.open(fg_path).convert("L")).astype(np.float32) / 255.0 if os.path.exists(fg_path) else None

head_core = [(280,100),(340,100),(400,130),(470,160),(540,190),(610,220),(680,250),(750,280),(820,320),
             (880,370),(930,430),(970,500),(1000,580),(1015,660),(1015,760),(1000,820),(970,860),(930,880),
             (880,870),(830,840),(780,820),(730,810),(680,820),(630,840),(580,855),(530,855),(480,845),
             (430,830),(380,810),(340,790),(300,760),(260,720),(220,660),(180,600),(140,540),(100,500),
             (65,520),(55,580),(60,650),(75,720),(95,790),(115,840),(140,860),(170,850),(200,820),(230,780),
             (260,730),(285,680),(300,620),(305,550),(300,480),(290,410),(280,330),(285,250),(295,180)]
hairL = [(60,520),(50,600),(45,700),(50,800),(60,900),(80,1000),(110,1080),(150,1140),(200,1160),(250,1140),
         (290,1080),(310,1000),(320,920),(330,840),(330,760),(320,680),(300,620),(280,580),(250,560),(220,570),
         (190,600),(160,650),(130,720),(110,800),(95,900),(85,1000),(75,1080),(65,1120),(55,1080),(50,980),
         (55,850),(65,720),(75,600)]
hairR = [(750,540),(760,620),(770,700),(780,800),(800,900),(820,1000),(850,1080),(890,1140),(940,1160),(990,1140),
         (1020,1080),(1040,1000),(1050,920),(1050,840),(1040,760),(1020,680),(990,620),(950,580),(910,560),(880,570),
         (850,600),(830,650),(810,720),(800,800),(800,900),(810,1000),(830,1080),(860,1120),(890,1080),(900,1000),
         (900,900),(890,800),(870,720),(850,650)]

def clean(mask, blur=1.0):
    b = mask > 0.4
    b = ndimage.binary_closing(b, structure=np.ones((3, 3)))
    b = ndimage.binary_fill_holes(b)
    return np.clip(ndimage.gaussian_filter(b.astype(np.float32), blur), 0, 1)

core = clean((poly(head_core, 1.0) > 0.3) & ((fg > 0.3) if fg is not None else True), 1.0)
left = clean((poly(hairL, 1.0) > 0.3) & ((fg > 0.3) if fg is not None else True), 1.0)
right = clean((poly(hairR, 1.0) > 0.3) & ((fg > 0.3) if fg is not None else True), 1.0)
head_mask = np.clip(core + left + right, 0, 1)
# fg 遮罩边缘偏松，会把背景浅色描边带进来；向内收 3px 再去羽化，去掉白边
head_mask = ndimage.binary_erosion(head_mask > 0.5, structure=np.ones((3, 3)), iterations=3).astype(np.float32)
head_mask = ndimage.gaussian_filter(head_mask, 1.0)
head = Image.fromarray(np.dstack([arr, (head_mask * 255).astype(np.uint8)]), "RGBA")
head.save(os.path.join(OUT, "04_头-原图.png"))
print("head bbox", alpha_bbox(head))

# 合成：尾巴 / 后发 / 身体 / 原图头
tail = Image.open(os.path.join(OUT, "01_尾巴.png")).convert("RGBA")
hairback = Image.open(os.path.join(OUT, "02_头发后.png")).convert("RGBA")
body = Image.open(os.path.join(OUT, "03_身体.png")).convert("RGBA")
comp = Image.new("RGBA", (w, h), (0, 0, 0, 0))
for im in [tail, hairback, body, head]:
    comp.alpha_composite(im)
comp.save(os.path.join(ROOT, "方案B-合成预览-透明.png"))
checker = Image.new("RGB", (w, h), (255, 255, 255))
d = ImageDraw.Draw(checker)
step = 40
for y in range(0, h, step):
    for x in range(0, w, step):
        if (x // step + y // step) % 2 == 0:
            d.rectangle([x, y, x + step - 1, y + step - 1], fill=(225, 225, 225))
checker = checker.convert("RGBA")
checker.alpha_composite(comp)
checker.convert("RGB").save(os.path.join(ROOT, "方案B-合成预览-棋盘.png"))

# 4 层 PSD
psd = PSDImage.new("RGB", (w, h), color=(255, 255, 255))
mapping = [("01_tail", tail), ("02_hair_back", hairback), ("03_body", body), ("04_head", head)]
for name, im in mapping:
    psd.create_pixel_layer(im, name=name)
psd_path = os.path.join(ROOT, "大肥鱼-半身-四层.psd")
psd.save(psd_path)
print("PSD", psd_path, os.path.getsize(psd_path))
