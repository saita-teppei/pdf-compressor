#!/usr/bin/env python3
"""コンテンツ種別判定 (inspect) — ADR-008 の inspect() の実証。

実PDFから特徴を導出して種別を分類する（manifest のカテゴリは使わない）。
出力: inspect.json（id, class, evidence）。route.mjs がこれを読んでルーティングする。

    pip install pymupdf
    python inspect.py

分類語彙:
  scan-bitonal / scan-gray / scan-color  … 画像主体(テキスト極少)
  mixed                                   … テキスト＋画像
  vector                                  … 描画主体(テキスト少)
  text                                    … テキスト主体
"""
import json
import os

import pymupdf

HERE = os.path.dirname(os.path.abspath(__file__))
BENCH_ROOT = os.path.dirname(HERE)
MANIFEST = os.path.join(BENCH_ROOT, "corpus", "manifest.json")
OUT = os.path.join(HERE, "inspect.json")

MAX_PAGES = 6  # 判定に使う先頭ページ数(上限)


def classify(path: str) -> dict:
    doc = pymupdf.open(path)
    n = min(MAX_PAGES, doc.page_count)
    text_len = 0
    drawings = 0
    image_dominated = 0
    bpc_hist = {"bitonal": 0, "gray": 0, "color": 0}

    for i in range(n):
        page = doc.load_page(i)
        page_area = abs(page.rect.width * page.rect.height) or 1.0
        text_len += len((page.get_text() or "").strip())
        try:
            drawings += len(page.get_drawings())
        except Exception:
            pass

        # ページ上の最大画像の占有率と型
        max_cover = 0.0
        for img in page.get_images(full=True):
            xref = img[0]
            try:
                info = doc.extract_image(xref)
                bpc = info.get("bpc", 8)
                comp = info.get("colorspace", 3)  # 成分数
            except Exception:
                bpc, comp = 8, 3
            # 画像のページ占有率（描画矩形の和で近似）
            cover = 0.0
            for r in page.get_image_rects(xref):
                cover += abs(r.width * r.height)
            frac = cover / page_area
            if frac > max_cover:
                max_cover = frac
            # 型集計（占有の大きい画像を優先的に反映）
            key = "bitonal" if bpc == 1 else ("gray" if comp == 1 else "color")
            bpc_hist[key] += frac
        if max_cover >= 0.55:
            image_dominated += 1

    doc.close()
    img_ratio = image_dominated / n if n else 0.0

    # 支配的画像型
    dom_img = max(bpc_hist, key=bpc_hist.get) if sum(bpc_hist.values()) > 0 else None

    # ---- 分類ロジック ----
    if img_ratio >= 0.8 and text_len < 200:
        cls = {"bitonal": "scan-bitonal", "gray": "scan-gray", "color": "scan-color"}.get(dom_img, "scan-color")
    elif img_ratio >= 0.25 and text_len >= 200:
        cls = "mixed"
    elif drawings > 100 and text_len < 800:
        cls = "vector"
    else:
        cls = "text"

    return {
        "class": cls,
        "evidence": {
            "pagesInspected": n,
            "textLen": text_len,
            "imgRatio": round(img_ratio, 3),
            "drawings": drawings,
            "dominantImage": dom_img,
        },
    }


def main() -> None:
    manifest = json.load(open(MANIFEST, encoding="utf-8"))
    out = {"samples": []}
    print(f"{'id':<24} {'-> class':<14} {'text':>6} {'imgR':>5} {'draw':>6} {'domImg'}")
    for s in manifest["samples"]:
        path = os.path.join(BENCH_ROOT, s["path"])
        r = classify(path)
        e = r["evidence"]
        out["samples"].append({"id": s["id"], "manifestCategory": s["category"], **r})
        print(f"{s['id']:<24} {r['class']:<14} {e['textLen']:>6} {e['imgRatio']:>5} {e['drawings']:>6} {e['dominantImage']}")
    json.dump(out, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(f"\n[OK] -> {OUT}")


if __name__ == "__main__":
    main()
