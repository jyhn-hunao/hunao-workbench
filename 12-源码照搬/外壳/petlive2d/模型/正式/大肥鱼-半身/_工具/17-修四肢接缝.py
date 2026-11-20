from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter
from psd_tools import PSDImage
from psd_tools.api.layers import PixelLayer
import numpy as np
from scipy import ndimage
from skimage.restoration import inpaint_biharmonic

base = Path(r"D:\codeData\myself\luanyujia-workbench\12-源码照搬\外壳\petlive2d\模型\正式\大肥鱼-半身")
src = base / "大肥鱼-半身-Live2D-三层.psd"
psd = PSDImage.open(src)
W, H = psd.size

layers = {l.name: (l.numpy() * 255).round().astype(np.uint8) for l in psd}
tail = layers["01_tail"].copy()
body = layers["02_body"].copy()
head = layers["03_head"].copy()
body_a = body[..., 3] > 0

# 1. 只框住可见袖子+袖口+手，避开围裙白边
armL = [
    (250, 1000), (290, 1020), (305, 1060), (300, 1090),
    (280, 1110), (272, 1145), (268, 1185), (258, 1215),
    (240, 1235), (215, 1240), (195, 1225), (183, 1200),
    (180, 1160), (183, 1130), (195, 1105), (215, 1070),
    (230, 1030),
]
armR = [
    (760, 980), (805, 995), (830, 1020), (850, 1060),
    (885, 1110), (895, 1160), (892, 1210), (885, 1250),
    (868, 1285), (840, 1302), (805, 1302), (775, 1282),
    (752, 1245), (735, 1180), (730, 1120), (735, 1050),
    (745, 1000),
]
# 2. 裙摆下缘以下才切腿，避免把白色裙边带进腿层
legL = [(330, 1450), (500, 1420), (505, 1800), (335, 1800)]
legR = [(510, 1420), (690, 1430), (690, 1800), (505, 1800)]

def poly_mask(points):
    m = Image.new("L", (W, H), 0)
    ImageDraw.Draw(m).polygon(points, fill=255)
    return np.array(m) > 0

def dilate(mask, px=2):
    m = Image.fromarray((mask * 255).astype(np.uint8), "L")
    for _ in range(px):
        m = m.filter(ImageFilter.MaxFilter(3))
    return np.array(m) > 0

mA_L, mA_R = poly_mask(armL), poly_mask(armR)
mL_L, mL_R = poly_mask(legL), poly_mask(legR)
body_rm_L = mA_L
body_rm_R = mA_R
# 腿只从裙摆下缘开始，裙摆和白边留在身体层
mL_L &= (np.mgrid[0:H, 0:W][0] >= 1565)
mL_R &= (np.mgrid[0:H, 0:W][0] >= 1565)

# 3. 身体层：手/袖区域用同区域布料色补平，保留 alpha（不挖洞）；
#    腿层要动，所以腿的 alpha 仍然交给腿层，身体在裙摆下透明
body_out = body.copy()
body_out[..., 3] = np.where(body_a & ~(mL_L | mL_R), 255, 0)

def fill_mask_shape(arr, mask, box, color):
    x0, y0, x1, y1 = box
    sel = np.zeros((H, W), dtype=bool)
    sel[y0:y1, x0:x1] = True
    sel &= mask
    arr[sel, 0] = color[0]
    arr[sel, 1] = color[1]
    arr[sel, 2] = color[2]
    arr[sel, 3] = 255

# 左手背后：上半是深蓝袖，下半是白围裙；只填手臂轮廓内，避免露矩形
fill_mask_shape(body_out, mA_L, (168, 1078, 270, 1138), (36, 42, 66))
fill_mask_shape(body_out, mA_L, (168, 1138, 270, 1236), (238, 238, 242))
# 右手背后是深蓝裙身
fill_mask_shape(body_out, mA_R, (775, 1138, 905, 1306), (38, 44, 70))

# 4. 四肢层：原像素 + 区域 alpha，外扩 2px 防缝
def cut(mask):
    out = body.copy()
    a = body_a & dilate(mask)
    out[..., 3] = np.where(a, 255, 0)
    return out

armL_img = cut(mA_L)
armR_img = cut(mA_R)
legL_img = cut(mL_L)
legR_img = cut(mL_R)

