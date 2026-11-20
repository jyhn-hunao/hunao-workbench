import os
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy import ndimage
from psd_tools import PSDImage

ROOT = r"D:\codeData\myself\luanyujia-workbench\12-源码照搬\外壳\petlive2d\模型\正式\大肥鱼-半身"
SRC = r"D:\codeData\myself\luanyujia-workbench\12-源码照搬\外壳\pet3d\概念\07-气氛图.png"
OUT = os.path.join(ROOT, "分层PNG")
src = Image.open(SRC).convert("RGB")
arr = np.asarray(src).astype(np.uint8)
h, w, _ = arr.shape
R = arr[:, :, 0].astype(np.int16); G = arr[:, :, 1].astype(np.int16); B = arr[:, :, 2].astype(np.int16)
skin = (R > 150) & (G > 100) & (B > 80) & (R > G + 8) & (G > B + 3)
white = (R > 185) & (G > 190) & (B > 195) & (abs(R - G) < 22) & (abs(G - B) < 22)
hairblue = (((B > R + 12) & (B > 70) & (R < 175) & (G < 195))
            | ((B > 150) & (G > 120) & (R < 190) & (B > G + 25)))

def poly(points, blur=1.0):
    m = Image.new("L", (w, h), 0)
    ImageDraw.Draw(m).polygon(points, fill=255)
    if blur:
        m = m.filter(ImageFilter.GaussianBlur(blur))
    return np.asarray(m).astype(np.float32) / 255.0

def alpha_bbox(img):
    a = np.asarray(img.getchannel("A"))
    ys, xs = np.where(a > 20)
    return (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())) if len(xs) else None

face_poly = [(330,450),(300,520),(305,600),(325,680),(360,750),(400,800),(450,835),(510,855),(570,860),
             (630,850),(690,820),(740,780),(775,720),(800,650),(810,570),(795,500),(760,450),(700,420),
             (640,405),(570,405),(500,415),(430,435),(380,450)]
neck_poly = [(450,800),(480,810),(530,820),(580,820),(630,810),(660,800),(670,900),(640,920),(580,930),
             (520,925),(470,910),(450,900)]
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
ruffle_outer = [(280,180),(320,160),(380,150),(450,145),(520,145),(600,150),(680,165),(750,190),(810,220),
                (860,260),(890,300),(900,340),(880,370),(850,390),(820,380),(800,360),(780,340),(750,320),
                (700,300),(640,290),(580,285),(520,285),(460,295),(400,310),(350,330),(320,350),(300,340),
                (290,320),(285,280)]
ruffle_inner = [(320,245),(380,230),(450,225),(520,225),(590,230),(660,245),(720,270),(770,300),(800,335),
                (790,355),(760,365),(730,350),(700,335),(650,320),(590,315),(530,315),(470,320),(410,335),
                (370,355),(345,370),(325,355),(315,320)]
bowL = [(245,390),(265,360),(295,350),(325,365),(345,390),(330,420),(300,435),(270,425),(252,408)]
bowR = [(840,330),(858,300),(888,292),(918,308),(935,332),(920,360),(890,372),(858,362),(845,345)]
earL = [(30,480),(50,450),(90,440),(130,455),(180,480),(220,520),(245,560),(250,600),(230,630),(190,640),
        (150,620),(110,590),(70,550),(40,520)]
earR = [(780,470),(810,440),(850,430),(900,445),(950,470),(990,510),(1010,550),(1000,590),(970,625),
        (930,635),(890,620),(850,600),(820,570),(795,530)]

face_full = poly(face_poly, 1.0)
# 头饰取整个外轮廓（里面本来就是白褶边+头发，头饰层盖在上面不会露底）
band = poly(ruffle_outer, 1.0) > 0.3
bows = (poly(bowL, 1.0) + poly(bowR, 1.0)) > 0.3
ears = (poly(earL, 1.0) + poly(earR, 1.0)) > 0.3
headwear = np.clip(band.astype(np.float32)
                   + (bows & hairblue).astype(np.float32)
                   + (ears & hairblue).astype(np.float32), 0, 1)

