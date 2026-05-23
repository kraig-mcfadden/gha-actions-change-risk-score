#!/usr/bin/env python3
"""Compute CRAP change-risk scores per function for a Python project.

CRAP(m) = comp(m)**2 * (1 - cov(m)/100)**3 + comp(m)

Complexity comes from `radon cc -j`. Coverage is read from a Cobertura XML
file produced by coverage.py. Per-function coverage is computed by intersecting
the function's line range (from radon) with the per-line hit counts in the
coverage XML — this avoids depending on the optional <methods> element, which
coverage.py does not always emit.
"""

import argparse
import json
import os
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path


def run_radon(source_path: str) -> dict:
    result = subprocess.run(
        ["radon", "cc", "-j", "-s", source_path],
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(result.stdout) if result.stdout.strip() else {}


def parse_coverage(coverage_xml: str) -> dict[str, dict[int, int]]:
    tree = ET.parse(coverage_xml)
    root = tree.getroot()
    files: dict[str, dict[int, int]] = {}
    for cls in root.iter("class"):
        filename = cls.get("filename")
        if not filename:
            continue
        lines: dict[int, int] = {}
        for line in cls.findall("lines/line"):
            number = line.get("number")
            hits = line.get("hits")
            if number is None or hits is None:
                continue
            lines[int(number)] = int(hits)
        files[norm_path(filename)] = lines
    return files


def norm_path(path: str) -> str:
    return Path(path).as_posix()


def find_file(coverage: dict[str, dict[int, int]], filename: str):
    key = norm_path(filename)
    if key in coverage:
        return coverage[key]
    # Suffix-match fallback: handles cases where one side is rooted at the
    # repo and the other at a sub-package.
    for candidate, lines in coverage.items():
        if candidate.endswith(key) or key.endswith(candidate):
            return lines
    return None


def function_coverage(lines_map, start: int, end: int):
    if lines_map is None:
        return None
    relevant = [hits for n, hits in lines_map.items() if start <= n <= end]
    if not relevant:
        return None
    covered = sum(1 for h in relevant if h > 0)
    return (covered / len(relevant)) * 100.0


def crap(complexity: int, coverage_pct: float) -> float:
    return complexity * complexity * (1 - coverage_pct / 100.0) ** 3 + complexity


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-path", required=True)
    parser.add_argument("--coverage-xml", required=True)
    parser.add_argument("--threshold", type=float, required=True)
    parser.add_argument("--top", default="", help="Limit PR comment table to N worst rows")
    parser.add_argument("--missing-policy", choices=["pessimistic", "optimistic", "skip"], default="pessimistic")
    parser.add_argument("--output-file", required=True)
    parser.add_argument("--violations-file", required=True)
    args = parser.parse_args()

    if not Path(args.coverage_xml).exists():
        print(f"error: coverage XML not found at {args.coverage_xml}", file=sys.stderr)
        return 2

    radon_data = run_radon(args.source_path)
    coverage_data = parse_coverage(args.coverage_xml)

    scores = []
    for filename, items in radon_data.items():
        if isinstance(items, dict) and "error" in items:
            continue
        if not isinstance(items, list):
            continue
        lines_map = find_file(coverage_data, filename)
        for item in items:
            if item.get("type") not in ("function", "method"):
                continue
            name = item["name"]
            classname = item.get("classname")
            full_name = f"{classname}.{name}" if classname else name
            complexity = int(item["complexity"])
            start = int(item["lineno"])
            end = int(item.get("endline", start))

            coverage_pct = function_coverage(lines_map, start, end)
            if coverage_pct is None:
                if args.missing_policy == "skip":
                    continue
                coverage_pct = 0.0 if args.missing_policy == "pessimistic" else 100.0

            scores.append({
                "file": norm_path(filename),
                "function": full_name,
                "line": start,
                "complexity": complexity,
                "coverage": coverage_pct,
                "crap": crap(complexity, coverage_pct),
            })

    scores.sort(key=lambda s: s["crap"], reverse=True)
    violations = [s for s in scores if s["crap"] > args.threshold]

    top_n = int(args.top) if args.top.strip() else len(scores)
    displayed = scores[:top_n]

    lines = []
    lines.append("## Change Risk Score (Python)")
    lines.append("")
    lines.append(
        f"Threshold **{args.threshold:g}** · Functions analyzed **{len(scores)}** · "
        f"Above threshold **{len(violations)}**"
    )
    lines.append("")

    if displayed:
        lines.append("| CRAP | Complexity | Coverage | Function | Location |")
        lines.append("|---:|---:|---:|---|---|")
        for s in displayed:
            mark = " :warning:" if s["crap"] > args.threshold else ""
            lines.append(
                f"| {s['crap']:.1f}{mark} | {s['complexity']} | {s['coverage']:.1f}% | "
                f"`{s['function']}` | `{s['file']}:{s['line']}` |"
            )
        if len(scores) > len(displayed):
            lines.append("")
            lines.append(f"_…and {len(scores) - len(displayed)} more functions._")
    else:
        lines.append("_No functions analyzed._")

    Path(args.output_file).write_text("\n".join(lines) + "\n")

    with open(args.violations_file, "w") as f:
        for v in violations:
            f.write(
                f"{v['file']}:{v['line']} {v['function']} "
                f"CRAP={v['crap']:.1f} complexity={v['complexity']} coverage={v['coverage']:.1f}%\n"
            )

    print(f"Analyzed {len(scores)} functions; {len(violations)} above threshold {args.threshold:g}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
