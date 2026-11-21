# -*- coding: utf-8 -*-
# 19-生成脸动纹理.py
# 作用：从 2048 原图集生成眨眼 / 半张嘴 / 张大嘴 / 眨眼+张嘴四张 1024 变体。
# 为什么：Cubism 导出的 moc3 里 27 个参数全是 0 keyform，ParamEye/Mouth 改了不会形变；
#        页面 app.js 改为按状态切换这四张图集（只改 head 那一格，其他格原样复制）。
# 用法：python 19-生成脸动纹理.py
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter
import numpy as np

HERE = Path(__file__).resolve().parent          # _工具
MODEL_DIR = HERE.parent                          # 大肥鱼-半身
SRC = MODEL_DIR / '大肥鱼-半身.2048' / 'texture_00.png'
OUT = MODEL_DIR / '大肥鱼-半身.face'


def ellipse_mask(size, box, angle, blur=2):
    m = Image.new('L', size, 0)
    ImageDraw.Draw(m).ellipse(box, fill=255)
    if angle:
        m = m.rotate(angle, center=((box[0] + box[2]) / 2, (box[1] + box[3]) / 2), resample=Image.BICUBIC)
    if blur:
        m = m.filter(ImageFilter.GaussianBlur(blur))
    return m


def paint_skin(im, mask, top=(249, 223, 213), bottom=(248, 214, 202)):
    w, h = im.size
    yy = np.arange(h)[:, None]
    t = np.clip(yy / float(h), 0, 1)
    arr = np.zeros((h, w, 4), np.uint8)
    for i in range(3):
        arr[..., i] = (top[i] * (1 - t) + bottom[i] * t).astype(np.uint8)
    arr[..., 3] = np.array(mask)
    im.alpha_composite(Image.fromarray(arr, 'RGBA'))


def hair_mask(im):
    a = np.array(im)
    r, g, b = a[..., 0].astype(int), a[..., 1].astype(int), a[..., 2].astype(int)
    return (b > r + 12) & (b > 65) & (a[..., 3] > 0)


def blink(im):
    size = im.size
    outer = ellipse_mask(size, (218, 228, 300, 312), -24, 3)
    inner = ellipse_mask(size, (229, 240, 291, 304), -24, 2)
    out = np.array(outer).astype(np.uint8)
    out[hair_mask(im)] = 0
    out = np.maximum(out, np.array(inner))
    paint_skin(im, Image.fromarray(out, 'L'))
    d = ImageDraw.Draw(im)
    d.line([(230, 272), (240, 266), (252, 263), (265, 266), (278, 274), (288, 282)],
           fill=(42, 28, 34, 255), width=5, joint='curve')
    d.line([(287, 281), (294, 287)], fill=(42, 28, 34, 255), width=4)
    return im


def mouth(im, scale=1.25):
    size = im.size
    outer = ellipse_mask(size, (184, 298, 232, 338), -8, 3)
    inner = ellipse_mask(size, (192, 305, 223, 330), -8, 2)
    out = np.array(outer).astype(np.uint8)
    out[hair_mask(im)] = 0
    out = np.maximum(out, np.array(inner))
    paint_skin(im, Image.fromarray(out, 'L'), top=(249, 218, 206), bottom=(249, 211, 198))
    d = ImageDraw.Draw(im)
    cx, cy = 207, 318
    rx, ry = 14 * scale, 11 * scale
    d.ellipse((cx - rx, cy - ry, cx + rx, cy + ry), fill=(112, 45, 50, 255), outline=(88, 35, 40, 255), width=2)
    d.ellipse((cx - rx + 3, cy - ry + 3, cx + rx - 3, cy + ry - 3), fill=(231, 139, 121, 255))
    d.ellipse((cx - rx + 5, cy - ry + 7, cx + rx - 6, cy + ry - 4), fill=(231, 146, 127, 255))
    d.ellipse((cx - rx + 4, cy - ry + 4, cx - rx + 10, cy - ry + 10), fill=(247, 186, 166, 255))
    return im


def main():
    if not SRC.exists():
        raise SystemExit('找不到原图集：' + str(SRC))
    OUT.mkdir(parents=True, exist_ok=True)
    base = Image.open(SRC).convert('RGBA')
    jobs = [
        ('blink.png', True, 0),
        ('talk.png', False, 1.25),
        ('talk2.png', False, 1.55),
        ('blink_talk.png', True, 1.35),
    ]
    for name, do_blink, scale in jobs:
        im = base.copy()
        if scale:
            im = mouth(im, scale)
        if do_blink:
            im = blink(im)
        im.resize((1024, 1024), Image.LANCZOS).save(OUT / name, optimize=True)
        print('✓', OUT / name)
    print('完成：4 张 1024 脸动纹理')


if __name__ == '__main__':
    main()
