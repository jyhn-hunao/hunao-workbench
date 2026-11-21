# -*- coding: utf-8 -*-
# 19-生成脸动纹理.py
# 作用：从 2048 原图集生成眨眼 / 半张嘴 / 张大嘴 / 眨眼+张嘴四张 2048 变体。
# 为什么：Cubism 导出的 moc3 里 27 个参数全是 0 keyform，ParamEye/Mouth 改了不会形变；
#        页面 app.js 改为按状态切换这四张图集（只改 head 那一格，其他格原样复制）。
# 关键：大眼用眼型椭圆 + 保护最大蓝色头发连通块，闭眼线只落在非头发区域；
#      左小眼被刘海半遮，虹膜会被“最大蓝块=头发”误保护，所以用小椭圆直接补肤色并单独画线，
#      两只眼必须一起闭，否则只闭大眼会变成“单眼 wink”。
# 用法：python 19-生成脸动纹理.py
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter
import numpy as np
from scipy import ndimage

HERE = Path(__file__).resolve().parent          # _工具
MODEL_DIR = HERE.parent                          # 大肥鱼-半身
SRC = MODEL_DIR / '大肥鱼-半身.2048' / 'texture_00.png'
OUT = MODEL_DIR / '大肥鱼-半身.face'

EYE = (208, 220, 338, 312)


def largest_blue_mask(im, dilate=5):
    """头发是头部格里最大的蓝色连通块；眼睛虹膜远小于它，不能一起被抠掉。"""
    a = np.array(im)
    r, g, b = a[..., 0].astype(int), a[..., 1].astype(int), a[..., 2].astype(int)
    raw = (b > r + 10) & (b > 65) & (a[..., 3] > 0)
    lab, n = ndimage.label(raw)
    if not n:
        return raw
    sizes = ndimage.sum(raw, lab, range(1, n + 1))
    m = (lab == (np.argmax(sizes) + 1))
    if dilate:
        m = ndimage.binary_dilation(m, iterations=dilate)
    return m


def eye_mask(size):
    m = Image.new('L', size, 0)
    ImageDraw.Draw(m).ellipse(EYE, fill=255)
    return m.filter(ImageFilter.GaussianBlur(4))


def fill_eye_skin(im, mask):
    w, h = im.size
    arr = np.zeros((h, w, 4), dtype=np.uint8)
    top = np.array([251, 204, 195], dtype=float)      # 上眼睑略深，贴近脸颊
    bottom = np.array([252, 219, 209], dtype=float)   # 下眼睑亮一点
    yy = np.arange(h)[:, None]
    t = np.clip((yy - EYE[1]) / float(EYE[3] - EYE[1]), 0, 1)
    for i in range(3):
        arr[..., i] = (top[i] * (1 - t) + bottom[i] * t).astype(np.uint8)
    # 下眼睑腮红，避免整块死白
    xx = np.arange(w)[None, :]
    blush = np.clip((xx - 250) / 80.0, 0, 1) * np.clip((yy - 250) / 45.0, 0, 1)
    for i, v in enumerate([247, 185, 176]):
        arr[..., i] = np.clip(arr[..., i].astype(float) * (1 - 0.35 * blush) + v * 0.35 * blush, 0, 255).astype(np.uint8)
    arr[..., 3] = np.array(mask)
    im.alpha_composite(Image.fromarray(arr, 'RGBA'))


def draw_closed_eye(im, hair):
    # 线单独起一层，最后按头发遮罩裁掉，避免闭眼线画到头发上
    layer = Image.new('RGBA', im.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    # 中性微弧：线中心比旧版低 3px，不再画成“开心眯眼”
    pts = [(224, 278), (236, 272), (250, 268), (266, 267), (282, 268),
           (296, 272), (310, 276), (320, 280)]
    d.line(pts, fill=(47, 31, 38, 255), width=4, joint='curve')
    # 外眼角小睫毛
    d.line([(320, 280), (327, 275)], fill=(47, 31, 38, 255), width=3)
    d.line([(320, 280), (326, 286)], fill=(47, 31, 38, 255), width=3)
    # 内眼角收一下
    d.line([(224, 278), (218, 281)], fill=(47, 31, 38, 255), width=3)
    # 上眼睑的淡淡阴影
    shadow = Image.new('RGBA', im.size, (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.line([(230, 272), (242, 266), (256, 262), (270, 261), (284, 262),
             (298, 266), (310, 271)], fill=(207, 150, 143, 100), width=6, joint='curve')
    shadow = shadow.filter(ImageFilter.GaussianBlur(3))
    layer.alpha_composite(shadow)
    # 下眼睑淡褶，避免大片空皮肤
    lower = Image.new('RGBA', im.size, (0, 0, 0, 0))
    ld = ImageDraw.Draw(lower)
    ld.line([(248, 292), (264, 289), (280, 289), (296, 291), (306, 294)], fill=(205, 151, 143, 55), width=3, joint='curve')
    lower = lower.filter(ImageFilter.GaussianBlur(2))
    layer.alpha_composite(lower)
    ma = np.array(layer)
    ma[hair] = 0
    im.alpha_composite(Image.fromarray(ma, 'RGBA'))


def fill_left_eye_skin(im):
    """左小眼被刘海半遮，蓝虹膜会被“最大蓝块=头发”误保护；这里用小椭圆直接补肤色。"""
    mask = Image.new('L', im.size, 0)
    ImageDraw.Draw(mask).ellipse((150, 270, 202, 312), fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(2))
    arr = np.zeros((im.size[1], im.size[0], 4), np.uint8)
    arr[..., 0] = 250
    arr[..., 1] = 215
    arr[..., 2] = 205
    arr[..., 3] = np.array(mask)
    im.alpha_composite(Image.fromarray(arr, 'RGBA'))


def draw_left_closed_eye(im):
    layer = Image.new('RGBA', im.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    pts = [(155, 293), (166, 289), (178, 288), (190, 289), (200, 293)]
    d.line(pts, fill=(47, 31, 38, 255), width=3, joint='curve')
    shadow = Image.new('RGBA', im.size, (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.line([(x, y - 4) for x, y in pts], fill=(207, 150, 143, 70), width=3, joint='curve')
    shadow = shadow.filter(ImageFilter.GaussianBlur(2))
    layer.alpha_composite(shadow)
    im.alpha_composite(layer)


def blink(im):
    src = im.copy()
    hair = largest_blue_mask(src, 5)
    mask = eye_mask(src.size)
    ma = np.array(mask).astype(np.uint8)
    ma[hair] = 0
    mask = Image.fromarray(ma, 'L')
    fill_eye_skin(im, mask)
    draw_closed_eye(im, hair)
    # 左小眼也要闭，否则会像“单眼 wink”
    fill_left_eye_skin(im)
    draw_left_closed_eye(im)
    return im


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
        im.save(OUT / name, optimize=True)
        print('✓', OUT / name)
    print('完成：4 张 2048 脸动纹理')


if __name__ == '__main__':
    main()
