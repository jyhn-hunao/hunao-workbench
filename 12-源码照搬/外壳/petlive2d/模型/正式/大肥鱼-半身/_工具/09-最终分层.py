import os, glob
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont
from scipy import ndimage
from psd_tools import PSDImage

ROOT = r"D:\codeData\myself\luanyujia-workbench\12-源码照搬\外壳\petlive2d\模型\正式\大肥鱼-半身"
SRC = r"D:\codeData\myself\luanyujia-workbench\12-源码照搬\外壳\pet3d\概念\07-气氛图.png"
GEN = os.path.join(ROOT, "_工具", "生成层")
OUT = os.path.join(ROOT, "分层PNG")
os.makedirs(OUT, exist_ok=True)

src = Image.open(SRC).convert("RGB")
arr = np.asarray(src).astype(np.uint8)
h, w, _ = arr.shape
R = arr[:, :, 0].astype(np.int16); G = arr[:, :, 1].astype(np.int16); B = arr[:, :, 2].astype(np.int16)
skin = (R > 150) & (G > 100) & (B > 80) & (R > G + 8) & (G > B + 3)
blue = (B > R + 5) & (B > 55) & (G > 25)
hairblue = ((B > R + 5) & (B > 45) & (G > 20)) | ((B > 120) & (G > 140) & (B > 180))

def polygon(points, blur=1.2):
    m = Image.new("L", (w, h), 0)
    ImageDraw.Draw(m).polygon(points, fill=255)
    if blur:
        m = m.filter(ImageFilter.GaussianBlur(blur))
    return np.asarray(m).astype(np.float32) / 255.0

def soft(mask, blur=1.2):
    b = mask > 0.5
    a = ndimage.gaussian_filter(b.astype(np.float32), blur)
    return np.clip(a, 0, 1)

def keep_largest(mask):
    b = mask > 0.5
    lab, n = ndimage.label(b)
    if n == 0:
        return mask
    sizes = ndimage.sum(b, lab, range(1, n + 1))
    return (lab == (np.argmax(sizes) + 1)).astype(np.float32)

def remove_small(mask, min_area=1500):
    b = mask > 0.5
    lab, n = ndimage.label(b)
    if n == 0:
        return mask
    sizes = ndimage.sum(b, lab, range(1, n + 1))
    keep = np.zeros_like(b)
    for i, s in enumerate(sizes, 1):
        if s >= min_area:
            keep |= (lab == i)
    return keep.astype(np.float32)

def key_green(path, do_largest=False, min_area=0, fill_holes=False, blur=1.0):
    im = Image.open(path).convert("RGB")
    a = np.asarray(im).astype(np.float32)
    edge = np.concatenate([a[:8].reshape(-1, 3), a[-8:].reshape(-1, 3), a[:, :8].reshape(-1, 3), a[:, -8:].reshape(-1, 3)])
    key = np.median(edge, axis=0)
    dist = np.sqrt(((a - key) ** 2).sum(axis=2))
    alpha = np.clip((dist - 30) / 60, 0, 1)
    # 明确剔除绿幕色（G 远高于 R/B），比距离阈值更干净
    gbad = (a[:, :, 1] > a[:, :, 0] + 35) & (a[:, :, 1] > a[:, :, 2] + 35) & (a[:, :, 1] > 90)
    alpha[gbad] = 0
    b = alpha > 0.35
    if fill_holes:
        b = ndimage.binary_fill_holes(b)
    if min_area:
        b = remove_small(b.astype(np.float32), min_area) > 0.5
    if do_largest:
        b = keep_largest(b.astype(np.float32)) > 0.5
    alpha = ndimage.gaussian_filter(b.astype(np.float32), blur)
    rgb = a.copy()
    spill = alpha < 0.98
    over = rgb[:, :, 1] > np.maximum(rgb[:, :, 0], rgb[:, :, 2]) + 3
    rgb[:, :, 1] = np.where(spill & over, np.maximum(rgb[:, :, 0], rgb[:, :, 2]), rgb[:, :, 1])
    return Image.fromarray(np.dstack([np.clip(rgb, 0, 255).astype(np.uint8), (np.clip(alpha, 0, 1) * 255).astype(np.uint8)]), "RGBA")

def cut_original(mask, blur=1.0):
    a = np.clip(mask, 0, 1)
    rgba = np.dstack([arr, (a * 255).astype(np.uint8)])
    return Image.fromarray(rgba, "RGBA")

# ---------- AI 大层 ----------
tail = key_green(os.path.join(GEN, "尾巴-绿幕.png"), do_largest=True, fill_holes=True, blur=1.0)
hairback = key_green(os.path.join(GEN, "头发后-绿幕.png"), min_area=2500, fill_holes=False, blur=1.0)
body = key_green(os.path.join(GEN, "身体-绿幕.png"), do_largest=True, fill_holes=True, blur=1.0)
head = key_green(os.path.join(GEN, "头部-绿幕.png"), min_area=0, fill_holes=True, blur=1.0)

