#!/usr/bin/env python3
"""校验 99 页、408 个 Figma 最终状态及 179 个客户文档图片映射。"""

from __future__ import annotations

import argparse
import hashlib
import json
from collections import OrderedDict
from datetime import date
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps


ROOT = Path(__file__).resolve().parents[1]
ASSET_DIR = ROOT / "docs/app/assets/page-prototypes"
MANIFEST_PATH = ASSET_DIR / "manifest.json"
QA_DIR = ASSET_DIR / "qa/contact-sheets"
FONT_CANDIDATES = (
    Path("/System/Library/Fonts/PingFang.ttc"),
    Path("/System/Library/Fonts/STHeiti Medium.ttc"),
    Path("/private/tmp/meigallery-fonts/ArialUnicode.ttf"),
)


def font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for candidate in FONT_CANDIDATES:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size=size)
    return ImageFont.load_default()


def read_manifest() -> dict:
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


def image_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_counts(manifest: dict) -> None:
    counts = manifest["counts"]
    expected = {
        "pages": 99,
        "mobilePages": 50,
        "adminPages": 49,
        "p0Pages": 57,
        "p1Pages": 32,
        "p2Pages": 10,
        "defaultCaptures": 99,
        "keyStateCaptures": 57,
        "totalCaptures": 156,
        "detailedFigmaPages": 5,
        "detailedFigmaStateCaptures": 23,
        "documentPrototypeMappings": 179,
        "figmaDesignedPages": 99,
        "figmaDesignedStates": 408,
        "figmaMobileStates": 208,
        "figmaAdminStates": 200,
        "figmaFlowPreviews": 99,
        "figmaMobilePageActions": 928,
        "figmaMobileSupportActions": 1076,
        "figmaMobileFlowActions": 180,
        "figmaAdminPageActions": 2043,
        "figmaAdminFlowActions": 434,
        "figmaPageActions": 2971,
        "figmaFlowActions": 614,
        "figmaActionTotal": 3585,
        "figmaHistoricalPageActionBaseline": 2957,
        "figmaHistoricalFlowActionBaseline": 614,
        "figmaHistoricalActionBaseline": 3571,
        "supplementalFigmaCaptures": 136,
        "groups": 15,
    }
    for key, value in expected.items():
        if counts.get(key) != value:
            raise ValueError(f"{key} 数量错误：期望 {value}，实际 {counts.get(key)}")

    pages = manifest.get("pages", [])
    page_ids = [page["pageId"] for page in pages]
    if len(page_ids) != len(set(page_ids)):
        raise ValueError("Page ID 存在重复")
    state_totals = {"mobile": 0, "admin": 0}
    for page in pages:
        states = page.get("states")
        if not isinstance(states, list) or not states:
            raise ValueError(f"{page['pageId']} 缺少正式状态")
        if any(
            not isinstance(state, str) or not state or state.strip() != state
            for state in states
        ):
            raise ValueError(f"{page['pageId']} 存在空白或未规范化的正式状态名称")
        if len(states) != len(set(states)):
            raise ValueError(f"{page['pageId']} 存在重复正式状态")
        platform = page.get("platform")
        if platform not in state_totals:
            raise ValueError(f"{page['pageId']} 平台类型无效：{platform!r}")
        state_totals[platform] += len(states)
    derived = {
        "figmaDesignedPages": len(pages),
        "figmaDesignedStates": sum(state_totals.values()),
        "figmaMobileStates": state_totals["mobile"],
        "figmaAdminStates": state_totals["admin"],
    }
    for key, value in derived.items():
        if counts.get(key) != value:
            raise ValueError(
                f"{key} 与逐页正式状态不一致：清单 {counts.get(key)}，实际 {value}"
            )
    if int(manifest.get("schemaVersion", 0)) < 4:
        raise ValueError("原型清单缺少 Figma 全量最终交付 schema")


def all_captures(manifest: dict) -> list[dict]:
    return [
        *manifest["captures"],
        *manifest.get("figmaStateCaptures", []),
        *manifest.get("supplementalFigmaCaptures", []),
    ]


def normalize_images(manifest: dict) -> None:
    """浏览器截图可能返回 JPEG 字节；统一转换为与扩展名一致的无损 PNG。"""
    for capture in all_captures(manifest):
        path = ASSET_DIR / capture["image"]
        if not path.exists():
            continue
        with Image.open(path) as source:
            source.load()
            if source.format == "PNG":
                continue
            normalized = source.convert("RGB")
        normalized.save(path, format="PNG", optimize=True)


