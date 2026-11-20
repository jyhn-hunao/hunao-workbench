from PIL import Image, ImageDraw, ImageFont
import os

SRC = r"D:\codeData\myself\luanyujia-workbench\12-源码照搬\外壳\pet3d\概念\07-气氛图.png"
OUT = r"D:\codeData\myself\luanyujia-workbench\12-源码照搬\外壳\petlive2d\模型\正式\大肥鱼-半身\_工具\网格.png"

img = Image.open(SRC).convert("RGB")
d = ImageDraw.Draw(img)
try:
    font = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 28)
except Exception:
    font = ImageFont.load_default()

w, h = img.size
for x in range(0, w, 100):
    d.line([(x, 0), (x, h)], fill=(255, 0, 0), width=2)
    d.text((x + 4, 6), str(x), fill=(255, 0, 0), font=font)
for y in range(0, h, 100):
    d.line([(0, y), (w, y)], fill=(0, 120, 255), width=2)
    d.text((6, y + 2), str(y), fill=(0, 80, 255), font=font)

os.makedirs(os.path.dirname(OUT), exist_ok=True)
img.save(OUT)
print(OUT, img.size)
