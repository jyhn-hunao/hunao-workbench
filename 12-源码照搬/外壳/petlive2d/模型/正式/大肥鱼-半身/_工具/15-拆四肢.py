from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter
from psd_tools import PSDImage
from psd_tools.api.layers import PixelLayer
import numpy as np

base = Path(r"D:\codeData\myself\luanyujia-workbench\12-源码照搬\外壳\petlive2d\模型\正式\大肥鱼-半身")
src = base / "大肥鱼-半身-Live2D-三层.psd"
psd = PSDImage.open(src)
W, H = psd.size

# 1. 取三层原像素
layers = {l.name: (l.numpy() * 255).round().astype(np.uint8) for l in psd}
tail = layers["01_tail"].copy()
body = layers["02_body"].copy()
head = layers["03_head"].copy()
body_a = body[..., 3] > 0

# 2. 四肢区域（原图像素坐标，1254×1881）
armL = [(150, 860), (225, 880), (300, 930), (315, 1130), (295, 1200), (260, 1250), (185, 1245), (165, 1160), (170, 1030)]
armR = [(735, 880), (820, 900), (885, 930), (900, 1150), (895, 1270), (820, 1290), (775, 1240), (745, 1120), (730, 980)]
legL = [(330, 1450), (500, 1420), (505, 1800), (335, 1800)]
legR = [(510, 1420), (690, 1430), (690, 1800), (505, 1800)]

def poly_mask(points):
    m = Image.new("L", (W, H), 0)
    ImageDraw.Draw(m).polygon(points, fill=255)
    return np.array(m) > 0

mA_L, mA_R = poly_mask(armL), poly_mask(armR)
mL_L, mL_R = poly_mask(legL), poly_mask(legR)
# 腿只从裙摆下缘开始拆，裙摆留在身体层
mL_L &= (np.mgrid[0:H, 0:W][0] >= 1500)
mL_R &= (np.mgrid[0:H, 0:W][0] >= 1500)

# 3. 身体层：挖掉四肢，用裙色填底，避免抬手/抬脚露背景
fill = np.array([40, 46, 74], dtype=np.uint8)
limb_any = mA_L | mA_R | mL_L | mL_R
body_out = body.copy()
# 手臂挖掉后填裙色；腿下方不填，保持透明让腿层透出
patch = body_a & (mA_L | mA_R)
body_out[patch, 0] = fill[0]
body_out[patch, 1] = fill[1]
body_out[patch, 2] = fill[2]
body_out[patch, 3] = 255
# 四肢层覆盖区从身体层移除（保留 patch 作为底色）
body_out_a = body_a & ~limb_any
body_out[..., 3] = np.where(body_out_a, 255, 0)
# patch 区域重新给 alpha（上面已被 body_out_a 置 0 的地方补回）
body_out[patch, 3] = 255

# 4. 四肢层：原像素 + 区域 alpha，边缘外扩 2px 防缝
def dilate(mask, px=2):
    m = Image.fromarray((mask * 255).astype(np.uint8), "L")
    for _ in range(px):
        m = m.filter(ImageFilter.MaxFilter(3))
    return np.array(m) > 0

def cut(mask):
    out = body.copy()
    a = body_a & dilate(mask)
    out[..., 3] = np.where(a, 255, 0)
    return out

armL_img = cut(mA_L)
armR_img = cut(mA_R)
legL_img = cut(mL_L)
legR_img = cut(mL_R)

# 5. 合成预览（底→顶：tail, legL, legR, body, armL, armR, head）
prev = Image.new("RGBA", (W, H), (0, 0, 0, 0))
for arr in [tail, legL_img, legR_img, body_out, armL_img, armR_img, head]:
    prev = Image.alpha_composite(prev, Image.fromarray(arr, "RGBA"))

# 棋盘底
ck = np.zeros((H, W, 4), dtype=np.uint8); ck[..., 3] = 255
yy, xx = np.mgrid[0:H, 0:W]
c = ((xx // 24 + yy // 24) % 2 == 0)
ck[c] = [235, 235, 235, 255]; ck[~c] = [200, 200, 200, 255]
prev_rgb = Image.alpha_composite(Image.fromarray(ck, "RGBA"), prev).convert("RGB")
prev_rgb.save(base / "四肢拆分-预览.png")

# 6. 生成 PSD
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
psd_out.save(base / "大肥鱼-半身-Live2D-四肢.psd")

# 7. 每层透明 PNG
png_dir = base / "分层PNG-四肢"
png_dir.mkdir(exist_ok=True)
for name, arr in [
    ("01_tail", tail), ("02_leg_L", legL_img), ("03_leg_R", legR_img),
    ("04_body", body_out), ("05_arm_L", armL_img), ("06_arm_R", armR_img), ("07_head", head)
]:
    Image.fromarray(arr, "RGBA").save(png_dir / f"{name}.png")

print("ok", (base / "大肥鱼-半身-Live2D-四肢.psd").stat().st_size)
