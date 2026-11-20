import os
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont
from scipy import ndimage
from skimage.restoration import inpaint_biharmonic
from psd_tools import PSDImage

ROOT = r"D:\codeData\myself\luanyujia-workbench\12-源码照搬\外壳\petlive2d\模型\正式\大肥鱼-半身"
SRC = r"D:\codeData\myself\luanyujia-workbench\12-源码照搬\外壳\pet3d\概念\07-气氛图.png"
OUT = os.path.join(ROOT, "分层PNG")
os.makedirs(OUT, exist_ok=True)

im = Image.open(SRC).convert("RGB")
arr = np.asarray(im).astype(np.uint8)
h, w, _ = arr.shape

# ---------- 1. 全局前景（背景多项式 + 颜色距离 + 填洞） ----------
f = arr.astype(np.float32)
ys, xs = np.mgrid[0:h, 0:w]
border = 14
edge = (xs < border) | (xs >= w - border) | (ys < border) | (ys >= h - border)
px = xs[edge].astype(np.float64) / w
py = ys[edge].astype(np.float64) / h
terms = np.stack([np.ones_like(px), px, py, px*px, px*py, py*py, px**3, px*px*py, px*py*py, py**3], axis=1)
coef = [np.linalg.lstsq(terms, f[:, :, c][edge], rcond=None)[0] for c in range(3)]
gx = (xs.astype(np.float64) / w).ravel()
gy = (ys.astype(np.float64) / h).ravel()
T = np.stack([np.ones_like(gx), gx, gy, gx*gx, gx*gy, gy*gy, gx**3, gx*gx*gy, gx*gy*gy, gy**3], axis=1)
bg = np.zeros_like(f)
for c in range(3):
    bg[:, :, c] = (T @ coef[c]).reshape(h, w)
dist = np.sqrt(((f - bg) ** 2).sum(axis=2))
alpha = np.clip((dist - 8.0) / 18.0, 0, 1)
fg = ndimage.gaussian_filter(alpha, 1.0) > 0.34
fg = ndimage.binary_closing(fg, structure=np.ones((5, 5)))
fg = ndimage.binary_fill_holes(fg)
fg = ndimage.binary_opening(fg, structure=np.ones((3, 3)))
# 只留最大连通块，去掉背景噪点/阴影
lab, n = ndimage.label(fg)
if n:
    sizes = ndimage.sum(fg, lab, range(1, n + 1))
    fg = lab == (np.argmax(sizes) + 1)

# ---------- 2. 颜色分类 ----------
R = arr[:, :, 0].astype(np.int16)
G = arr[:, :, 1].astype(np.int16)
B = arr[:, :, 2].astype(np.int16)
skin = (R > 150) & (G > 100) & (B > 80) & (R > G + 8) & (G > B + 3)
white = (R > 185) & (G > 190) & (B > 195) & (abs(R - G) < 22) & (abs(G - B) < 22)
blue = (B > R + 5) & (B > 55) & (G > 25)
hairblue = ((B > R + 5) & (B > 45) & (G > 20)) | ((B > 120) & (G > 140) & (B > 180))

def poly_mask(points, blur=2.0):
    m = Image.new("L", (w, h), 0)
    ImageDraw.Draw(m).polygon(points, outline=255, fill=255)
    if blur:
        m = m.filter(ImageFilter.GaussianBlur(blur))
    return np.asarray(m).astype(np.float32) / 255.0

def refine(mask, close=0, holes=0, blur=1.2):
    b = mask > 0.5
    if close:
        b = ndimage.binary_closing(b, structure=np.ones((close, close)), iterations=1)
    if holes:
        b = ndimage.binary_fill_holes(b)
    soft = ndimage.gaussian_filter(b.astype(np.float32), blur)
    return np.clip(soft, 0, 1)

def cut_layer(name, mask):
    a = np.clip(mask, 0, 1)
    rgba = np.dstack([arr, (a * 255).astype(np.uint8)])
    img = Image.fromarray(rgba, "RGBA")
    img.save(os.path.join(OUT, name))
    return img

# ---------- 3. 图层轮廓 ----------
body_poly = [(470,810),(390,850),(300,870),(230,910),(180,980),(165,1080),(180,1170),(150,1230),
             (120,1300),(105,1370),(130,1440),(220,1480),(320,1500),(360,1480),(365,1600),(360,1700),
             (380,1760),(470,1780),(520,1730),(560,1700),(590,1730),(640,1780),(720,1760),(720,1680),
             (690,1580),(680,1500),(760,1490),(860,1450),(910,1370),(890,1280),(860,1200),(880,1120),
             (920,1030),(900,950),(850,900),(800,870),(700,850),(640,820)]
