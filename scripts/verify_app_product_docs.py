#!/usr/bin/env python3
"""校验 App 客户 DOCX 与逐页原型清单的映射完整性。"""

from __future__ import annotations

import json
import zipfile
from pathlib import Path

from docx import Document


ROOT = Path(__file__).resolve().parents[1]
MANIFEST_PATH = ROOT / "docs/app/assets/page-prototypes/manifest.json"
DOCUMENTS = (
    ROOT / "docs/app/deliverables/MeiGallery_App_1.0_产品需求确认书.docx",
    ROOT / "docs/app/deliverables/MeiGallery_App_1.0_逐页交互设计确认册.docx",
)


def document_text(document: Document) -> str:
    return "\n".join(
        node.text or "" for node in document.element.xpath(".//w:t")
    )


def document_image_alts(document: Document) -> list[str]:
    values: list[str] = []
    for node in document.element.xpath(".//wp:docPr"):
        alt = node.get("descr") or node.get("title")
        if alt:
            values.append(alt)
    return values


def verify_docx_archive(path: Path) -> None:
    if not path.exists():
        raise FileNotFoundError(f"缺少客户文档：{path}")
    with zipfile.ZipFile(path) as archive:
        broken = archive.testzip()
        if broken:
            raise ValueError(f"DOCX 压缩包损坏：{path.name} / {broken}")


def main() -> None:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    if manifest.get("status") != "verified":
        raise ValueError("逐页原型清单未通过验证")
    if int(manifest.get("schemaVersion", 0)) < 3:
        raise ValueError("逐页原型清单缺少 Figma 最终状态与需求追踪 schema")
    if manifest["counts"]["pages"] != 92:
        raise ValueError("页面清单不是 92 页")
    if manifest["counts"]["totalCaptures"] != 146:
        raise ValueError("原型清单不是 146 张")
    if manifest["counts"]["detailedFigmaPages"] != 5:
        raise ValueError("Figma 最终细化页面不是 5 个")
    if manifest["counts"]["detailedFigmaStateCaptures"] != 23:
        raise ValueError("Figma 最终状态原型不是 23 张")
    if manifest["counts"]["documentPrototypeMappings"] != 169:
        raise ValueError("客户文档原型映射不是 169 个")
    if (
        manifest["counts"]["p0Pages"],
        manifest["counts"]["p1Pages"],
        manifest["counts"]["p2Pages"],
    ) != (54, 31, 7):
        raise ValueError("P0/P1/P2 页面数量不是 54/31/7")

    expected_page_ids = {page["pageId"] for page in manifest["pages"]}
    expected_alts = {capture["alt"] for capture in manifest["captures"]}
    expected_figma_alts = {
        capture["alt"] for capture in manifest["figmaStateCaptures"]
    }
    if len(expected_figma_alts) != 23:
        raise ValueError("Figma 最终状态图片替代文本不是 23 个唯一值")
    expected_trace_keys = {
        page["requirements"]["traceKey"] for page in manifest["pages"]
    }
    if len(expected_trace_keys) != 92:
        raise ValueError("需求追踪键不是 92 个唯一值")

    for path in DOCUMENTS:
        verify_docx_archive(path)
        document = Document(path)
        text = document_text(document)
        image_alts = document_image_alts(document)
        image_alt_set = set(image_alts)

        missing_page_ids = sorted(
            page_id for page_id in expected_page_ids if page_id not in text
        )
        missing_alts = sorted(expected_alts - image_alt_set)
        missing_figma_alts = sorted(expected_figma_alts - image_alt_set)
        missing_trace_keys = sorted(
            trace_key for trace_key in expected_trace_keys if trace_key not in text
        )
        if missing_page_ids:
            raise ValueError(
                f"{path.name} 缺少 Page ID：{', '.join(missing_page_ids)}"
            )
        if missing_alts:
            raise ValueError(
                f"{path.name} 缺少原型映射：{', '.join(missing_alts[:5])}"
            )
        if missing_figma_alts:
            raise ValueError(
                f"{path.name} 缺少 Figma 最终状态映射："
                f"{', '.join(missing_figma_alts[:5])}"
            )
        if missing_trace_keys:
            raise ValueError(
                f"{path.name} 缺少需求追踪键：{', '.join(missing_trace_keys[:3])}"
            )
        if "原型图片暂不可用" in text:
            raise ValueError(f"{path.name} 包含缺图回退文案")
        if len(document.inline_shapes) < 169:
            raise ValueError(
                f"{path.name} 图片数量不足：{len(document.inline_shapes)}"
            )

        print(
            f"文档映射通过：{path.name}；"
            f"Page ID={len(expected_page_ids)}，"
            f"需求追踪={len(expected_trace_keys)}，"
            f"基础逐页原型={len(expected_alts)}，"
            f"Figma 最终状态={len(expected_figma_alts)}，"
            f"内嵌图片={len(document.inline_shapes)}，"
            f"图片替代文本={len(image_alts)}。"
        )


if __name__ == "__main__":
    main()
