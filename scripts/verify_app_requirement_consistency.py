#!/usr/bin/env python3
"""校验 App 1.0 产品需求、发布范围、逐页设计与原型清单的一致性。"""

from __future__ import annotations

import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
APP_DIR = ROOT / "docs/app"
FEATURE_DIR = ROOT / "docs/ways-of-work/plan/real-person-discovery-platform"
MANIFEST_PATH = APP_DIR / "assets/page-prototypes/manifest.json"

PRODUCT = APP_DIR / "PRODUCT_REQUIREMENTS.md"
CLIENT = APP_DIR / "MEIGALLERY_APP_1_0_CLIENT_PRD.md"
PAGE_DESIGN = APP_DIR / "APP_PAGE_LEVEL_PRODUCT_DESIGN.md"
PAGE_DETAIL = APP_DIR / "APP_DETAILED_FUNCTION_PROTOTYPE_SPEC.md"
DEVELOPMENT = APP_DIR / "MEIGALLERY_APP_1_0_DEVELOPMENT_REQUIREMENTS.md"
TRACEABILITY = APP_DIR / "APP_REQUIREMENTS_TRACEABILITY.md"
DECISIONS = APP_DIR / "DECISIONS_AND_OPEN_QUESTIONS.md"
FEATURE_INDEX = FEATURE_DIR / "README.md"
RELEASE_SCOPE = FEATURE_DIR / "app-1-0-release-scope/prd.md"
PRODUCT_BLUEPRINT = FEATURE_DIR / "product-blueprint/prd.md"
MANAGED_TOPIC = FEATURE_DIR / "managed-person-discovery-and-messaging/prd.md"

BASELINE_DOCUMENTS = (
    PRODUCT,
    CLIENT,
    PAGE_DESIGN,
    PAGE_DETAIL,
    DEVELOPMENT,
    TRACEABILITY,
    DECISIONS,
    FEATURE_INDEX,
    RELEASE_SCOPE,
    PRODUCT_BLUEPRINT,
    MANAGED_TOPIC,
)

EXPECTED_COUNTS = {
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
    "figmaHistoricalPageActionBaseline": 2957,
    "figmaHistoricalFlowActionBaseline": 614,
    "figmaHistoricalActionBaseline": 3571,
    "groups": 15,
}

IN_SCOPE_PRODUCT_REQUIREMENTS = {
    *(f"PRD-FR-{value}" for value in ("001", "002", "003", "004")),
    *(f"PRD-FR-{value}" for value in ("010", "011", "012", "013")),
    *(f"PRD-FR-{value}" for value in ("020", "021", "022", "023")),
    *(f"PRD-FR-{value}" for value in ("030", "031", "032")),
    *(f"PRD-FR-{value}" for value in ("040", "041", "042")),
    *(f"PRD-FR-{value}" for value in ("050", "051", "052", "053", "054", "055", "056")),
    *(f"PRD-FR-{value}" for value in ("060", "061", "062", "063", "064", "065", "066")),
    *(f"PRD-FR-{value}" for value in ("070", "071", "074")),
    *(f"PRD-FR-{value}" for value in ("080", "081", "082")),
    *(f"PRD-FR-{value}" for value in ("090", "091", "092")),
}

FUTURE_PRODUCT_REQUIREMENTS = {"PRD-FR-072", "PRD-FR-073", "PRD-FR-075"}
FUTURE_RELEASE_REQUIREMENTS = {
    "SCP-FR-020",
    "SCP-FR-021",
    "SCP-FR-022",
    "SCP-FR-023",
    "SCP-FR-024",
}


def read(path: Path) -> str:
    if not path.exists():
        raise FileNotFoundError(f"缺少需求基线：{path.relative_to(ROOT)}")
    return path.read_text(encoding="utf-8")


def require(text: str, needle: str, label: str) -> None:
    if needle not in text:
        raise ValueError(f"{label} 缺少统一口径：{needle}")


def forbid(text: str, needle: str, label: str) -> None:
    if needle in text:
        raise ValueError(f"{label} 仍包含旧口径：{needle}")