# ---------- 原图保真切片：前发（呆毛+刘海）、眼、嘴 ----------
ahoge = [(300,110),(340,115),(380,145),(420,175),(470,195),(520,205),(540,185),(515,155),(480,125),
         (440,95),(400,80),(360,85),(330,95)]
bangs = [(280,300),(340,270),(400,255),(460,250),(520,255),(580,265),(640,285),(700,315),(750,355),
         (790,410),(805,470),(790,530),(760,580),(730,620),(720,650),(680,660),(640,650),(600,620),
         (560,590),(520,570),(480,565),(440,575),(400,600),(370,640),(350,680),(330,720),(310,700),
         (295,650),(285,580),(280,500),(275,420)]
front_mask = (blue & ((polygon(ahoge, 0) + polygon(bangs, 0)) > 0))
front_mask = remove_small(front_mask.astype(np.float32), 300) > 0.5
front_mask = ndimage.binary_closing(front_mask, structure=np.ones((3, 3)))
front_mask = ndimage.gaussian_filter(front_mask.astype(np.float32), 1.2)
front = cut_original(front_mask, 1.0)

eyeL_poly = [(335,640),(350,600),(380,575),(420,560),(460,565),(490,590),(505,630),(500,680),(475,715),
             (430,730),(385,725),(350,705),(335,675)]
eyeR_poly = [(560,620),(575,585),(610,565),(650,560),(690,575),(720,600),(735,640),(730,690),(705,720),
             (665,735),(625,730),(590,710),(570,675)]
mouth_poly = [(495,735),(530,718),(570,712),(610,718),(645,740),(655,770),(640,800),(600,815),(555,815),
              (515,800),(495,770)]

eyeL = cut_original(((polygon(eyeL_poly, 1.5) > 0.3) & (~skin)), 1.0)
eyeR = cut_original(((polygon(eyeR_poly, 1.5) > 0.3) & (~skin)), 1.0)
mouth = cut_original(((polygon(mouth_poly, 1.5) > 0.3) & (~skin)), 1.0)

layers = [
    ("01_尾巴", tail),
    ("02_头发后", hairback),
    ("03_身体", body),
    ("04_头", head),
    ("05_左眼", eyeL),
    ("06_右眼", eyeR),
    ("07_嘴", mouth),
    ("08_头发前", front),
]
for name, img in layers:
    img.save(os.path.join(OUT, name + ".png"))

# ---------- 合成 ----------
comp = Image.new("RGBA", (w, h), (0, 0, 0, 0))
for name, img in layers:
    comp.alpha_composite(img)
comp.save(os.path.join(ROOT, "合成预览-透明.png"))

checker = Image.new("RGB", (w, h), (255, 255, 255))
d = ImageDraw.Draw(checker)
step = 40
for y in range(0, h, step):
    for x in range(0, w, step):
        if (x // step + y // step) % 2 == 0:
            d.rectangle([x, y, x + step - 1, y + step - 1], fill=(225, 225, 225))
checker = checker.convert("RGBA")
checker.alpha_composite(comp)
checker.convert("RGB").save(os.path.join(ROOT, "合成预览-棋盘.png"))

# PSD，底 → 顶
psd = PSDImage.new("RGB", (w, h), color=(255, 255, 255))
for name, img in layers:
    psd.create_pixel_layer(img, name=name)
psd_path = os.path.join(ROOT, "大肥鱼-半身.psd")
psd.save(psd_path)

# 缩略图
try:
    font = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 18)
except Exception:
    font = ImageFont.load_default()
thumb_w = 300
cols = 3
cell_h = int(thumb_w * h / w) + 32
sheet = Image.new("RGB", (cols * (thumb_w + 12) + 12, ((len(layers) + cols - 1) // cols) * (cell_h + 12) + 12), (255, 255, 255))
dd = ImageDraw.Draw(sheet)
for i, (name, img) in enumerate(layers):
    th = cell_h - 32
    bg = checker.copy().convert("RGB").resize((thumb_w, th), Image.LANCZOS)
    small = img.resize((thumb_w, th), Image.LANCZOS)
    bg.paste(small, (0, 0), small)
    x = 12 + (i % cols) * (thumb_w + 12)
    y = 12 + (i // cols) * (cell_h + 12)
    sheet.paste(bg, (x, y + 26))
    dd.text((x, y + 2), name, fill=(0, 0, 0), font=font)
sheet.save(os.path.join(ROOT, "分层预览.png"))

for name, img in layers:
    a = np.asarray(img.getchannel("A"))
    ys, xs = np.where(a > 20)
    print(name, "bbox", (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())) if len(xs) else None, "px", int((a > 20).sum()))
print("PSD", psd_path, os.path.getsize(psd_path))
print("comp", os.path.join(ROOT, "合成预览-棋盘.png"))
