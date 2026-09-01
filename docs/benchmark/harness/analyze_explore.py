#!/usr/bin/env python3
"""explore-results-ssim.json を解析し、プリセットを詰めるための知見を出す。

    python compute_ssim.py explore-results.json   # 先に SSIM 付与
    python analyze_explore.py

出力:
- カテゴリ×(dpi,quality) の 削減率/SSIM 表
- SSIM閾値(既定0.90)を満たしつつ最大削減となる設定 (= 推奨プリセット候補)
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SSIM_JSON = os.path.join(HERE, "explore-results-ssim.json")
THRESHOLD = float(sys.argv[1]) if len(sys.argv) > 1 else 0.90


def main() -> None:
    rows = [r for r in json.load(open(SSIM_JSON, encoding="utf-8"))["results"]
            if not r.get("error") and r.get("valid")]
    cats = sorted({r["category"] for r in rows})

    for cat in cats:
        rs = [r for r in rows if r["category"] == cat]
        print(f"\n### {cat} (削減率 / SSIM) ###")
        dpis = sorted({r["dpi"] for r in rs})
        quals = sorted({r["jpegQuality"] for r in rs})
        print("dpi\\q   " + "  ".join(f"{q:>12}" for q in quals))
        for dpi in dpis:
            cells = []
            for q in quals:
                m = next((r for r in rs if r["dpi"] == dpi and r["jpegQuality"] == q), None)
                if m and m.get("ssimMean") is not None:
                    cells.append(f"{m['reductionRatio']*100:5.1f}%/{m['ssimMean']:.3f}")
                else:
                    cells.append(f"{'-':>12}")
            print(f"{dpi:>5}  " + "  ".join(f"{c:>12}" for c in cells))

    print(f"\n=== SSIM≥{THRESHOLD} を満たす最大削減設定（カテゴリ別・推奨候補） ===")
    print(f"{'category':<16} {'dpi':>4} {'q':>4} {'reduction':>10} {'SSIM':>7}")
    for cat in cats:
        rs = [r for r in rows if r["category"] == cat and r.get("ssimMean") is not None
              and r["ssimMean"] >= THRESHOLD]
        if not rs:
            print(f"{cat:<16} (SSIM≥{THRESHOLD} を満たす設定なし)")
            continue
        best = max(rs, key=lambda r: r["reductionRatio"])
        print(f"{cat:<16} {best['dpi']:>4} {best['jpegQuality']:>4} "
              f"{best['reductionRatio']*100:9.1f}% {best['ssimMean']:>7.3f}")


if __name__ == "__main__":
    main()
