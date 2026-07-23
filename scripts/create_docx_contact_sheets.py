#!/usr/bin/env python3
"""把 DOCX 渲染页按四页一组生成 QA 联络表，便于逐页目检。"""

from __future__ import annotations

import argparse
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def natural_page_key(path: Path) -> int:
    return int(path.stem.split("-")[-1])


def find_font(size: int):
    for candidate in (
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
    ):
        if Path(candidate).exists():
            return ImageFont.truetype(candidate, size=size)
    return ImageFont.load_default()


def build_sheet(paths: list[Path], output: Path, label: str) -> None:
    thumb_width = 850
    margin = 36
    header = 70
    footer = 34
    gap = 30
    thumbs: list[tuple[Image.Image, int, int]] = []
    max_height = 0
    for path in paths:
        image = Image.open(path).convert("RGB")
        height = round(image.height * thumb_width / image.width)
        resized = image.resize((thumb_width, height), Image.Resampling.LANCZOS)
        thumbs.append((resized, natural_page_key(path), height))
        max_height = max(max_height, height)

    canvas_width = margin * 2 + thumb_width * 2 + gap
    canvas_height = header + max_height * 2 + gap + footer + margin
    canvas = Image.new("RGB", (canvas_width, canvas_height), "#ECEEF2")
    draw = ImageDraw.Draw(canvas)
    title_font = find_font(26)
    page_font = find_font(20)
    draw.text((margin, 22), label, fill="#4A4B50", font=title_font)

    for index, (image, page_number, height) in enumerate(thumbs):
        row = index // 2
        col = index % 2
        x = margin + col * (thumb_width + gap)
        y = header + row * (max_height + gap)
        canvas.paste(image, (x, y))
        draw.rectangle(
            (x, y, x + thumb_width - 1, y + height - 1),
            outline="#C6C8CE",
            width=2,
        )
        draw.rectangle(
            (x + 12, y + 12, x + 116, y + 48),
            fill="#FFFFFF",
            outline="#D8A6B9",
            width=1,
        )
        draw.text(
            (x + 24, y + 17),
            f"第 {page_number} 页",
            fill="#8F244B",
            font=page_font,
        )

    output.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output, format="PNG", optimize=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("render_dir", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--label", default="DOCX 全页渲染检查")
    args = parser.parse_args()

    pages = sorted(args.render_dir.glob("page-*.png"), key=natural_page_key)
    if not pages:
        raise SystemExit(f"未找到渲染页：{args.render_dir}")
    group_size = 4
    total_sheets = math.ceil(len(pages) / group_size)
    for sheet_index in range(total_sheets):
        chunk = pages[sheet_index * group_size : (sheet_index + 1) * group_size]
        output = args.output_dir / f"sheet-{sheet_index + 1:02d}.png"
        build_sheet(
            chunk,
            output,
            f"{args.label}｜{sheet_index + 1}/{total_sheets}",
        )
        print(output)


if __name__ == "__main__":
    main()