def validate_images(manifest: dict) -> None:
    expected_files: set[Path] = set()
    hashes: dict[str, str] = {}

    for capture in all_captures(manifest):
        relative_path = Path(capture["image"])
        path = ASSET_DIR / relative_path
        expected_files.add(path.resolve())
        if not path.exists():
            raise FileNotFoundError(f"缺少原型图：{path.relative_to(ROOT)}")
        if path.suffix.lower() != ".png":
            raise ValueError(f"原型图不是 PNG：{path.relative_to(ROOT)}")

        with Image.open(path) as image:
            image.load()
            if image.format != "PNG":
                raise ValueError(f"扩展名与实际格式不一致：{path.relative_to(ROOT)}")
            width, height = image.size
            expected_size = (
                int(capture["expectedWidth"]),
                int(capture["expectedHeight"]),
            )
            if (width, height) != expected_size:
                raise ValueError(
                    f"{path.relative_to(ROOT)} 尺寸错误："
                    f"期望 {expected_size[0]}×{expected_size[1]}，"
                    f"实际 {width}×{height}"
                )

        sha256 = image_hash(path)
        if sha256 in hashes:
            raise ValueError(
                f"原型图内容重复：{path.relative_to(ROOT)} 与 {hashes[sha256]}"
            )
        hashes[sha256] = str(path.relative_to(ROOT))
        capture["width"] = width
        capture["height"] = height
        capture["sha256"] = sha256
        capture["bytes"] = path.stat().st_size
        capture["status"] = "verified"

    archive = manifest.get("historicalCaptureArchive", {})
    archived_captures = archive.get("captures", [])
    if archive.get("scope") != "历史阶段截图；不属于当前 408 状态或 307 张开发规格图片映射。":
        raise ValueError("历史截图归档缺少明确的非当前范围说明")
    if len(archived_captures) != 51:
        raise ValueError("历史截图归档数量不是 51 张")
    archived_paths: set[Path] = set()
    for capture in archived_captures:
        relative_path = Path(capture["image"])
        path = ASSET_DIR / relative_path
        resolved = path.resolve()
        if resolved in expected_files or resolved in archived_paths:
            raise ValueError(f"历史截图重复登记：{path.relative_to(ROOT)}")
        archived_paths.add(resolved)
        expected_files.add(resolved)
        if not path.exists():
            raise FileNotFoundError(f"缺少历史归档图：{path.relative_to(ROOT)}")
        if capture.get("status") != "archived" or "不得作为当前交付依据" not in capture.get("archiveReason", ""):
            raise ValueError(f"历史截图未明确标记归档：{path.relative_to(ROOT)}")
        with Image.open(path) as image:
            image.load()
            if image.format != "PNG":
                raise ValueError(f"历史归档图不是 PNG：{path.relative_to(ROOT)}")
            if [image.width, image.height] != [capture.get("width"), capture.get("height")]:
                raise ValueError(f"历史归档图尺寸与清单不一致：{path.relative_to(ROOT)}")
        if image_hash(path) != capture.get("sha256") or path.stat().st_size != capture.get("bytes"):
            raise ValueError(f"历史归档图内容与清单不一致：{path.relative_to(ROOT)}")

    actual_files = {
        path.resolve()
        for directory in (
            ASSET_DIR / "mobile",
            ASSET_DIR / "admin",
            ASSET_DIR / "figma-final",
        )
        for path in directory.rglob("*.png")
    }
    extra = sorted(actual_files - expected_files)
    if extra:
        formatted = "、".join(str(path.relative_to(ROOT)) for path in extra)
        raise ValueError(f"存在未被清单引用的原型图：{formatted}")

    manifest["verifiedAt"] = date.today().isoformat()
    manifest["status"] = "verified"
    MANIFEST_PATH.write_text(
        f"{json.dumps(manifest, ensure_ascii=False, indent=2)}\n",
        encoding="utf-8",
    )


def fit_image(path: Path, size: tuple[int, int]) -> Image.Image:
    with Image.open(path) as source:
        image = ImageOps.fit(
            source.convert("RGB"),
            size,
            method=Image.Resampling.LANCZOS,
            centering=(0.5, 0.5),
        )
    return image


