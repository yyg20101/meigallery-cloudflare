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


def verify_page_state_counts(manifest: dict) -> None:
    counts = manifest["counts"]
    pages = manifest.get("pages", [])
    state_totals = {"mobile": 0, "admin": 0}
    for page in pages:
        states = page.get("states")
        if not isinstance(states, list) or not states:
            raise ValueError(f"{page.get('pageId', '未知页面')} 缺少正式状态")
        if any(
            not isinstance(state, str) or not state or state.strip() != state
            for state in states
        ):
            raise ValueError(
                f"{page.get('pageId', '未知页面')} 存在空白或未规范化的正式状态名称"
            )
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


def main() -> None:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    if manifest.get("status") != "verified":
        raise ValueError("逐页原型清单未通过验证")
    if int(manifest.get("schemaVersion", 0)) < 4:
        raise ValueError("逐页原型清单缺少 Figma 全量最终交付与需求追踪 schema")
    if manifest["counts"]["pages"] != 99:
        raise ValueError("页面清单不是 99 页")
    if manifest["counts"]["totalCaptures"] != 156:
        raise ValueError("原型清单不是 156 张")
    if manifest["counts"]["detailedFigmaPages"] != 5:
        raise ValueError("Figma 最终细化页面不是 5 个")
    if manifest["counts"]["detailedFigmaStateCaptures"] != 23:
        raise ValueError("Figma 最终状态原型不是 23 张")
    if manifest["counts"]["documentPrototypeMappings"] != 179:
        raise ValueError("客户文档原型映射不是 179 个")
    if manifest["counts"]["figmaDesignedPages"] != 99:
        raise ValueError("Figma 最终设计页面不是 99 页")
    if manifest["counts"]["figmaDesignedStates"] != 408:
        raise ValueError("Figma 最终设计状态不是 408 个")
    if manifest["counts"]["figmaMobileStates"] != 208:
        raise ValueError("Figma 移动端最终设计状态不是 208 个")
    if manifest["counts"]["figmaAdminStates"] != 200:
        raise ValueError("Figma 管理后台最终设计状态不是 200 个")
    verify_page_state_counts(manifest)
    if manifest["counts"]["figmaPageActions"] != 2971:
        raise ValueError("Figma 当前页面动作不是 2,971 个")
    if manifest["counts"]["figmaFlowActions"] != 614:
        raise ValueError("Figma 当前流程动作不是 614 个")
    if manifest["counts"]["figmaActionTotal"] != 3585:
        raise ValueError("Figma 当前有效交互动作不是 3,585 个")
    if manifest["counts"]["figmaHistoricalActionBaseline"] != 3571:
        raise ValueError("Figma 的 APP-SET-08 增量前历史动作基线不是 3,571 个")
    if (
        manifest["counts"]["p0Pages"],
        manifest["counts"]["p1Pages"],
        manifest["counts"]["p2Pages"],
    ) != (57, 32, 10):
        raise ValueError("P0/P1/P2 页面数量不是 57/32/10")

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
    if len(expected_trace_keys) != 99:
        raise ValueError("需求追踪键不是 99 个唯一值")

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
        for required_text in ("408", "3,585", "3,571", "2381987656588552168"):
            if required_text not in text:
                raise ValueError(
                    f"{path.name} 缺少 Figma 最终交付事实：{required_text}"
                )
        if len(document.inline_shapes) < 179:
            raise ValueError(
                f"{path.name} 图片数量不足：{len(document.inline_shapes)}"
            )

        print(
            f"文档映射通过：{path.name}；"
            f"Page ID={len(expected_page_ids)}，"
            f"需求追踪={len(expected_trace_keys)}，"
            f"基础逐页原型={len(expected_alts)}，"
            f"Figma 逐状态导出={len(expected_figma_alts)}，"
            f"Figma 最终设计={manifest['counts']['figmaDesignedPages']} 页/"
            f"{manifest['counts']['figmaDesignedStates']} 状态/"
            f"当前动作={manifest['counts']['figmaActionTotal']}/"
            f"历史动作基线={manifest['counts']['figmaHistoricalActionBaseline']}（APP-SET-08 增量前），"
            f"内嵌图片={len(document.inline_shapes)}，"
            f"图片替代文本={len(image_alts)}。"
        )


if __name__ == "__main__":
    main()