face_poly = [(330,470),(300,540),(305,620),(325,690),(360,750),(400,800),(450,835),(510,855),(570,860),
             (630,850),(690,820),(740,780),(775,720),(800,650),(810,570),(795,500),(760,450),(700,420),
             (640,405),(570,405),(500,415),(430,435),(380,450)]
headdress_poly = [(290,300),(310,250),(360,210),(420,185),(490,170),(570,165),(650,175),(730,195),
                  (800,225),(850,265),(880,310),(885,345),(850,365),(810,340),(770,310),(720,290),
                  (660,275),(590,270),(520,270),(450,285),(390,305),(350,335),(320,365),(300,350)]
earL_poly = [(240,500),(260,470),(300,460),(335,490),(350,530),(340,580),(310,620),(275,630),(250,590),(235,545)]
earR_poly = [(780,480),(810,460),(850,470),(880,500),(895,540),(890,590),(860,625),(825,635),(795,600),(780,550)]

hairback_poly = [(60,430),(50,600),(40,800),(50,1000),(80,1200),(120,1350),(200,1420),(300,1400),(380,1320),
                 (360,1200),(330,1050),(320,900),(300,800),(270,700),(220,620),(180,550),(140,480),(200,360),
                 (300,280),(450,240),(600,250),(800,290),(980,340),(1050,400),(1080,500),(1100,650),(1080,800),
                 (1050,1000),(1000,1200),(950,1380),(880,1420),(800,1380),(760,1250),(780,1100),(800,900),
                 (780,750),(740,620),(680,540),(600,490),(500,470),(420,480),(360,520),(300,700),(280,800),
                 (260,950),(240,1100),(220,1250),(180,1320),(140,1250),(120,1100),(110,900),(120,700),(140,550),
                 (170,470),(220,430),(300,400),(400,380),(520,370),(650,380),(780,410),(860,450)]

bangs_poly = [(300,300),(340,270),(400,255),(460,250),(520,255),(580,265),(640,285),(700,315),(750,355),
              (790,410),(805,470),(790,530),(760,580),(720,620),(680,640),(640,620),(600,580),(560,540),
              (520,520),(480,515),(440,525),(400,550),(370,590),(350,640),(330,700),(305,650),(290,580),
              (280,520),(275,430),(280,360)]
sideL_poly = [(270,520),(300,580),(320,650),(330,730),(315,820),(290,900),(260,980),(220,1050),(180,1100),
              (155,1120),(170,1160),(210,1140),(250,1080),(290,1000),(320,920),(340,840),(350,760),(345,680),(325,600)]
sideR_poly = [(800,500),(830,560),(850,630),(870,710),(885,800),(900,900),(920,1000),(950,1080),(990,1120),
              (1020,1100),(1020,1060),(990,980),(960,900),(930,820),(900,740),(870,660),(840,590),(815,540)]
top_poly = [(300,110),(340,115),(380,145),(420,175),(470,195),(520,205),(540,185),(515,155),(480,125),
            (440,95),(400,80),(360,85),(330,95)]

tail_poly = [(870,1240),(900,1160),(980,1090),(1060,1100),(1140,1120),(1235,1160),(1254,1190),(1254,1290),
             (1170,1260),(1100,1280),(1040,1370),(980,1450),(900,1490),(820,1450),(840,1360),(860,1290)]

eyeL_poly = [(330,620),(345,585),(380,560),(420,548),(460,558),(485,582),(495,615),(490,660),(465,695),
             (430,710),(390,705),(355,685),(335,655)]
eyeR_poly = [(560,600),(575,568),(610,548),(650,542),(690,556),(720,582),(735,615),(730,660),(705,695),
             (670,710),(630,700),(595,680),(570,640)]
mouth_poly = [(500,735),(530,720),(570,715),(610,720),(645,740),(655,770),(640,800),(600,815),(555,815),
              (515,800),(495,770)]

# ---------- 4. 生成各层 ----------
# 尾巴：填洞后的前景 ∩ 尾巴轮廓
tail_mask = refine((fg & (poly_mask(tail_poly, 2.5) > 0.5)), close=5, holes=1, blur=1.4)

# 头发后：蓝色像素 ∩ 外轮廓；不做大填洞（避免把脸填成头发）
hairback_mask = refine((hairblue & (poly_mask(hairback_poly, 3.0) > 0.5) & fg), close=5, holes=0, blur=1.2)

# 身体：填洞前景 ∩ 身体轮廓（白围裙/白褶边都靠填洞保住）
body_mask = refine((fg & (poly_mask(body_poly, 2.5) > 0.5)), close=5, holes=1, blur=1.4)

