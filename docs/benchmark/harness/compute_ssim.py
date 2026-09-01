#!/usr/bin/env python3
"""画質(SSIM)算出＋同条件エンジン比較 (ADR-005 METHODOLOGY §3)。

各出力PDFについて、入力PDFと同一ページを同一解像度でラスタライズし、SSIM を算出する。
入力のラスタライズはサンプル単位でキャッシュして再利用する。

    pip install pymupdf scikit-image numpy
    python compute_ssim.py

出力: results-ssim.json (results.json に ssimMean/ssimMin を付与) と、
      engine×preset の比較サマリ (削減率/SSIM/時間/頁維持) を標準出力へ。
"""
import json
import os
import sys

import numpy as np
import pymupdf  # PyMuPDF
from skimage.metrics import structural_similarity as ssim

HERE = os.path.dirname(os.path.abspath(__file__))
BENCH_ROOT = os.path.dirname(HERE)
MANIFEST = os.path.join(BENCH_ROOT, "corpus", "manifest.json")
# 対象結果ファイルは引数で指定可 (既定 results.json)。出力は <base>-ssim.json。
RESULTS = os.path.join(HERE, sys.argv[1] if len(sys.argv) > 1 else "results.json")
OUT = RESULTS[:-5] + "-ssim.json" if RESULTS.endswith(".json") else RESULTS + "-ssim.json"

SSIM_DPI = 100          # 比較レンダリング解像度
MAX_PAGES = 3           # 先頭 N ページで評価 (時間の上限)


def render_gray(path: str, n: int, dpi: int = SSIM_DPI):
    """先頭 n ページをグレースケール numpy 配列で返す。"""
    doc = pymupdf.open(path)
    pages = []
    for i in range(min(n, doc.page_count)):
        pix = doc.load_page(i).get_pixmap(dpi=dpi, colorspace=pymupdf.csGRAY)
        arr = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width)
        pages.append(arr)
    doc.close()
    return pages


def ssim_pages(in_pages, out_pages):
    vals = []
    for a, b in zip(in_pages, out_pages):
        # ページサイズが 1px ずれる場合に備え共通領域へクロップ
        h = min(a.shape[0], b.shape[0]); w = min(a.shape[1], b.shape[1])
        a2, b2 = a[:h, :w], b[:h, :w]
        if h < 7 or w < 7:
            continue
        vals.append(ssim(a2, b2, data_range=255))
    return vals


def main() -> None:
    manifest = json.load(open(MANIFEST, encoding="utf-8"))
    pages_by_id = {s["id"]: s["pages"] for s in manifest["samples"]}
    inpath_by_id = {s["id"]: os.path.join(BENCH_ROOT, s["path"]) for s in manifest["samples"]}
    report = json.load(open(RESULTS, encoding="utf-8"))

    in_cache = {}  # id -> rendered input pages
    for r in report["results"]:
        if r.get("error") or not r.get("valid"):
            continue
        sid = r["id"]
        n = min(MAX_PAGES, pages_by_id[sid])
        if sid not in in_cache:
            in_cache[sid] = render_gray(inpath_by_id[sid], n)
        out_pages = render_gray(os.path.join(HERE, r["outputFile"].replace("/", os.sep)), n)
        vals = ssim_pages(in_cache[sid], out_pages)
        r["ssimMean"] = round(float(np.mean(vals)), 4) if vals else None
        r["ssimMin"] = round(float(np.min(vals)), 4) if vals else None

    json.dump(report, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=2)

    # ---- 比較サマリ ----
    rows = [r for r in report["results"] if not r.get("error") and r.get("valid")]

    def avg(xs):
        xs = [x for x in xs if x is not None]
        return sum(xs) / len(xs) if xs else float("nan")

    print("\n=== 同条件比較: engine × preset (全カテゴリ平均) ===")
    print(f"{'engine':<15} {'preset':<9} {'avg_red':>8} {'avg_SSIM':>9} {'avg_ms':>7} {'kept':>6}")
    keys = []
    for r in rows:
        k = (r["engine"], r["preset"])
        if k not in keys:
            keys.append(k)
    for eng, preset in keys:
        rs = [r for r in rows if r["engine"] == eng and r["preset"] == preset]
        red = avg([r["reductionRatio"] for r in rs])
        sm = avg([r.get("ssimMean") for r in rs])
        ms = avg([r.get("compressMs", 0) for r in rs])
        kept = sum(1 for r in rs if r.get("ssimMean") is not None)
        print(f"{eng:<15} {preset:<9} {red*100:7.1f}% {sm:9.3f} {ms:7.0f} {kept:>4}/{len(rs)}")

    print("\n=== スキャン/写真カテゴリのみ (画像圧縮の要点) ===")
    img_cats = {"scan-bw", "scan-gray", "scan-color", "photo"}
    print(f"{'engine':<15} {'preset':<9} {'avg_red':>8} {'avg_SSIM':>9}")
    for eng, preset in keys:
        rs = [r for r in rows if r["engine"] == eng and r["preset"] == preset and r["category"] in img_cats]
        if not rs:
            continue
        red = avg([r["reductionRatio"] for r in rs])
        sm = avg([r.get("ssimMean") for r in rs])
        print(f"{eng:<15} {preset:<9} {red*100:7.1f}% {sm:9.3f}")

    print(f"\n[OK] -> {OUT}")


if __name__ == "__main__":
    main()
