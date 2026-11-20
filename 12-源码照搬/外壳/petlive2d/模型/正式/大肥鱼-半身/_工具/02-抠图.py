from PIL import Image
from rembg import remove, new_session
import os, sys, time

SRC = r"D:\codeData\myself\luanyujia-workbench\12-源码照搬\外壳\pet3d\概念\07-气氛图.png"
OUTDIR = r"D:\codeData\myself\luanyujia-workbench\12-源码照搬\外壳\petlive2d\模型\正式\大肥鱼-半身\_工具"
os.makedirs(OUTDIR, exist_ok=True)

model = sys.argv[1] if len(sys.argv) > 1 else "isnet-anime"
print("model:", model)
t0 = time.time()
session = new_session(model)
img = Image.open(SRC).convert("RGB")
out = remove(img, session=session, post_process_mask=True)
out.save(os.path.join(OUTDIR, f"抠图-{model}.png"))
print("done", time.time() - t0, "s", out.size)
