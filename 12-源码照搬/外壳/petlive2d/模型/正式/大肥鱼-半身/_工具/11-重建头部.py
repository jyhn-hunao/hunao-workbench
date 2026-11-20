import os
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont
from scipy import ndimage
from psd_tools import PSDImage

ROOT = r"D:\codeData\myself\luanyujia-workbench\12-源码照搬\外壳\petlive2d\模型\正式\大肥鱼-半身"
SRC = r"D:\codeData\myself\luanyujia-workbench\12-源码照搬\外壳\pet3d\概念\07-气氛图.png"
OUT = os.path.join(ROOT, "分层PNG")
os.makedirs(OUT, exist_ok=True)
src = Image.open(SRC).convert("RGB")
arr = np.asarray(src).astype(np.uint8)
h, w, _ = arr.shape
R = arr[:, :, 0].astype(np.int16); G = arr[:, :, 1].astype(np.int16); B = arr[:, :, 2].astype(np.int16)
skin = (R > 150) & (G > 100) & (B > 80) & (R > G + 8) & (G > B + 3)
blue = (B > R + 5) & (B > 55) & (G > 25)
white = (R > 185) & (G > 190) & (B > 195) & (abs(R - G) < 22) & (abs(G - B) < 22)

def poly(points, blur=1.0):
    m = Image.new("L", (w, h), 0)
    ImageDraw.Draw(m).polygon(points, fill=255)
    if blur:
        m = m.filter(ImageFilter.GaussianBlur(blur))
    return np.asarray(m).astype(np.float32) / 255.0

def soft(mask, blur=1.0):
    return ndimage.gaussian_filter((mask > 0.5).astype(np.float32), blur)

def transform(img, sx, sy, dx, dy):
    new = img.resize((max(1, int(round(w * sx))), max(1, int(round(h * sy))), ), Image.LANCZOS)
    canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    canvas.alpha_composite(new, (int(round(dx)), int(round(dy))))
    return canvas

def alpha_bbox(img):
    a = np.asarray(img.getchannel("A"))
    ys, xs = np.where(a > 20)
    return (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())) if len(xs) else None

# ---------- 1. 头部 AI 层：只取“脸/脖子”连通块，去掉过宽的头饰 ----------
head = Image.open(os.path.join(OUT, "04_头.png")).convert("RGBA")
a = np.asarray(head.getchannel("A")) > 30
lab, n = ndimage.label(a)
objs = ndimage.find_objects(lab)
comps = []
for i in range(n):
    area = int((lab == (i + 1)).sum())
    comps.append((area, i + 1, objs[i]))
comps.sort(reverse=True)
print("head comps", [(c[0], c[1], (c[2][1].start, c[2][0].start, c[2][1].stop, c[2][0].stop)) for c in comps])
# 最大块是脸/脖子（次大是头饰弧）；按 bbox 高度选“脸”
face_comp = None
for area, idx, obj in comps:
    bw = obj[1].stop - obj[1].start
    bh = obj[0].stop - obj[0].start
    if bh > bw * 0.5 and obj[0].start > 400:
        face_comp = idx
        break
if face_comp is None:
    face_comp = comps[0][1]
face_alpha = np.where(lab == face_comp, np.asarray(head.getchannel("A")), 0).astype(np.uint8)
face = Image.fromarray(np.dstack([arr, face_alpha]), "RGBA")  # RGB 用原图，alpha 用 AI 脸形
# 用 AI 头层的 RGB 而不是原图，避免把原图眼睛带进来
face_rgb = np.asarray(head)[:, :, :3]
face = Image.fromarray(np.dstack([face_rgb, face_alpha]), "RGBA")
face.save(os.path.join(ROOT, "_工具", "脸-AI-未对齐.png"))
print("face bbox", alpha_bbox(face))

# AI 脸 bbox -> 原图脸 bbox
fx0, fy0, fx1, fy1 = alpha_bbox(face)
tx0, ty0, tx1, ty1 = 300, 470, 840, 860
sx = (tx1 - tx0) / (fx1 - fx0)
sy = (ty1 - ty0) / (fy1 - fy0)
dx = tx0 - fx0 * sx
dy = ty0 - fy0 * sy
print("face transform", round(sx, 4), round(sy, 4), round(dx, 1), round(dy, 1))
face_aligned = transform(face, sx, sy, dx, dy)
face_aligned.save(os.path.join(OUT, "04_脸.png"))

