#!/usr/bin/env python3
"""生成 App 产品评审所需的视觉对照图和客户截图联系表。"""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps


REPO_ROOT = Path(__file__).resolve().parents[1]
CLIENT_ASSET_DIR = REPO_ROOT / "docs/app/assets/client-prd"
PAGE_ASSET_DIR = REPO_ROOT / "docs/app/assets/page-prototypes"
QA_DIR = REPO_ROOT / "docs/app/interactive-prototype/qa"
FONT_PATH = Path("/System/Library/Fonts/STHeiti Light.ttc")


def font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    if FONT_PATH.exists():
        return ImageFont.truetype(str(FONT_PATH), size=size)
    return ImageFont.load_default()


def contain(image: Image.Image, size: tuple[int, int], background: str = "#ffffff") -> Image.Image:
    fitted = ImageOps.contain(image.convert("RGB"), size, method=Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", size, background)
    x = (size[0] - fitted.width) // 2
    y = (size[1] - fitted.height) // 2
    canvas.paste(fitted, (x, y))
    return canvas


def draw_panel(
    canvas: Image.Image,
    image: Image.Image,
    box: tuple[int, int, int, int],
    label: str,
) -> None:
    draw = ImageDraw.Draw(canvas)
    x1, y1, x2, y2 = box
    draw.rounded_rectangle(box, radius=22, fill="#ffffff", outline="#e5e7eb", width=2)
    draw.text((x1 + 26, y1 + 20), label, fill="#19191d", font=font(28))
    image_box = (x2 - x1 - 48, y2 - y1 - 88)
    fitted = contain(image, image_box, "#f7f7f9")
    canvas.paste(fitted, (x1 + 24, y1 + 64))


def generate_reference_comparison(reference: Path, implementation: Path) -> Path:
    QA_DIR.mkdir(parents=True, exist_ok=True)
    reference_copy = QA_DIR / "source-ui-reference.png"
    if reference.resolve() != reference_copy.resolve():
        shutil.copyfile(reference, reference_copy)

    reference_image = Image.open(reference_copy)
    implementation_image = Image.open(implementation)
    canvas = Image.new("RGB", (2400, 940), "#f1f2f5")
    draw = ImageDraw.Draw(canvas)
    draw.text((48, 28), "UI 视觉方向对照", fill="#111318", font=font(36))
    draw.text(
        (48, 76),
        "左侧为客户提供的宣传视觉参考，右侧为当前可交互需求原型；用于检查品牌气质与信息表达，不作像素级复刻。",
        fill="#5f6470",
        font=font(22),
    )
    draw_panel(canvas, reference_image, (40, 124, 1190, 900), "客户原始视觉参考")
    draw_panel(canvas, implementation_image, (1210, 124, 2360, 900), "当前交互原型实现")
    output = QA_DIR / "source-prototype-comparison.png"
    canvas.save(output, format="PNG", optimize=True)
    return output


def generate_contact_sheet() -> Path:
    paths = sorted(CLIENT_ASSET_DIR.glob("prototype-*.png"))
    if len(paths) != 9:
        raise ValueError(f"应有 9 张客户截图，实际为 {len(paths)} 张")

    cell_width, cell_height = 560, 372
    gap = 24
    top = 100
    canvas = Image.new(
        "RGB",
        (cell_width * 3 + gap * 4, top + cell_height * 3 + gap * 4),
        "#f3f4f7",
    )
    draw = ImageDraw.Draw(canvas)
    draw.text((gap, 24), "MeiGallery App 1.0 客户截图总览", fill="#111318", font=font(34))

    for index, path in enumerate(paths):
        row, column = divmod(index, 3)
        x = gap + column * (cell_width + gap)
        y = top + gap + row * (cell_height + gap)
        draw.rounded_rectangle(
            (x, y, x + cell_width, y + cell_height),
            radius=18,
            fill="#ffffff",
            outline="#e5e7eb",
            width=2,
        )
        draw.text((x + 16, y + 12), path.stem, fill="#353943", font=font(18))
        image = Image.open(path)
        fitted = contain(image, (cell_width - 32, cell_height - 56), "#f8f8fa")
        canvas.paste(fitted, (x + 16, y + 44))

    output = QA_DIR / "current-client-screens-contact-sheet.png"
    canvas.save(output, format="PNG", optimize=True)
    return output


def generate_page_capture_comparison(reference: Path) -> Path:
    """把原始视觉参考与新的单页移动端、后台捕获版式放入同一画面复核。"""
    mobile = PAGE_ASSET_DIR / "mobile/app-dsc-01__default.png"
    admin = PAGE_ASSET_DIR / "admin/adm-ov-01__default.png"
    if not mobile.exists() or not admin.exists():
        raise FileNotFoundError("缺少逐页原型代表截图，请先完成 146 张截图生成")

    canvas = Image.new("RGB", (2400, 1480), "#f1f2f5")
    draw = ImageDraw.Draw(canvas)
    draw.text((48, 28), "原始视觉参考与逐页原型捕获版式", fill="#111318", font=font(36))
    draw.text(
        (48, 76),
        "左侧用于核对粉白品牌、人像内容和玫红主操作；右侧验证移动端与管理后台的单页功能—状态—说明映射。",
        fill="#5f6470",
        font=font(22),
    )
    draw_panel(
        canvas,
        Image.open(reference),
        (40, 124, 1170, 1430),
        "客户原始宣传视觉参考",
    )
    draw_panel(
        canvas,
        Image.open(mobile),
        (1190, 124, 2360, 760),
        "APP-DSC-01 推荐首页 · 默认态",
    )
    draw_panel(
        canvas,
        Image.open(admin),
        (1190, 780, 2360, 1430),
        "ADM-OV-01 运营总览 · 默认态",
    )
    output = QA_DIR / "source-page-capture-comparison.png"
    canvas.save(output, format="PNG", optimize=True)
    return output


def normalize_client_images() -> None:
    """浏览器截图可能返回 JPEG 字节；统一转为与扩展名一致的 PNG。"""
    for path in sorted(CLIENT_ASSET_DIR.glob("prototype-*.png")):
        image = Image.open(path).convert("RGB")
        image.save(path, format="PNG", optimize=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--reference", type=Path, required=True)
    args = parser.parse_args()

    normalize_client_images()
    implementation = CLIENT_ASSET_DIR / "prototype-01-entry-discovery.png"
    comparison = generate_reference_comparison(args.reference, implementation)
    page_capture_comparison = generate_page_capture_comparison(args.reference)
    contact_sheet = generate_contact_sheet()
    print(comparison)
    print(page_capture_comparison)
    print(contact_sheet)


if __name__ == "__main__":
    main()