# 头部：脸整块保留（含眼嘴），头发按蓝发色，脖子按肤色，头饰整块；避免肤色把右侧米白轮廓带进来
core = poly(head_core, 1.0) > 0.3
core_col = ((face_full > 0.3) | (skin & (poly(neck_poly, 1.0) > 0.3)) | hairblue | (headwear > 0.5))
head_mask = ((core & core_col) | ((poly(hairL, 1.0) + poly(hairR, 1.0)) > 0.3) & hairblue)
# 左耳与头发之间有一条窄连接，颜色被背景/白边切断，补一块桥接
ear_bridge = poly([(160,500),(190,480),(230,490),(265,520),(280,570),(270,620),(240,650),(210,635),
                   (185,600),(170,550)], 1.0) > 0.3
head_mask = np.clip(head_mask.astype(np.float32) + ear_bridge.astype(np.float32), 0, 1)
head_mask = ndimage.binary_closing(head_mask, structure=np.ones((3, 3)))
head_mask = ndimage.gaussian_filter(head_mask.astype(np.float32), 1.0)
head = Image.fromarray(np.dstack([arr, (np.clip(head_mask, 0, 1) * 255).astype(np.uint8)]), "RGBA")
head.save(os.path.join(OUT, "04_头-去白边.png"))
print("head bbox", alpha_bbox(head), "px", int((np.asarray(head.getchannel("A")) > 20).sum()))

# 后发去掉米白边光（AI 生成的暖色轮廓在浅色底上像白边）
hairback = Image.open(os.path.join(OUT, "02_头发后.png")).convert("RGBA")
hb = np.asarray(hairback).copy()
hb_rgb = hb[:, :, :3].astype(np.int16)
hb_alpha = hb[:, :, 3]
beige = (hb_rgb[:, :, 0] > 200) & (hb_rgb[:, :, 1] > 190) & (hb_rgb[:, :, 2] > 175) & (np.abs(hb_rgb[:, :, 0] - hb_rgb[:, :, 1]) < 45)
hb_alpha = np.where(beige, 0, hb_alpha)
hairback2 = Image.fromarray(hb, "RGBA")
hairback2.putalpha(Image.fromarray(hb_alpha.astype(np.uint8), "L"))
hairback2.save(os.path.join(OUT, "02_头发后-去米光.png"))

# 合成
tail = Image.open(os.path.join(OUT, "01_尾巴.png")).convert("RGBA")
body = Image.open(os.path.join(OUT, "03_身体.png")).convert("RGBA")
comp = Image.new("RGBA", (w, h), (0, 0, 0, 0))
for im in [tail, hairback2, body, head]:
    comp.alpha_composite(im)
comp.save(os.path.join(ROOT, "方案C-合成预览-透明.png"))
checker = Image.new("RGB", (w, h), (255, 255, 255))
d = ImageDraw.Draw(checker)
step = 40
for y in range(0, h, step):
    for x in range(0, w, step):
        if (x // step + y // step) % 2 == 0:
            d.rectangle([x, y, x + step - 1, y + step - 1], fill=(225, 225, 225))
checker = checker.convert("RGBA")
checker.alpha_composite(comp)
checker.convert("RGB").save(os.path.join(ROOT, "方案C-合成预览-棋盘.png"))

psd = PSDImage.new("RGB", (w, h), color=(255, 255, 255))
for name, im in [("01_tail", tail), ("02_hair_back", hairback2), ("03_body", body), ("04_head", head)]:
    psd.create_pixel_layer(im, name=name)
psd_path = os.path.join(ROOT, "大肥鱼-半身-四层.psd")
psd.save(psd_path)
print("PSD", psd_path, os.path.getsize(psd_path))