# 头：脸/头饰/耳朵；脸部排除蓝发，眼嘴稍后补肤
head_poly_mask = np.maximum.reduce([
    poly_mask(face_poly, 2.0), poly_mask(headdress_poly, 2.0),
    poly_mask(earL_poly, 2.0), poly_mask(earR_poly, 2.0)
])
head_color = skin | white | (blue & (poly_mask(headdress_poly, 0) + poly_mask(earL_poly, 0) + poly_mask(earR_poly, 0) > 0))
head_mask = refine((fg & head_poly_mask & head_color), close=3, holes=1, blur=1.2)

# 眼嘴区域从头部底图里补成皮肤（否则合眼/闭嘴时下面还有原图眼嘴）
eyeL_m = poly_mask(eyeL_poly, 2.0)
eyeR_m = poly_mask(eyeR_poly, 2.0)
mouth_m = poly_mask(mouth_poly, 2.0)
hole = ndimage.binary_dilation((eyeL_m + eyeR_m + mouth_m) > 0.15, iterations=6)
hole &= (head_mask > 0.1)
rgb_inpaint = inpaint_biharmonic(arr.astype(np.float32) / 255.0, hole, channel_axis=2)
rgb_inpaint = np.clip(rgb_inpaint * 255.0, 0, 255).astype(np.uint8)

head_rgba = np.dstack([rgb_inpaint, (head_mask * 255).astype(np.uint8)])
head_img = Image.fromarray(head_rgba, "RGBA")

# 眼：只保留非皮肤像素（眼白/虹膜/睫毛），皮肤不跟着眼动
eyeL_mask = refine((eyeL_m > 0.3) & fg & (~skin), close=2, holes=0, blur=0.8)
eyeR_mask = refine((eyeR_m > 0.3) & fg & (~skin), close=2, holes=0, blur=0.8)
mouth_mask = refine((mouth_m > 0.3) & fg & (~skin), close=2, holes=0, blur=0.8)

# 头发前：蓝色像素 ∩ 刘海/侧发/呆毛
hairfront_poly = np.maximum.reduce([poly_mask(p, 1.5) for p in [bangs_poly, sideL_poly, sideR_poly, top_poly]])
hairfront_mask = refine((hairblue & (hairfront_poly > 0.3) & fg), close=3, holes=0, blur=1.0)

layers = [
    ("01_尾巴.png", cut_layer("01_尾巴.png", tail_mask)),
    ("02_头发后.png", cut_layer("02_头发后.png", hairback_mask)),
    ("03_身体.png", cut_layer("03_身体.png", body_mask)),
    ("04_头.png", head_img),
    ("05_左眼.png", cut_layer("05_左眼.png", eyeL_mask)),
    ("06_右眼.png", cut_layer("06_右眼.png", eyeR_mask)),
    ("07_嘴.png", cut_layer("07_嘴.png", mouth_mask)),
    ("08_头发前.png", cut_layer("08_头发前.png", hairfront_mask)),
]
for name, img in layers:
    if name != "04_头.png":
        img.save(os.path.join(OUT, name))

# ---------- 5. 合成 PSD（底 → 顶） ----------
psd = PSDImage.new("RGB", (w, h), color=(255, 255, 255))
for name, img in layers:
    psd.create_pixel_layer(img, name=os.path.splitext(name)[0])
psd_path = os.path.join(ROOT, "大肥鱼-半身.psd")
psd.save(psd_path)

# ---------- 6. 预览：每层缩略图 + 棋盘格 ----------
def checker(w_, h_, step=24):
    a = np.zeros((h_, w_, 3), dtype=np.uint8)
    yy, xx = np.mgrid[0:h_, 0:w_]
    a[(yy // step + xx // step) % 2 == 0] = 245
    a[(yy // step + xx // step) % 2 == 1] = 210
    return a

thumb_w = 300
cols = 3
rows = (len(layers) + cols - 1) // cols
cell_h = int(thumb_w * h / w) + 38
sheet = Image.new("RGB", (cols * (thumb_w + 12) + 12, rows * (cell_h + 12) + 12), (255, 255, 255))
d = ImageDraw.Draw(sheet)
try:
    font = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 18)
except Exception:
    font = ImageFont.load_default()

for i, (name, img) in enumerate(layers):
    tw = thumb_w
    th = int(tw * h / w)
    bg = Image.fromarray(checker(tw, th), "RGB")
    small = img.resize((tw, th), Image.LANCZOS)
    bg.paste(small, (0, 0), small)
    x = 12 + (i % cols) * (thumb_w + 12)
    y = 12 + (i // cols) * (cell_h + 12)
    sheet.paste(bg, (x, y + 28))
    d.text((x, y + 2), os.path.splitext(name)[0], fill=(0, 0, 0), font=font)
sheet.save(os.path.join(ROOT, "分层预览.png"))

print("PSD:", psd_path, os.path.getsize(psd_path))
print("layers:", [x[0] for x in layers])
