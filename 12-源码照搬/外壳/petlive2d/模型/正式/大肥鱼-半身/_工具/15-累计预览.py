from PIL import Image
import numpy as np, os

ROOT = r"D:\codeData\myself\luanyujia-workbench\12-源码照搬\外壳\petlive2d\模型\正式\大肥鱼-半身"
OUT = os.path.join(ROOT, "分层PNG")
w, h = 1254, 1881
a = np.zeros((h, w, 3), dtype=np.uint8)
yy, xx = np.mgrid[0:h, 0:w]
a[(yy // 24 + xx // 24) % 2 == 0] = 245
a[(yy // 24 + xx // 24) % 2 == 1] = 210
bgcheck = Image.fromarray(a, "RGB").convert("RGBA")
comp = Image.new("RGBA", (w, h), (0, 0, 0, 0))
for f, tag in [("01_尾巴.png", "01"), ("02_头发后-去米光.png", "02"), ("03_身体.png", "03"), ("04_头-去白边.png", "04")]:
    comp.alpha_composite(Image.open(os.path.join(OUT, f)).convert("RGBA"))
    canvas = bgcheck.copy()
    canvas.alpha_composite(comp)
    canvas.convert("RGB").save(os.path.join(ROOT, "_工具", f"累计-{tag}.png"))
print("ok")
