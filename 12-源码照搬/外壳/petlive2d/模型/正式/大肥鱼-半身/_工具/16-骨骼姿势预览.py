from pathlib import Path
from PIL import Image

base = Path(r"D:\codeData\myself\luanyujia-workbench\12-源码照搬\外壳\petlive2d\模型\正式\大肥鱼-半身")
src = base / "分层PNG-四肢"
W, H = 1254, 1881

layers = [
    ("01_tail.png", (860, 1180), 8),
    ("02_leg_L.png", (430, 1450), 8),
    ("03_leg_R.png", (580, 1450), -8),
    ("04_body.png", (620, 1420), 0),
    ("05_arm_L.png", (235, 900), 22),
    ("06_arm_R.png", (815, 900), -22),
    ("07_head.png", (620, 1000), 4),
]

out = Image.new("RGBA", (W, H), (0, 0, 0, 0))
for name, pivot, deg in layers:
    im = Image.open(src / name).convert("RGBA")
    # PIL 正角为逆时针；这里取反，模拟 Pixi 的顺时针 rotation
    im = im.rotate(-deg, resample=Image.BICUBIC, center=pivot, expand=False)
    out = Image.alpha_composite(out, im)

out.save(base / "七层骨骼-姿势预览.png")

ck = Image.new("RGBA", (W, H), (235, 235, 235, 255))
px = ck.load()
for y in range(H):
    for x in range(W):
        if ((x // 24) + (y // 24)) % 2:
            px[x, y] = (200, 200, 200, 255)
ck = Image.alpha_composite(ck, out)
ck.convert("RGB").save(base / "七层骨骼-姿势预览-棋盘.png")
print("ok")
