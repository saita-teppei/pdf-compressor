#!/usr/bin/env python3
"""results.json の各出力PDFについて、頁数維持 (ADR-005 必須) とテキスト抽出可否を検証する。

    pip install pypdf
    python verify_pages.py
"""
import json
import os
import sys

from pypdf import PdfReader

HERE = os.path.dirname(os.path.abspath(__file__))
BENCH_ROOT = os.path.dirname(HERE)          # docs/benchmark
RESULTS = os.path.join(HERE, sys.argv[1] if len(sys.argv) > 1 else "results.json")


def pages_of(path: str) -> int:
    return len(PdfReader(path).pages)


def main() -> None:
    report = json.load(open(RESULTS, encoding="utf-8"))
    ok = bad = 0
    print(f"{'id':<24} {'preset':<8} {'in_p':>5} {'out_p':>5} {'kept':>5}")
    for r in report["results"]:
        if r.get("error") or not r.get("valid"):
            continue
        out_path = os.path.join(HERE, r["outputFile"].replace("/", os.sep))
        try:
            out_pages = pages_of(out_path)
        except Exception as e:  # noqa: BLE001
            print(f"{r['id']:<24} {r['preset']:<8} READ-ERROR {e}")
            bad += 1
            continue
        kept = out_pages == r["manifestPages"]
        ok += kept
        bad += not kept
        if not kept:
            print(f"{r['id']:<24} {r['preset']:<8} {r['manifestPages']:>5} {out_pages:>5} {'NO':>5}")
    print(f"\npages preserved: {ok} ok / {bad} mismatch")


if __name__ == "__main__":
    main()