# 5. 清掉左臂右上角可能带到的白色围裙像素（只清 x>270 且 y>1090 的冷白）
def drop_cold_white(arr, x0, y0):
    out = arr.copy()
    yy, xx = np.mgrid[0:H, 0:W]
    white = (out[..., 0] > 170) & (out[..., 1] > 170) & (out[..., 2] > 175) & (out[..., 2] >= out[..., 0])
    out[white & (xx >= x0) & (yy >= y0), 3] = 0
    return out

armL_img = drop_cold_white(armL_img, 168, 1090)
armR_img = drop_cold_white(armR_img, 775, 1138)

# 5.1 右臂上缘有头发碎边、下缘带出裙身深蓝；只保留袖子和手本身
def trim_right_arm(arr):
    out = arr.copy()
    yy, xx = np.mgrid[0:H, 0:W]
    # 顶部 1015 以上是头发/背景，不属于手臂
    out[yy < 1015, 3] = 0
    # 手下方（y>1260）的深蓝布块是裙身，不属于手
    dark = (out[..., 0] < 85) & (out[..., 1] < 90) & (out[..., 2] < 125)
    out[dark & (yy > 1260) & (xx < 905), 3] = 0
    return out

armR_img = trim_right_arm(armR_img)

# 5.2 清掉切口带出的孤立碎片（只留四肢主体连通块）
def keep_main(arr, min_px=800):
    out = arr.copy()
    a = out[..., 3] > 0
    lab, n = ndimage.label(a)
    if n <= 1:
        return out
    sizes = ndimage.sum(a, lab, range(1, n + 1))
    keep = np.zeros_like(a)
    for i, s in enumerate(sizes, 1):
        if s >= min_px:
            keep |= (lab == i)
    out[..., 3] = np.where(keep, out[..., 3], 0)
    return out

armL_img = keep_main(armL_img)
armR_img = keep_main(armR_img)
legL_img = keep_main(legL_img)
legR_img = keep_main(legR_img)

# 6. 合成预览（底→顶：tail, legL, legR, body, armL, armR, head）
prev = Image.new("RGBA", (W, H), (0, 0, 0, 0))
for arr in [tail, legL_img, legR_img, body_out, armL_img, armR_img, head]:
    prev = Image.alpha_composite(prev, Image.fromarray(arr, "RGBA"))

# 棋盘底
ck = np.zeros((H, W, 4), dtype=np.uint8); ck[..., 3] = 255
yy, xx = np.mgrid[0:H, 0:W]
c = ((xx // 24 + yy // 24) % 2 == 0)
ck[c] = [235, 235, 235, 255]; ck[~c] = [200, 200, 200, 255]
prev_rgb = Image.alpha_composite(Image.fromarray(ck, "RGBA"), prev).convert("RGB")
prev_rgb.save(base / "四肢拆分-预览-v2.png")

# 7. 生成 v2 PSD
psd_out = PSDImage.new("RGBA", (W, H))
for name, arr in [
    ("01_tail", tail),
    ("02_leg_L", legL_img),
    ("03_leg_R", legR_img),
    ("04_body", body_out),
    ("05_arm_L", armL_img),
    ("06_arm_R", armR_img),
    ("07_head", head),
]:
    psd_out.append(PixelLayer.frompil(Image.fromarray(arr, "RGBA"), psd_out, name))
psd_out.save(base / "大肥鱼-半身-Live2D-四肢-v2.psd")

# 8. v2 透明 PNG
png_dir = base / "分层PNG-四肢-v2"
png_dir.mkdir(exist_ok=True)
for name, arr in [
    ("01_tail", tail), ("02_leg_L", legL_img), ("03_leg_R", legR_img),
    ("04_body", body_out), ("05_arm_L", armL_img), ("06_arm_R", armR_img), ("07_head", head)
]:
    Image.fromarray(arr, "RGBA").save(png_dir / f"{name}.png")

for name, arr in [("05_arm_L", armL_img), ("06_arm_R", armR_img), ("02_leg_L", legL_img), ("03_leg_R", legR_img)]:
    Image.fromarray(arr, "RGBA").save(base / f"_v2-{name}.png")

print("ok", (base / "大肥鱼-半身-Live2D-四肢-v2.psd").stat().st_size)