def validate_page_state_counts(manifest: dict) -> None:
    counts = manifest.get("counts", {})
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
    texts = {path: read(path) for path in BASELINE_DOCUMENTS}
    manifest = json.loads(read(MANIFEST_PATH))

    if int(manifest.get("schemaVersion", 0)) < 4:
        raise ValueError("逐页原型清单未包含 Figma 全量最终交付与需求追踪 schema")
    if manifest.get("status") != "verified":
        raise ValueError("逐页原型清单未通过图片验证")
    for key, expected in EXPECTED_COUNTS.items():
        actual = manifest.get("counts", {}).get(key)
        if actual != expected:
            raise ValueError(f"{key} 数量错误：期望 {expected}，实际 {actual}")
    validate_page_state_counts(manifest)

    pages = manifest.get("pages", [])
    page_ids = [page["pageId"] for page in pages]
    if len(page_ids) != len(set(page_ids)):
        raise ValueError("Page ID 存在重复")

    mapped_product: set[str] = set()
    for page in pages:
        requirements = page.get("requirements", {})
        trace_key = requirements.get("traceKey")
        if not trace_key or not requirements.get("product"):
            raise ValueError(f"{page['pageId']} 缺少产品需求追踪")
        if not requirements.get("release") or not requirements.get("features"):
            raise ValueError(f"{page['pageId']} 缺少发布范围或 Feature PRD 追踪")
        mapped_product.update(requirements["product"])

        require(texts[TRACEABILITY], page["pageId"], "需求追踪矩阵")
        require(texts[PAGE_DETAIL], trace_key, "逐页详细功能说明")
        require(texts[DEVELOPMENT], trace_key, "开发需求规格")
        for feature in requirements["features"]:
            feature_path = (APP_DIR / feature["document"]).resolve()
            if not feature_path.exists():
                raise FileNotFoundError(
                    f"{page['pageId']} Feature PRD 不存在：{feature_path}"
                )

    missing_product = sorted(IN_SCOPE_PRODUCT_REQUIREMENTS - mapped_product)
    if missing_product:
        raise ValueError(f"App 1.0 产品需求未映射到页面：{', '.join(missing_product)}")
    unexpected_future = sorted(
        (FUTURE_PRODUCT_REQUIREMENTS | FUTURE_RELEASE_REQUIREMENTS)
        & {
            requirement
            for page in pages
            for key in ("product", "release")
            for requirement in page["requirements"][key]
        }
    )
    if unexpected_future:
        raise ValueError(f"未来需求被错误映射为 1.0 页面：{', '.join(unexpected_future)}")

    for path, text in texts.items():
        require(text, "App 版本：1.0", str(path.relative_to(ROOT)))

    for path in (
        PRODUCT,
        CLIENT,
        PAGE_DESIGN,
        PAGE_DETAIL,
        DEVELOPMENT,
        TRACEABILITY,
        RELEASE_SCOPE,
    ):
        text = texts[path]
        for phrase in ("99", "50", "49"):
            require(text, phrase, str(path.relative_to(ROOT)))

    for path in (CLIENT, PAGE_DESIGN, PAGE_DETAIL, DEVELOPMENT, TRACEABILITY):
        text = texts[path]
        require(text, "156", str(path.relative_to(ROOT)))
        require(text, "57", str(path.relative_to(ROOT)))
        require(text, "23", str(path.relative_to(ROOT)))
        require(text, "179", str(path.relative_to(ROOT)))
        require(text, "408", str(path.relative_to(ROOT)))
        require(text, "208", str(path.relative_to(ROOT)))
        require(text, "3,571", str(path.relative_to(ROOT)))

    require(texts[PAGE_DESIGN], "P0 57 页、P1 32 页、P2 10 页", "逐页产品设计")
    require(texts[TRACEABILITY], "57 / 32 / 10", "需求追踪矩阵")
    require(texts[PRODUCT], "需求追踪矩阵", "产品总需求")
    require(texts[CLIENT], "需求追踪矩阵", "客户需求确认稿")
    require(texts[RELEASE_SCOPE], "需求追踪矩阵", "发布范围 PRD")
    require(texts[DEVELOPMENT], "DOCX 只用于客户阅读与确认", "开发需求规格")

    development_page_ids = re.findall(
        r"^#### ((?:APP|ADM)-[A-Z]+-\d{2})\s",
        texts[DEVELOPMENT],
        flags=re.MULTILINE,
    )
    if development_page_ids != page_ids:
        raise ValueError("开发需求规格的 Page ID 顺序或覆盖与原型清单不一致")

    development_capture_paths = re.findall(
        r"!\[[^\]]+\]\(\./assets/page-prototypes/([^)]+)\)",
        texts[DEVELOPMENT],
    )
    figma_captures = manifest.get("figmaStateCaptures", [])
    figma_page_ids = {capture["pageId"] for capture in figma_captures}
    if len(figma_captures) != EXPECTED_COUNTS["detailedFigmaStateCaptures"]:
        raise ValueError("Figma 最终状态截图数量与基线不一致")
    if len({capture["frameId"] for capture in figma_captures}) != len(
        figma_captures
    ):
        raise ValueError("Figma Frame ID 存在重复")

    expected_capture_paths: list[str] = []
    for page in pages:
        page_id = page["pageId"]
        source = (
            figma_captures
            if page_id in figma_page_ids
            else manifest["captures"]
        )
        expected_capture_paths.extend(
            capture["image"]
            for capture in source
            if capture["pageId"] == page_id
        )
    if development_capture_paths != expected_capture_paths:
        raise ValueError("开发需求规格的逐页原型顺序或覆盖与原型清单不一致")

    for capture in figma_captures:
        for path in (PAGE_DETAIL, DEVELOPMENT):
            text = texts[path]
            label = str(path.relative_to(ROOT))
            for value in (
                capture["frameId"],
                capture["trigger"],
                capture["interaction"],
                capture["expected"],
                capture["authority"],
            ):
                require(text, value, label)

    for requirement in sorted(
        IN_SCOPE_PRODUCT_REQUIREMENTS
        | FUTURE_PRODUCT_REQUIREMENTS
        | FUTURE_RELEASE_REQUIREMENTS
    ):
        require(texts[DEVELOPMENT], f"**{requirement}**", "开发需求规格")

    forbid(texts[DEVELOPMENT], "**客户确认：**", "开发需求规格")

    forbid(texts[RELEASE_SCOPE], "状态：范围已冻结", "发布范围 PRD")
    forbid(texts[PAGE_DETAIL], "状态：需求确认版", "逐页详细功能说明")
    forbid(texts[PRODUCT_BLUEPRINT], "决定是否购买", "产品蓝图")
    forbid(texts[PRODUCT_BLUEPRINT], "心享会员私信", "产品蓝图")
    forbid(texts[MANAGED_TOPIC], "代运营私信", "平台话题总纲")
    forbid(texts[MANAGED_TOPIC], "点击私信", "平台话题总纲")

    p0_block_match = re.search(
        r"管理后台 P0：\s*\n\n(?P<body>.+?)\n\n其余页面",
        texts[PAGE_DESIGN],
        flags=re.DOTALL,
    )
    if not p0_block_match:
        raise ValueError("未找到管理后台 P0 页面清单")
    if "ADM-AUD-03" in p0_block_match.group("body"):
        raise ValueError("ADM-AUD-03 完整可视化页面被错误列入 P0")
    require(
        texts[PAGE_DESIGN],
        "`ADM-AUD-03` 完整可视化页面的 P2 优先级",
        "逐页产品设计",
    )

    print(
        "需求一致性校验通过："
        f"{EXPECTED_COUNTS['pages']} 页、"
        f"{EXPECTED_COUNTS['totalCaptures']} 张基础原型、"
        f"{EXPECTED_COUNTS['figmaDesignedStates']} 个 Figma 最终设计状态、"
        f"{EXPECTED_COUNTS['detailedFigmaStateCaptures']} 张逐状态导出图、"
        f"{EXPECTED_COUNTS['documentPrototypeMappings']} 个原型映射、"
        f"{len(IN_SCOPE_PRODUCT_REQUIREMENTS)} 个 App 1.0 产品需求编号、"
        f"{len(pages)} 个逐页追踪键。"
    )


if __name__ == "__main__":
    main()
