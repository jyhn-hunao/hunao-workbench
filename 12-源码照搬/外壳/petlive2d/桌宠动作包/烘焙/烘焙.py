# -*- coding: utf-8 -*-
"""把动作表烘焙成 dsh-pet 能直接播放的 640×360 VP9-alpha WebM。

用法：
  python 烘焙.py                 # 全部 41 段
  python 烘焙.py --only idle_breathe,click_happy
  python 烘焙.py --list
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from typing import List

HERE = os.path.dirname(os.path.abspath(__file__))
PACK_ROOT = os.path.dirname(HERE)
OUT_DIR = os.path.join(PACK_ROOT, "webm")
MANIFEST = os.path.join(PACK_ROOT, "动作清单.json")
FPS = 30

sys.path.insert(0, HERE)
from 骨骼 import Rig  # noqa: E402
from 动作 import CLIPS  # noqa: E402


def ffmpeg_exe() -> str:
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        exe = shutil.which("ffmpeg")
        if exe:
            return exe
    raise RuntimeError("找不到 ffmpeg；先 pip install imageio-ffmpeg")


def render_clip(job: tuple[str, int]) -> dict:
    name, total = job
    info = CLIPS[name]
    dur = float(info["duration"])
    n = int(round(dur * FPS))
    rig = Rig(os.path.join(PACK_ROOT, "素材", "道具"))
    tmp = tempfile.mkdtemp(prefix="fantuan_" + name + "_")
    t0 = time.time()
    try:
        for i in range(n):
            # 最后一帧不取 duration，避免循环末尾多走一步
            t = i / FPS
            rig.render(info["fn"](t)).save(os.path.join(tmp, f"{i:05d}.png"))
        out = os.path.join(OUT_DIR, name + ".webm")
        cmd = [
            ffmpeg_exe(), "-y", "-hide_banner", "-loglevel", "error",
            "-framerate", str(FPS), "-i", os.path.join(tmp, "%05d.png"),
            "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "28",
            "-row-mt", "1", "-threads", "4", "-an", out,
        ]
        subprocess.run(cmd, check=True)
        size = os.path.getsize(out) if os.path.exists(out) else 0
        return {"name": name, "frames": n, "duration": dur, "bytes": size,
                "seconds": round(time.time() - t0, 1), "ok": True}
    except Exception as e:
        return {"name": name, "ok": False, "error": str(e), "seconds": round(time.time() - t0, 1)}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="", help="逗号分隔的片段名")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()

    if args.list:
        for name, info in CLIPS.items():
            print(f"{name}\t{info['duration']}s\t{'loop' if info['loop'] else 'once'}")
        return 0

    names = [x.strip() for x in args.only.split(",") if x.strip()] or list(CLIPS.keys())
    unknown = [n for n in names if n not in CLIPS]
    if unknown:
        print("未知片段: " + ", ".join(unknown))
        return 2

    os.makedirs(OUT_DIR, exist_ok=True)
    jobs = [(n, 0) for n in names]
    results: List[dict] = []
    t0 = time.time()
    with ProcessPoolExecutor(max_workers=max(1, args.workers)) as ex:
        futs = [ex.submit(render_clip, j) for j in jobs]
        for fut in as_completed(futs):
            r = fut.result()
            results.append(r)
            if r.get("ok"):
                print(f"[OK] {r['name']} {r['duration']}s {r['frames']}f {r['bytes']/1024/1024:.2f}MB {r['seconds']}s")
            else:
                print(f"[FAIL] {r['name']}: {r.get('error')}")

    results.sort(key=lambda x: names.index(x["name"]))
    ok = all(r.get("ok") for r in results) and len(results) == len(names)
    manifest = {
        "generatedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
        "fps": FPS,
        "stage": [640, 360],
        "hitBox": [200, 50, 440, 335],
        "feetY": 330,
        "clips": [{k: r.get(k) for k in ("name", "duration", "frames", "bytes", "ok")} for r in results],
        "totalSeconds": round(time.time() - t0, 1),
    }
    with open(MANIFEST, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print(f"完成 {sum(1 for r in results if r.get('ok'))}/{len(results)}，用时 {manifest['totalSeconds']}s")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