# ---------- 2. 原图头饰/蝴蝶结/耳朵 ----------
ruffle = poly([(280,180),(320,160),(380,150),(450,145),(520,145),(600,150),(680,165),(750,190),(810,220),
               (860,260),(890,300),(900,340),(880,370),(850,390),(820,380),(800,360),(780,340),(750,320),
               (700,300),(640,290),(580,285),(520,285),(460,295),(400,310),(350,330),(320,350),(300,340),
               (290,320),(285,280)], 1.0)
bowL = poly([(245,390),(265,360),(295,350),(325,365),(345,390),(330,420),(300,435),(270,425),(252,408)], 1.0)
bowR = poly([(840,330),(858,300),(888,292),(918,308),(935,332),(920,360),(890,372),(858,362),(845,345)], 1.0)
earL = poly([(30,480),(50,450),(90,440),(130,455),(180,480),(220,520),(245,560),(250,600),(230,630),
             (190,640),(150,620),(110,590),(70,550),(40,520)], 1.0)
earR = poly([(780,470),(810,440),(850,430),(900,445),(950,470),(990,510),(1010,550),(1000,590),
             (970,625),(930,635),(890,620),(850,600),(820,570),(795,530)], 1.0)
headwear_mask = ((white > 0.3) & (ruffle > 0.3)) | ((blue > 0.3) & ((bowL + bowR) > 0.3)) | (((blue | white) > 0.3) & ((earL + earR) > 0.3))
# 白色背景与浅色高光也会被 white 命中，用整身前景把背景/光晕切掉
fg_path = os.path.join(ROOT, "_工具", "前景-手动-遮罩.png")
if os.path.exists(fg_path):
    fg_mask = np.asarray(Image.open(fg_path).convert("L")).astype(np.float32) / 255.0
    fg_mask = ndimage.binary_dilation(fg_mask > 0.35, iterations=2)
    headwear_mask &= fg_mask
headwear_mask = ndimage.binary_closing(headwear_mask, structure=np.ones((3, 3)))
headwear_mask = ndimage.gaussian_filter(headwear_mask.astype(np.float32), 1.0)
# 去掉头饰里的零碎噪点
lab2, n2 = ndimage.label(headwear_mask > 0.4)
if n2:
    sizes = ndimage.sum(headwear_mask > 0.4, lab2, range(1, n2 + 1))
    keep = np.zeros_like(headwear_mask, dtype=bool)
    for i, s in enumerate(sizes, 1):
        if s > 400:
            keep |= (lab2 == i)
    headwear_mask = ndimage.gaussian_filter(keep.astype(np.float32), 1.0)
headwear = Image.fromarray(np.dstack([arr, (np.clip(headwear_mask, 0, 1) * 255).astype(np.uint8)]), "RGBA")
headwear.save(os.path.join(OUT, "09_头饰.png"))

# ---------- 3. 身体对齐 ----------
body = Image.open(os.path.join(OUT, "03_身体.png")).convert("RGBA")
bx0, by0, bx1, by1 = alpha_bbox(body)
tx0, ty0, tx1, ty1 = 105, 810, 920, 1780
sx = (tx1 - tx0) / (bx1 - bx0)
sy = (ty1 - ty0) / (by1 - by0)
dx = tx0 - bx0 * sx
dy = ty0 - by0 * sy
print("body transform", round(sx, 4), round(sy, 4), round(dx, 1), round(dy, 1))
body_aligned = transform(body, sx, sy, dx, dy)
body_aligned.save(os.path.join(OUT, "03_身体.png"))

# ---------- 4. 前发：从原图蓝发中剔除蝴蝶结 ----------
# 复用 09 的轮廓
ahoge = [(300,110),(340,115),(380,145),(420,175),(470,195),(520,205),(540,185),(515,155),(480,125),(440,95),(400,80),(360,85),(330,95)]
bangs = [(280,300),(340,270),(400,255),(460,250),(520,255),(580,265),(640,285),(700,315),(750,355),(790,410),
         (805,470),(790,530),(760,580),(730,620),(720,650),(680,660),(640,650),(600,620),(560,590),(520,570),
         (480,565),(440,575),(400,600),(370,640),(350,680),(330,720),(310,700),(295,650),(285,580),(280,500),
         (275,420)]
