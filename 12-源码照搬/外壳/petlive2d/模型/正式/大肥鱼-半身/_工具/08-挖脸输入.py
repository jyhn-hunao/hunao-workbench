from PIL import Image, ImageDraw

SRC = r"D:\codeData\myself\luanyujia-workbench\12-源码照搬\外壳\pet3d\概念\07-气氛图.png"
OUT = r"D:\codeData\myself\luanyujia-workbench\12-源码照搬\外壳\petlive2d\模型\正式\大肥鱼-半身\_工具\生成层\前发-挖脸输入.png"

im = Image.open(SRC).convert("RGB")
d = ImageDraw.Draw(im)
# 脸部+脖子挖成绿洞：从眉毛下方到领口，保留耳朵
face_hole = [(330, 560), (380, 555), (450, 550), (520, 550), (590, 555), (660, 565), (730, 585),
             (790, 620), (810, 680), (805, 760), (780, 820), (740, 860), (680, 890), (610, 905),
             (540, 905), (470, 890), (410, 860), (370, 820), (340, 760), (325, 680), (325, 610)]
d.polygon(face_hole, fill=(0, 255, 0))
im.save(OUT)
print(OUT)