def contact_sheet(
    title: str,
    captures: list[dict],
    output: Path,
) -> None:
    columns = 3
    tile_width = 500
    image_height = 312
    label_height = 54
    tile_height = image_height + label_height
    gap = 18
    header_height = 84
    rows = (len(captures) + columns - 1) // columns
    width = columns * tile_width + (columns + 1) * gap
    height = header_height + rows * tile_height + (rows + 1) * gap
    canvas = Image.new("RGB", (width, height), "#eef0f4")
    draw = ImageDraw.Draw(canvas)
    draw.text((gap, 18), title, fill="#20212a", font=font(30))
    draw.text(
        (gap, 54),
        f"共 {len(captures)} 张 · 默认态与 P0 关键状态均按 Page ID 映射",
        fill="#666a78",
        font=font(16),
    )

    for index, capture in enumerate(captures):
        row, column = divmod(index, columns)
        x = gap + column * (tile_width + gap)
        y = header_height + gap + row * (tile_height + gap)
        draw.rounded_rectangle(
            (x, y, x + tile_width, y + tile_height),
            radius=14,
            fill="#ffffff",
            outline="#d9dce3",
            width=2,
        )
        image = fit_image(ASSET_DIR / capture["image"], (tile_width, image_height))
        canvas.paste(image, (x, y))
        label = (
            f"{capture['pageId']} · {capture['pageName']} · "
            f"{capture['state']} · "
            f"{'默认态' if capture['variant'] == 'default' else '关键状态'}"
        )
        draw.text(
            (x + 12, y + image_height + 12),
            label,
            fill="#30323a",
            font=font(15),
        )

    output.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output, format="PNG", optimize=True)


def figma_contact_sheet(
    captures: list[dict],
    output: Path,
) -> None:
    columns = 4
    tile_width = 260
    image_width = 228
    image_height = 468
    label_height = 70
    tile_height = image_height + label_height + 18
    gap = 16
    header_height = 92
    rows = (len(captures) + columns - 1) // columns
    width = columns * tile_width + (columns + 1) * gap
    height = header_height + rows * tile_height + (rows + 1) * gap
    canvas = Image.new("RGB", (width, height), "#f8eef3")
    draw = ImageDraw.Draw(canvas)
    draw.text(
        (gap, 16),
        "15 · 移动端 · 通知与金币 Figma 最终状态",
        fill="#8f244b",
        font=font(29),
    )
    draw.text(
        (gap, 54),
        f"共 {len(captures)} 张 · Page ID / 状态 / Frame ID 确定性映射",
        fill="#666a78",
        font=font(16),
    )

    for index, capture in enumerate(captures):
        row, column = divmod(index, columns)
        x = gap + column * (tile_width + gap)
        y = header_height + gap + row * (tile_height + gap)
        draw.rounded_rectangle(
            (x, y, x + tile_width, y + tile_height),
            radius=14,
            fill="#ffffff",
            outline="#e5bacb",
            width=2,
        )
        with Image.open(ASSET_DIR / capture["image"]) as source:
            image = ImageOps.contain(
                source.convert("RGB"),
                (image_width, image_height),
                method=Image.Resampling.LANCZOS,
            )
        image_x = x + (tile_width - image.width) // 2
        image_y = y + 10
        canvas.paste(image, (image_x, image_y))
        draw.text(
            (x + 10, y + image_height + 16),
            f"{capture['pageId']} · {capture['state']}",
            fill="#30323a",
            font=font(14),
        )
        draw.text(
            (x + 10, y + image_height + 40),
            f"Frame {capture['frameId']}",
            fill="#8f244b",
            font=font(13),
        )

    output.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output, format="PNG", optimize=True)


def generate_contact_sheets(manifest: dict) -> None:
    grouped: OrderedDict[tuple[str, str], list[dict]] = OrderedDict()
    for page in manifest["pages"]:
        key = (page["platform"], page["module"])
        grouped.setdefault(key, [])
    for capture in manifest["captures"]:
        grouped[(capture["platform"], capture["module"])].append(capture)

    QA_DIR.mkdir(parents=True, exist_ok=True)
    expected_sheets: set[Path] = set()
    for index, ((platform, module), captures) in enumerate(grouped.items(), start=1):
        output = QA_DIR / f"{index:02d}-{platform}.png"
        expected_sheets.add(output.resolve())
        contact_sheet(
            f"{index:02d} · {'移动端' if platform == 'mobile' else '管理后台'} · {module}",
            captures,
            output,
        )

    figma_output = QA_DIR / "15-mobile-figma-final.png"
    expected_sheets.add(figma_output.resolve())
    figma_contact_sheet(manifest["figmaStateCaptures"], figma_output)

    actual_sheets = {path.resolve() for path in QA_DIR.glob("*.png")}
    for path in actual_sheets - expected_sheets:
        path.unlink()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--skip-contact-sheets",
        action="store_true",
        help="只校验图片，不生成联系表",
    )
    args = parser.parse_args()

    manifest = read_manifest()
    validate_counts(manifest)
    normalize_images(manifest)
    validate_images(manifest)
    if not args.skip_contact_sheets:
        generate_contact_sheets(manifest)

    print(
        "逐页原型校验通过："
        f"{manifest['counts']['pages']} 页，"
        f"{manifest['counts']['totalCaptures']} 张基础截图，"
        f"{manifest['counts']['detailedFigmaStateCaptures']} 张 Figma 最终状态，"
        f"{manifest['counts']['groups'] + 1} 组联系表。"
    )


if __name__ == "__main__":
    main()