front_mask = (blue & ((poly(ahoge, 0) + poly(bangs, 0)) > 0.2) & (((bowL + bowR) < 0.1)))
front_mask = ndimage.binary_closing(front_mask, structure=np.ones((3, 3)))
front_mask = ndimage.gaussian_filter(front_mask.astype(np.float32), 1.0)
front = Image.fromarray(np.dstack([arr, (np.clip(front_mask, 0, 1) * 255).astype(np.uint8)]), "RGBA")
front.save(os.path.join(OUT, "08_头发前.png"))

# ---------- 5. 眼嘴：用原图完整眼形（含睫毛/眼白/虹膜），保证不被切掉 ----------
eyeL_poly = [(320,545),(345,530),(380,520),(420,520),(455,530),(485,550),(505,580),(510,620),(500,660),
             (480,700),(450,725),(410,735),(370,725),(340,700),(325,665),(318,610)]
eyeR_poly = [(555,540),(580,520),(615,510),(650,510),(685,525),(715,545),(735,575),(742,615),(735,660),
             (715,695),(685,720),(650,730),(615,720),(585,700),(565,670),(555,630)]
mouth_poly = [(495,735),(530,718),(570,712),(610,718),(645,740),(655,770),(640,800),(600,815),(555,815),
              (515,800),(495,770)]
eyeL_mask = ((poly(eyeL_poly, 1.2) > 0.3) & (~skin))
eyeR_mask = ((poly(eyeR_poly, 1.2) > 0.3) & (~skin))
mouth_mask = ((poly(mouth_poly, 1.2) > 0.3) & (~skin) & (~blue))
eyeL_mask = ndimage.gaussian_filter(eyeL_mask.astype(np.float32), 1.0)
eyeR_mask = ndimage.gaussian_filter(eyeR_mask.astype(np.float32), 1.0)
mouth_mask = ndimage.gaussian_filter(mouth_mask.astype(np.float32), 1.0)
for nm, mk in [("05_左眼.png", eyeL_mask), ("06_右眼.png", eyeR_mask), ("07_嘴.png", mouth_mask)]:
    Image.fromarray(np.dstack([arr, (np.clip(mk, 0, 1) * 255).astype(np.uint8)]), "RGBA").save(os.path.join(OUT, nm))

# ---------- 5. 合成 ----------
layers = [
    ("01_尾巴", Image.open(os.path.join(OUT, "01_尾巴.png")).convert("RGBA")),
    ("02_头发后", Image.open(os.path.join(OUT, "02_头发后.png")).convert("RGBA")),
    ("03_身体", body_aligned),
    ("04_脸", face_aligned),
    ("05_左眼", Image.open(os.path.join(OUT, "05_左眼.png")).convert("RGBA")),
    ("06_右眼", Image.open(os.path.join(OUT, "06_右眼.png")).convert("RGBA")),
    ("07_嘴", Image.open(os.path.join(OUT, "07_嘴.png")).convert("RGBA")),
    ("08_头发前", front),
    ("09_头饰", headwear),
]
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

# PSD（ASCII 图层名，避免 macroman 编码失败；中文映射写进绑定表）
psd = PSDImage.new("RGB", (w, h), color=(255, 255, 255))
name_map = {"01_尾巴": "01_tail", "02_头发后": "02_hair_back", "03_身体": "03_body", "04_脸": "04_face",
            "05_左眼": "05_eye_L", "06_右眼": "06_eye_R", "07_嘴": "07_mouth", "08_头发前": "08_hair_front",
            "09_头饰": "09_headwear"}
for name, img in layers:
    psd.create_pixel_layer(img, name=name_map[name])
psd_path = os.path.join(ROOT, "大肥鱼-半身.psd")
psd.save(psd_path)
print("PSD", psd_path, os.path.getsize(psd_path))

# 预览拼图
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
print("done")
