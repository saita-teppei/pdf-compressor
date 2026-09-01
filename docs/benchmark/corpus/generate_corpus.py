#!/usr/bin/env python3
"""ベンチマーク用 合成PDFコーパス生成器 (ADR-005 / CORPUS.md)。

権利方針 (CORPUS.md §1):
- 内容はすべて手続き的に生成する。第三者の著作物・実在の機微情報は一切含まない。
- スキャン/写真系ページはラスタライズ (出力はピクセルのみ) する。
- テキスト層は ReportLab の CID フォント (HeiseiMin-W3) を「参照」し、フォント実体は
  PDF に埋め込まない (フォントの再配布をしない)。ラスタ描画には OS 同梱の日本語フォントを
  用いるが、出力はピクセル化されるためフォントは配布されない。

生成物 (PDF) はリポジトリにコミットせず、本スクリプトで再現する前提。

使い方:
    python generate_corpus.py                 # small + medium を生成
    python generate_corpus.py --sizes small   # small のみ
    python generate_corpus.py --large         # large(50-100MB相当) も含める
    python generate_corpus.py --out ./corpus  # 出力先
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import random
from dataclasses import dataclass, field

import img2pdf
from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfgen import canvas

# ---- 定数 ----------------------------------------------------------------

PAGE_W, PAGE_H = A4  # ポイント (595 x 842)

# ラスタ描画用フォント (OS同梱・出力はピクセル化されるため再配布に当たらない)
RASTER_FONT_CANDIDATES = [
    "C:/Windows/Fonts/YuGothM.ttc",
    "C:/Windows/Fonts/meiryo.ttc",
    "C:/Windows/Fonts/msgothic.ttc",
    "C:/Windows/Fonts/yumin.ttf",
]

# 手続き的テキスト素材 (著作物ではない)
LATIN_WORDS = (
    "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod "
    "tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam "
    "quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo"
).split()

JA_POOL = list(
    "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめも"
    "やゆよらりるれろわをん文書圧縮試験見本本文段落頁画像縦書横書日本語"
)

CATEGORIES = [
    "scan-bw", "scan-gray", "scan-color", "photo",
    "text", "mixed", "vector", "vertical-ja",
]

# サイズ帯ごとの生成パラメータ (nominal。実サイズは生成後に計測して manifest に記録)
SIZE_SPEC = {
    "small":  {"scan_pages": 2,  "scan_dpi": 100, "text_pages": 2,  "jpeg_q": 80},
    "medium": {"scan_pages": 16, "scan_dpi": 150, "text_pages": 40, "jpeg_q": 85},
    "large":  {"scan_pages": 60, "scan_dpi": 200, "text_pages": 200, "jpeg_q": 90},
}


# ---- ラスタ (スキャン/写真) ----------------------------------------------

def _load_raster_font(size: int) -> ImageFont.FreeTypeFont:
    for path in RASTER_FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size, index=0)
            except Exception:
                continue
    return ImageFont.load_default()


def _px_size(dpi: int) -> tuple[int, int]:
    # A4 を指定DPIでピクセル化
    return int(8.27 * dpi), int(11.69 * dpi)


def make_scan_page(dpi: int, mode: str, rng: random.Random, japanese: bool) -> Image.Image:
    """スキャン文書風のページ画像を生成する。mode: '1'|'L'|'RGB'。"""
    w, h = _px_size(dpi)
    img = Image.new("RGB", (w, h), (255, 255, 255))
    d = ImageDraw.Draw(img)
    margin = int(w * 0.08)
    font = _load_raster_font(int(dpi * 0.16))
    y = margin
    line_h = int(dpi * 0.28)
    while y < h - margin:
        if japanese:
            n = rng.randint(18, 34)
            line = "".join(rng.choice(JA_POOL) for _ in range(n))
        else:
            n = rng.randint(8, 14)
            line = " ".join(rng.choice(LATIN_WORDS) for _ in range(n))
        d.text((margin, y), line, fill=(20, 20, 20), font=font)
        y += line_h
    # スキャンらしいノイズ・スペックル
    for _ in range(int(w * h * 0.0008)):
        x = rng.randint(0, w - 1); yy = rng.randint(0, h - 1)
        v = rng.randint(120, 210)
        d.point((x, yy), fill=(v, v, v))
    if mode == "L":
        img = img.convert("L")
    elif mode == "1":
        img = img.convert("L").point(lambda p: 255 if p > 128 else 0, mode="1")
    return img


def make_photo_page(dpi: int, rng: random.Random) -> Image.Image:
    """高エントロピーな写真風画像 (グラデ + ノイズ + 図形)。"""
    w, h = _px_size(dpi)
    # グラデーション基調
    base = Image.new("RGB", (w, h))
    px = base.load()
    r0, g0, b0 = rng.randint(0, 255), rng.randint(0, 255), rng.randint(0, 255)
    r1, g1, b1 = rng.randint(0, 255), rng.randint(0, 255), rng.randint(0, 255)
    for yy in range(h):
        t = yy / h
        row = (int(r0 + (r1 - r0) * t), int(g0 + (g1 - g0) * t), int(b0 + (b1 - b0) * t))
        for xx in range(0, w, 1):
            px[xx, yy] = row
    d = ImageDraw.Draw(base)
    for _ in range(60):
        x0 = rng.randint(0, w); y0 = rng.randint(0, h)
        x1 = rng.randint(0, w); y1 = rng.randint(0, h)
        col = tuple(rng.randint(0, 255) for _ in range(3))
        d.ellipse([min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)], fill=col)
    # 画素ノイズ (JPEGでも縮みにくい高エントロピー)
    noise = Image.effect_noise((w, h), rng.randint(30, 90)).convert("RGB")
    return Image.blend(base, noise, 0.35)


def draw_image_page(c: canvas.Canvas, pil_img: Image.Image, jpeg_q: int) -> None:
    """PIL画像を全面に配置。カラー/グレーはJPEG(DCT)、白黒はPNG(Flate)で埋め込む。"""
    buf = io.BytesIO()
    if pil_img.mode in ("RGB", "L"):
        pil_img.save(buf, format="JPEG", quality=jpeg_q)
    else:  # '1' (白黒)
        pil_img.save(buf, format="PNG")
    buf.seek(0)
    c.drawImage(ImageReader(buf), 0, 0, width=PAGE_W, height=PAGE_H)
    c.showPage()


# ---- テキスト / ベクター (テキスト層あり) ---------------------------------

JP_FONT = "HeiseiMin-W3"  # CID参照 (埋め込まない)


def draw_text_page(c: canvas.Canvas, rng: random.Random, japanese: bool, title: str | None = None) -> None:
    x = 56; y = PAGE_H - 72
    if title:
        c.setFont(JP_FONT if japanese else "Helvetica-Bold", 16)
        c.drawString(x, y, title); y -= 28
    size = 11
    c.setFont(JP_FONT if japanese else "Helvetica", size)
    lh = size * 1.6
    while y > 64:
        if japanese:
            line = "".join(rng.choice(JA_POOL) for _ in range(rng.randint(28, 40)))
        else:
            line = " ".join(rng.choice(LATIN_WORDS) for _ in range(rng.randint(10, 16)))
        c.drawString(x, y, line); y -= lh
    c.showPage()


def draw_vertical_ja_page(c: canvas.Canvas, rng: random.Random) -> None:
    """日本語縦書き: 右→左の列、各列は上→下に1文字ずつ配置 (テキスト層あり)。"""
    c.setFont(JP_FONT, 14)
    col_x = PAGE_W - 64
    col_w = 22
    top_y = PAGE_H - 64
    while col_x > 56:
        y = top_y
        n = rng.randint(30, 44)
        for _ in range(n):
            ch = rng.choice(JA_POOL)
            c.drawString(col_x, y, ch)
            y -= 20
            if y < 64:
                break
        col_x -= col_w
    c.showPage()


def draw_vector_page(c: canvas.Canvas, rng: random.Random) -> None:
    """ベクター図形主体のページ (テキスト少量 + 多数のパス)。"""
    for _ in range(400):
        x0 = rng.uniform(40, PAGE_W - 40); y0 = rng.uniform(40, PAGE_H - 40)
        x1 = rng.uniform(40, PAGE_W - 40); y1 = rng.uniform(40, PAGE_H - 40)
        c.setStrokeColorRGB(rng.random(), rng.random(), rng.random())
        c.setLineWidth(rng.uniform(0.3, 2.0))
        if rng.random() < 0.5:
            c.line(x0, y0, x1, y1)
        else:
            c.setFillColorRGB(rng.random(), rng.random(), rng.random())
            c.rect(min(x0, x1), min(y0, y1), abs(x1 - x0), abs(y1 - y0), stroke=1, fill=1)
    c.setFillColorRGB(0, 0, 0)
    c.setFont("Helvetica", 10)
    c.drawString(48, 40, "vector sample")
    c.showPage()


# ---- 各カテゴリの生成 ------------------------------------------------------

@dataclass
class Sample:
    sample_id: str
    category: str
    path: str
    pages: int
    features: list[str]
    has_text: bool


def _new_canvas(path: str, title: str) -> canvas.Canvas:
    c = canvas.Canvas(path, pagesize=A4)
    c.setTitle(title)
    c.setAuthor("corpus-generator (synthetic)")
    c.setSubject("benchmark synthetic sample")
    return c


def gen_scan(cat: str, mode: str, spec: dict, out_dir: str, rng: random.Random, size: str) -> Sample:
    sid = f"{cat}-{size}-01"
    path = os.path.join(out_dir, cat, f"{size}-01.pdf")
    c = _new_canvas(path, f"{cat} {size}")
    for _ in range(spec["scan_pages"]):
        img = make_scan_page(spec["scan_dpi"], mode, rng, japanese=(rng.random() < 0.5))
        draw_image_page(c, img, spec["jpeg_q"])
    c.save()
    return Sample(sid, cat, path, spec["scan_pages"], ["images"], False)


def gen_scan_bitonal(cat: str, spec: dict, out_dir: str, rng: random.Random, size: str) -> Sample:
    """2値スキャンは真の1-bit(CCITT G4)で埋め込む。

    ReportLab の drawImage は入力が 1-bit でも常に RGB8 へ展開してしまい、PDF 上で
    bitonal にならない（実測で確認）。そこで scan-bw のみ img2pdf を使い、CCITTFax(G4)の
    1-bit 画像として埋め込む。これによりコンテンツ別ルーティング(ADR-010)の bpc==1 判定で
    正しく scan-bitonal と分類できる（アプリ側 inspect の検証用）。
    """
    sid = f"{cat}-{size}-01"
    path = os.path.join(out_dir, cat, f"{size}-01.pdf")
    dpi = spec["scan_dpi"]
    pages: list[bytes] = []
    for _ in range(spec["scan_pages"]):
        img = make_scan_page(dpi, "1", rng, japanese=(rng.random() < 0.5))
        buf = io.BytesIO()
        img.save(buf, format="TIFF", compression="group4", dpi=(dpi, dpi))
        pages.append(buf.getvalue())
    a4 = (img2pdf.mm_to_pt(210), img2pdf.mm_to_pt(297))
    layout = img2pdf.get_layout_fun(a4)
    with open(path, "wb") as f:
        f.write(img2pdf.convert(pages, layout_fun=layout))
    return Sample(sid, cat, path, spec["scan_pages"], ["images"], False)


def gen_photo(spec: dict, out_dir: str, rng: random.Random, size: str) -> Sample:
    sid = f"photo-{size}-01"
    path = os.path.join(out_dir, "photo", f"{size}-01.pdf")
    c = _new_canvas(path, f"photo {size}")
    pages = max(1, spec["scan_pages"] // 2)
    for _ in range(pages):
        draw_image_page(c, make_photo_page(spec["scan_dpi"], rng), spec["jpeg_q"])
    c.save()
    return Sample(sid, "photo", path, pages, ["images"], False)


def gen_text(spec: dict, out_dir: str, rng: random.Random, size: str) -> Sample:
    sid = f"text-{size}-01"
    path = os.path.join(out_dir, "text", f"{size}-01.pdf")
    c = _new_canvas(path, f"text {size}")
    n = spec["text_pages"]
    for i in range(n):
        # しおり用アウトライン
        key = f"p{i}"
        c.bookmarkPage(key)
        c.addOutlineEntry(f"Section {i + 1}", key, level=0)
        draw_text_page(c, rng, japanese=(i % 3 == 0), title=f"Section {i + 1}")
    c.save()
    return Sample(sid, "text", path, n, ["text", "bookmarks"], True)


def gen_mixed(spec: dict, out_dir: str, rng: random.Random, size: str) -> Sample:
    sid = f"mixed-{size}-01"
    path = os.path.join(out_dir, "mixed", f"{size}-01.pdf")
    c = _new_canvas(path, f"mixed {size}")
    n = max(2, spec["text_pages"] // 3)
    for i in range(n):
        if i % 2 == 0:
            # テキスト + リンク注釈
            c.bookmarkPage(f"m{i}")
            c.addOutlineEntry(f"Chapter {i + 1}", f"m{i}", level=0)
            draw_text_page(c, rng, japanese=(i % 4 == 0), title=f"Chapter {i + 1}")
        else:
            img = make_scan_page(spec["scan_dpi"], "RGB", rng, japanese=False)
            draw_image_page(c, img, spec["jpeg_q"])
    c.save()
    return Sample(sid, "mixed", path, n, ["text", "images", "bookmarks"], True)


def gen_vector(spec: dict, out_dir: str, rng: random.Random, size: str) -> Sample:
    sid = f"vector-{size}-01"
    path = os.path.join(out_dir, "vector", f"{size}-01.pdf")
    c = _new_canvas(path, f"vector {size}")
    pages = max(2, spec["text_pages"] // 8)
    for _ in range(pages):
        draw_vector_page(c, rng)
    c.save()
    return Sample(sid, "vector", path, pages, ["vector", "text"], True)


def gen_vertical_ja(spec: dict, out_dir: str, rng: random.Random, size: str) -> Sample:
    sid = f"vertical-ja-{size}-01"
    path = os.path.join(out_dir, "vertical-ja", f"{size}-01.pdf")
    c = _new_canvas(path, f"vertical-ja {size}")
    pages = max(2, spec["text_pages"] // 8)
    for _ in range(pages):
        draw_vertical_ja_page(c, rng)
    c.save()
    return Sample(sid, "vertical-ja", path, pages, ["text"], True)


# ---- manifest --------------------------------------------------------------

def sha256_of(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def build_manifest_entry(s: Sample, out_dir: str) -> dict:
    size_bytes = os.path.getsize(s.path)
    rel = os.path.relpath(s.path, out_dir).replace("\\", "/")
    return {
        "id": s.sample_id,
        "path": f"corpus/{rel}",
        "category": s.category,
        "sizeBytes": size_bytes,
        "pages": s.pages,
        "source": "self-generated",
        "license": "CC0-1.0",
        "notes": "procedurally generated synthetic sample",
        "features": s.features,
        "hasText": s.has_text,
        "hasSignature": False,
        "sha256": sha256_of(s.path),
    }


# ---- メイン ----------------------------------------------------------------

def main() -> None:
    ap = argparse.ArgumentParser(description="synthetic PDF corpus generator")
    ap.add_argument("--out", default=os.path.dirname(os.path.abspath(__file__)),
                    help="出力ルート (既定: このスクリプトのあるディレクトリ)")
    ap.add_argument("--sizes", nargs="*", default=["small", "medium"],
                    choices=["small", "medium", "large"])
    ap.add_argument("--large", action="store_true", help="large も含める")
    ap.add_argument("--seed", type=int, default=20260901)
    args = ap.parse_args()

    sizes = list(dict.fromkeys(args.sizes + (["large"] if args.large else [])))

    pdfmetrics.registerFont(UnicodeCIDFont(JP_FONT))

    for cat in CATEGORIES:
        os.makedirs(os.path.join(args.out, cat), exist_ok=True)

    samples: list[Sample] = []
    for size in sizes:
        spec = SIZE_SPEC[size]
        rng = random.Random(args.seed + hash(size) % 100000)
        print(f"[+] generating size={size} ...")
        samples.append(gen_scan_bitonal("scan-bw", spec, args.out, rng, size))
        samples.append(gen_scan("scan-gray", "L", spec, args.out, rng, size))
        samples.append(gen_scan("scan-color", "RGB", spec, args.out, rng, size))
        samples.append(gen_photo(spec, args.out, rng, size))
        samples.append(gen_text(spec, args.out, rng, size))
        samples.append(gen_mixed(spec, args.out, rng, size))
        samples.append(gen_vector(spec, args.out, rng, size))
        samples.append(gen_vertical_ja(spec, args.out, rng, size))

    manifest = {
        "generatedBy": "generate_corpus.py",
        "note": "All samples are procedurally generated (CC0). Regenerate with generate_corpus.py; do not rely on committed PDFs.",
        "samples": [build_manifest_entry(s, args.out) for s in samples],
    }
    manifest_path = os.path.join(args.out, "manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    total = sum(e["sizeBytes"] for e in manifest["samples"])
    print(f"[OK] {len(samples)} samples, total {total/1e6:.1f} MB")
    for e in manifest["samples"]:
        print(f"    {e['id']:<24} {e['pages']:>4}p  {e['sizeBytes']/1e6:7.2f} MB")
    print(f"[OK] manifest: {manifest_path}")


if __name__ == "__main__":
    main()
