(function () {
  "use strict";

  const catalog = window.MeiGalleryPageCatalog;
  if (!catalog) throw new Error("页面目录未加载");

  const icon = (name, className = "") => `<img class="${className}" src="./assets/icons/${name}.svg" alt="" />`;
  const escapeHtml = value => String(value).replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
  const people = [
    { name: "林夏", meta: "杭州 · 品牌策划", image: "./assets/portrait-linxia.png", tag: "生活方式" },
    { name: "清禾", meta: "上海 · 空间设计", image: "./assets/portrait-qinghe.png", tag: "设计" },
    { name: "知遥", meta: "南京 · 出版编辑", image: "./assets/portrait-zhiyao.png", tag: "阅读" },
    { name: "沐青", meta: "成都 · 艺术策展", image: "./assets/portrait-muqing.png", tag: "艺术" }
  ];
  const levelDetails = [
    { name: "心遇", rank: 10, topics: 1, filters: 1, folders: 3, advanced: "不开放" },
    { name: "心悦", rank: 20, topics: 2, filters: 3, folders: 5, advanced: "基础组合" },
    { name: "心知", rank: 30, topics: 4, filters: 6, folders: 10, advanced: "完整开放" },
    { name: "心契", rank: 40, topics: 6, filters: 12, folders: 20, advanced: "完整开放" },
    { name: "心耀", rank: 50, topics: 10, filters: 20, folders: 30, advanced: "完整开放" }
  ];
  const levels = levelDetails.map(level => level.name);
  const params = new URLSearchParams(location.search);
  const captureMode = params.get("capture") === "doc";
  if (captureMode) {
    document.documentElement.dataset.captureMode = "doc";
    document.documentElement.dataset.captureReady = "false";
    document.body.classList.add("doc-capture");
  }
  const requestedPage = catalog.pages.find(item => item.id === params.get("page"));

  const state = {
    currentId: requestedPage ? requestedPage.id : "APP-AUTH-01",
    platform: requestedPage ? requestedPage.platform : "mobile",
    currentState: params.get("state") || null,
    legalDocument: "terms",
    search: "",
    completed: new Set(),
    toggles: new Set(["个性化推荐", "保存浏览历史", "消息通知", "互动通知"])
  };

  const els = {
    catalog: document.getElementById("page-catalog"),
    nav: document.getElementById("page-nav"),
    search: document.getElementById("page-search"),
    title: document.getElementById("page-title"),
    kicker: document.getElementById("page-kicker"),
    route: document.getElementById("page-route"),
    statePill: document.getElementById("page-state-pill"),
    states: document.getElementById("page-state-switcher"),
    stage: document.getElementById("page-device-stage"),
    inspector: document.getElementById("page-inspector"),
    inspectorContent: document.getElementById("page-inspector-content"),
    progressText: document.getElementById("page-progress-text"),
    progressBar: document.getElementById("page-progress-bar"),
    footerLabel: document.getElementById("page-footer-label"),
    captureStateSummary: document.getElementById("capture-state-summary"),
    toast: document.getElementById("toast-region"),
    modal: document.getElementById("modal-layer")
  };

  const groupFor = item => catalog.groups.find(group => {
    const prefixes = [group.prefix, ...(group.extraPrefixes || [])];
    return group.platform === item.platform && prefixes.some(prefix => item.id.startsWith(prefix));
  });

  const currentPage = () => catalog.pages.find(item => item.id === state.currentId) || catalog.pages[0];
  const activePages = () => catalog.pages.filter(item => item.platform === state.platform);

  function normalState(page) {
    return page.states[0] || "正常";
  }

  function selectedState(page) {
    return page.states.includes(state.currentState) ? state.currentState : normalState(page);
  }

  function showToast(message) {
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = message;
    els.toast.appendChild(toast);
    window.setTimeout(() => toast.remove(), 2300);
  }

  function mobileStatus() {
    return `<div class="phone-status library-status"><span>9:41</span><span>MeiGallery 演示</span></div>`;
  }

  function mobileHeader(title, options = {}) {
    return `<header class="library-mobile-header">
      ${options.back === false ? `<span class="mobile-header-spacer"></span>` : `<button type="button" class="icon-button" data-action="previous-page" aria-label="返回">${icon("chevron-left")}</button>`}
      <div><strong>${escapeHtml(title)}</strong>${options.caption ? `<small>${escapeHtml(options.caption)}</small>` : ""}</div>
      ${options.action ? `<button type="button" class="icon-button" data-action="secondary" aria-label="${escapeHtml(options.action)}">${icon(options.actionIcon || "settings")}</button>` : `<span class="mobile-header-spacer"></span>`}
    </header>`;
  }

  function mobileTabs(active) {
    const tabs = [["推荐", "compass", "APP-DSC-01"], ["关注", "heart", "APP-INT-01"], ["消息", "message-circle", "APP-MSG-01"], ["我的", "user", "APP-SET-01"]];
    return `<nav class="phone-tabs library-tabs">${tabs.map(([label, glyph, pageId]) => `<button type="button" class="bottom-tab ${active === label ? "active" : ""}" data-action="open-page" data-page="${pageId}">${icon(glyph)}<span>${label}</span></button>`).join("")}</nav>`;
  }

  function isRiskState(value) {
    return /失败|错误|受限|冲突|不可用|过期|不足|冻结|限制|异常|无权限|下架|关闭|维护|升级|撤销|锁定/.test(value);
  }

  function stateDescription(value) {
    const descriptions = {
      "已提交": "申请已由服务端创建，等待平台领取；可以查看进度或取消。",
      "处理中": "平台运营正在处理，会员权限尚未生效。",
      "待补充": "申请需要补充说明；补充并重新提交前不会继续处理。",
      "已通过": "申请审核已通过，仍需管理员 grant 生效后才获得会员权限。",
      "已拒绝": "本次申请未通过；页面展示可理解原因和帮助入口。",
      "已取消": "申请已取消，未产生会员权益。",
      "额度尽": "今日新话题额度已用完；已有话题仍按当前权益与会话状态处理。",
      "无会员": "当前账号没有有效会员；可以查看权益并提交会员申请。",
      "离线": "当前显示上次同步结果；权威操作需要恢复联网后重新校验。",
      "同步失败": "未取得最新权威状态；页面不会推断会员、余额或权限。",
      "维护": "服务当前处于维护状态；页面说明影响范围并提供重试或帮助入口。",
      "维护中": "服务当前处于维护状态；页面说明影响范围并提供重试或帮助入口。",
      "升级": "当前版本低于服务端最低要求；升级完成前不进入不兼容业务页面。",
      "必须升级": "当前版本低于服务端最低要求；升级完成前不进入不兼容业务页面。",
      "账号受限": "账号当前受到限制；页面只展示可公开的原因、影响范围和申诉入口。",
      "发起人冲突": "申请人与复核人不能是同一管理员；必须更换具备权限的独立复核人。",
      "下架": "资料当前已下架；不再展示受保护内容，并提供安全返回路径。",
      "已下架": "资料当前已下架；不再展示受保护内容，并提供安全返回路径。"
    };
    return descriptions[value] || `当前为“${value}”状态；页面展示已知事实，并提供与该状态相符的安全下一步。`;
  }

  function stateNotice(page) {
    const value = selectedState(page);
    if (["正常", "首次", "免费", "初始", "未申请"].includes(value)) return "";
    const isRisk = isRiskState(value);
    const glyph = isRisk ? "alert-circle" : "history";
    const description = stateDescription(value);
    return `<div class="page-state-notice ${isRisk ? "risk" : ""}">${icon(glyph)}<div><strong>${escapeHtml(value)}</strong><span>${escapeHtml(description)}</span></div></div>`;
  }

  function primaryButton(page, label = page.primary) {
    return `<button type="button" class="primary-button hotspot page-primary-action" data-action="page-primary">${escapeHtml(label)}${icon("arrow-right")}</button>`;
  }

  function phoneShell(page, content, tab = null, className = "") {
    return `<div class="phone-shell library-phone ${className}"><div class="phone-screen library-phone-screen">${mobileStatus()}${content}${tab ? mobileTabs(tab) : ""}</div></div>`;
  }

  function personRows(limit = 3) {
    return people.slice(0, limit).map((person, index) => `<button type="button" class="library-person-row" data-action="open-page" data-page="APP-DSC-07"><img src="${person.image}" alt="${person.name}的虚构演示照片" /><span><strong>${person.name}</strong><small>${person.meta}</small></span><span class="row-meta">${index === 0 ? "新内容" : person.tag}</span>${icon("chevron-right")}</button>`).join("");
  }

  function renderLaunch(page) {
    return phoneShell(page, `<div class="launch-page"><img class="launch-portrait" src="./assets/portrait-linxia.png" alt="虚构成年人物演示照片" /><div class="launch-shade"></div><div class="launch-content"><span class="welcome-logo">M</span><p>心动遇见你</p><h2>遇见值得了解的人</h2><small>正在安全恢复配置与账号会话</small><div class="launch-progress"><span></span></div>${primaryButton(page)}</div></div>`, null, "launch-phone");
  }

  function renderAuth(page) {
    const isRegister = page.id === "APP-AUTH-03";
    const registrationCode = isRegister ? `<label><span>邮箱验证码</span><div class="form-field">${icon("lock")}<input value="582914" inputmode="numeric" aria-label="邮箱验证码" /><button type="button" data-action="secondary">重新获取</button></div></label>` : "";
    const consent = isRegister ? `<label class="check-row"><input type="checkbox" checked />我已逐项阅读并同意当前四类生效文档</label>` : "";
    return phoneShell(page, `<div class="library-scroll"><div class="auth-hero"><span class="welcome-logo">M</span><h2>${isRegister ? "创建观看者账号" : "欢迎回来"}</h2><p>${isRegister ? "验证邮箱并设置密码；注册不会创建公开真人资料" : "使用已验证邮箱和密码登录观看者账号"}</p></div>${stateNotice(page)}<div class="library-form"><label><span>邮箱</span><div class="form-field">${icon("mail")}<input value="viewer@example.com" inputmode="email" aria-label="邮箱" /></div></label><label><span>密码</span><div class="form-field">${icon("lock")}<input value="password" type="password" aria-label="密码" /></div></label>${registrationCode}${consent}${primaryButton(page)}<button type="button" class="secondary-button" data-action="secondary">${isRegister ? "逐项查看四份当前文档" : "需要帮助"}</button></div><div class="auth-boundary">账号身份：观看者<br />不会进入真人推荐列表</div></div>`);
  }

  function renderChallenge(page) {
    const value = selectedState(page);
    const failed = value === "失败";
    const limited = value === "次数限制";
    const content = limited
      ? {
          title: "暂时不能继续验证",
          description: "服务端已限制当前挑战频率，原操作未执行。",
          boundary: "为保护服务，当前挑战已暂停。请按服务端返回的时间稍后重试。",
          panelTitle: "验证暂时不可用",
          panelMessage: "挑战频率已受服务端限制，不会自动绕过或使用旧 token。",
          left: "可重试时间由服务端返回",
          right: "请稍后重试",
          primary: "暂时不可验证"
        }
      : failed
        ? {
            title: "安全验证未完成",
            description: "原操作尚未执行，可重新加载受控验证页。",
            boundary: "本次挑战未通过；不会恢复账号权限或重新触发原操作。",
            panelTitle: "验证页未完成",
            panelMessage: "网络异常、取消或挑战失败；重新加载不会执行原操作。",
            left: "原操作未执行",
            right: "可以安全重试",
            primary: "重新加载验证"
          }
        : {
            title: "完成人机安全验证",
            description: "完成 Cloudflare Turnstile 后，将自动继续原操作。",
            boundary: "用于拦截自动化滥用，不确认真实身份、不读取短信，也不会创建公开资料。",
            panelTitle: "请在此区域完成验证",
            panelMessage: "实际验证组件由 Cloudflare 渲染；完成后自动返回 App。",
            left: "验证完成后将自动继续",
            right: "不保存 token",
            primary: "等待验证完成…"
          };
    return phoneShell(page, `<div class="library-scroll challenge-screen">${mobileHeader(page.name, { caption: "账号安全", action: "安全验证", actionIcon: "shield-check" })}<div class="challenge-identity"><i></i>APP-AUTH-04 · /auth/challenge</div><div class="challenge-heading"><h2>${content.title}</h2><span class="${failed ? "failed" : ""}">${value}</span></div><p class="challenge-description">${content.description}</p><div class="challenge-boundary ${failed ? "failed" : ""}">${icon("shield-check")}<div><strong>为什么需要验证</strong><span>${content.boundary}</span></div></div><section class="challenge-platform"><small>Cloudflare Turnstile 安全验证</small><h3>平台受控验证页</h3><div>${icon("shield-check")}<strong>${content.panelTitle}</strong><span>${content.panelMessage}</span></div></section><div class="challenge-meta"><span>${content.left}</span><strong>${content.right}</strong></div><button type="button" class="primary-button challenge-primary ${!failed ? "disabled" : ""}" data-action="${failed ? "secondary" : "noop"}" ${!failed ? "disabled" : ""}>${content.primary}</button><button class="challenge-cancel" type="button" data-action="previous-page">${icon("log-out")}取消并返回</button></div>`);
  }

  function renderPreferences(page) {
    const groups = [["偏好地区", ["杭州", "上海", "南京", "成都"]], ["内容风格", ["自然", "知性", "文艺", "清新"]], ["内容主题", ["生活方式", "艺术", "阅读", "旅行"]]];
    return phoneShell(page, `<div class="library-scroll">${mobileHeader(page.name, { back: false, caption: "可随时修改" })}${stateNotice(page)}<div class="preference-intro"><span>01 / 01</span><h2>告诉我们你想看的内容</h2><p>偏好只用于内容排序，不代表匹配或关系意向。</p></div>${groups.map((group, index) => `<section class="choice-section"><div><strong>${group[0]}</strong><small>${index === 0 ? "可多选" : "选择 1–3 项"}</small></div><div class="choice-grid">${group[1].map((item, itemIndex) => `<button type="button" class="choice-chip ${itemIndex < 2 ? "selected" : ""}" data-action="toggle-choice">${item}</button>`).join("")}</div></section>`).join("")}${primaryButton(page)}<button class="text-button" type="button" data-action="open-page" data-page="APP-DSC-01">暂时跳过，使用非个性化推荐</button></div>`);
  }

  function renderDocument(page) {
    const documentMap = {
      terms: ["服务条款", "1. 注册只创建观看者账号，不创建公开真人资料。\n2. 公开真人资料仅由管理员依据授权创建、认证和发布。\n3. 仅有效会员可发起平台话题；由平台运营接收，不代表真人本人查看或回复。\n4. App 1.0 不提供在线支付；管理员金币调整必须留存原因和明细。"],
      privacy: ["隐私政策", "1. 观看者账号资料保持私有，不会自动转为公开真人资料。\n2. 推荐使用用户选择的地区、热度和偏好，不采集精确位置。\n3. Turnstile token 仅在当前操作内存中使用，不读取手机号或短信。\n4. 受保护媒体始终由服务端校验权限并签发短期访问凭证。"],
      platform: ["平台运营说明", "1. 公开真人资料由管理员依据授权素材创建、认证和维护。\n2. 用户消息由平台运营接收与处理，不代表真人本人在线或亲自回复。\n3. 只有有效会员可以发起平台话题，不要求双方同意。\n4. 举报、申诉和金币调整均按稳定对象记录并保留可见明细。"],
      eligibility: ["必要资格说明", "1. 服务地区和必要资格以服务端当前政策与生效正文为准。\n2. 观看者注册不会获得公开真人身份或资料发布资格。\n3. 平台仅展示合法、非露骨且具有明确授权来源的内容。\n4. 用户不得冒充真人、绕过权限或将平台回复描述为真人本人回复。"]
    };
    const active = documentMap[state.legalDocument] || documentMap.terms;
    const current = selectedState(page);
    const failed = current === "加载失败";
    const updated = current === "版本更新";
    const tabs = Object.entries(documentMap).map(([key, item]) => `<button type="button" class="legal-document-tab ${key === state.legalDocument ? "active" : ""}" data-action="select-legal-document" data-document="${key}">${item[0]}</button>`).join("");
    const status = failed ? "加载失败" : updated ? "版本更新" : "正常";
    const description = failed ? "当前未取得完整生效正文，不能继续同意。" : updated ? "当前生效版本已更新，请阅读最新正文后再返回确认。" : "完整正文、版本和更新时间可追溯；以服务端当前生效内容为准。";
    const notice = failed ? `<div class="legal-document-notice">${icon("alert-circle")}<span><strong>同意操作已关闭</strong><small>不会使用空白、缓存残片或旧版本替代完整正文。</small></span></div>` : updated ? `<div class="legal-document-notice">${icon("file-description")}<span><strong>旧版确认已失效</strong><small>请阅读完整新正文；返回后需重新确认四类当前文档。</small></span></div>` : "";
    const body = failed ? `<article class="legal-document-card legal-document-error">${icon("alert-circle")}<h3>${active[0]}暂时无法加载</h3><p>尚未取得${active[0]}当前完整正文，不能用空白、缓存残片或旧版本代替。</p><button type="button" class="secondary-button" data-action="reset-page">重新加载</button></article>` : `<article class="legal-document-card"><h3>MeiGallery ${active[0]}</h3><small>生效版本 ${updated ? "v1.1 · 更新于 2026-08-11" : "v1.0 · 更新于 2026-07-30"}</small><p>${active[1].split("\n").map(escapeHtml).join("<br />")}</p></article>`;
    return phoneShell(page, `<div class="library-scroll legal-document-screen">${mobileHeader("条款与隐私", { caption: "APP-AUTH-06 · /legal/{document}" })}<div class="legal-title-row"><h2>${failed ? "文档加载失败" : active[0]}</h2><span>${status}</span></div><p class="legal-description">${description}</p>${notice}<div class="legal-document-tabs">${tabs}</div>${body}<button type="button" class="page-primary-action ${failed ? "disabled" : ""}" ${failed ? "disabled" : ""} data-action="previous-page">${failed ? "正文不可用" : "返回原页面"}</button>${failed ? `<button type="button" class="legal-return-action" data-action="previous-page">${icon("log-out")}返回原页面</button>` : ""}</div>`);
  }

  function renderDiscover(page) {
    return phoneShell(page, `<div class="library-scroll discover-screen">${stateNotice(page)}<header class="discover-head"><div><small>推荐范围</small><strong>杭州及周边</strong></div><div class="discover-actions"><button class="icon-button filter-entry" type="button" data-action="open-page" data-page="APP-DSC-05" aria-label="打开筛选">${icon("filter")}</button><button class="icon-button" type="button" data-action="open-page" data-page="APP-MSG-05" aria-label="查看通知">${icon("bell")}</button></div></header><button class="search-field" type="button" data-action="open-page" data-page="APP-DSC-04">${icon("search")}<span>搜索名字、地区、职业或标签</span></button><div class="tab-row"><button class="tab-button active">推荐</button><button class="tab-button">地区</button><button class="tab-button">热门</button><button class="tab-button">最新</button></div><div class="person-grid compact discover-grid">${people.map(person => `<button type="button" class="person-card" data-action="open-page" data-page="APP-DSC-07"><div class="person-photo"><img src="${person.image}" alt="${person.name}的虚构演示照片" /><span class="tiny-badge">${icon("shield-check")}资料已认证</span></div><div class="person-copy"><strong>${person.name}</strong><p>${person.meta}</p><small>${person.tag} · 内容推荐</small></div></button>`).join("")}</div></div>`, "推荐");
  }

  function renderSelection(page) {
    return phoneShell(page, `<div class="library-scroll">${mobileHeader(page.name, { caption: "不使用精确定位" })}${stateNotice(page)}<label class="search-field">${icon("search")}<input value="" placeholder="搜索省份或城市" aria-label="搜索地区" /></label><section class="selection-summary"><span>当前范围</span><strong>杭州及周边</strong><button type="button" data-action="secondary">清除</button></section><h3 class="list-section-title">最近使用</h3><div class="region-pills"><button class="selected">杭州</button><button>上海</button><button>南京</button></div><h3 class="list-section-title">按地区浏览</h3>${["浙江", "上海", "江苏", "四川", "广东"].map((name, index) => `<button type="button" class="setting-row" data-action="toggle-choice"><span><strong>${name}</strong><small>${index === 0 ? "杭州、宁波、绍兴等" : "查看可用城市"}</small></span>${icon("chevron-right")}</button>`).join("")}${primaryButton(page)}</div>`);
  }

  function renderCategories(page) {
    const groups = [["内容主题", "生活方式、旅行、阅读", "photo-scan"], ["职业与身份", "设计、出版、艺术", "users"], ["风格", "自然、知性、文艺、清新", "sparkles"], ["地区", "省份、城市与模糊范围", "compass"]];
    return phoneShell(page, `<div class="library-scroll">${mobileHeader(page.name, { caption: "发现更多内容" })}${stateNotice(page)}<div class="category-feature"><span>本周主题</span><h2>城市生活观察</h2><p>平台精选 · 24 个已认证真人资料</p>${icon("arrow-right")}</div><div class="category-grid">${groups.map(group => `<button type="button" class="category-tile" data-action="page-primary">${icon(group[2])}<strong>${group[0]}</strong><small>${group[1]}</small></button>`).join("")}</div></div>`, "推荐");
  }

  function renderSearch(page) {
    return phoneShell(page, `<div class="library-scroll">${mobileHeader(page.name, { caption: "仅搜索公开资料" })}${stateNotice(page)}<label class="search-field active-search">${icon("search")}<input value="生活方式" aria-label="搜索关键词" /><button type="button" data-action="secondary">清除</button></label><div class="search-actions"><button data-action="open-page" data-page="APP-DSC-05">${icon("filter")}筛选</button><button data-action="open-page" data-page="APP-DSC-06">${icon("bookmark")}已保存条件</button></div><h3 class="list-section-title">搜索结果 · 12</h3>${personRows(3)}<div class="search-safety">搜索结果不展示未认证、未发布、授权失效或安全隐藏的资料。</div></div>`, "推荐");
  }

  function renderFilter(page) {
    return phoneShell(page, `<div class="library-scroll">${mobileHeader(page.name, { caption: "预计 12 个结果" })}${stateNotice(page)}${[["地区范围", ["全部地区", "杭州", "上海"]], ["内容风格", ["自然", "知性", "文艺"]], ["职业领域", ["设计", "出版", "艺术"]]].map((group, index) => `<section class="filter-section"><div><strong>${group[0]}</strong>${index === 2 ? `<span class="member-mini">心知可用</span>` : ""}</div><div class="choice-grid">${group[1].map((item, i) => `<button type="button" class="choice-chip ${i === 1 ? "selected" : ""}" data-action="toggle-choice">${item}</button>`).join("")}</div></section>`).join("")}<div class="sticky-actions"><button class="secondary-button" data-action="secondary">清空</button>${primaryButton(page, "查看 12 个结果")}</div></div>`);
  }

  function renderSaved(page) {
    return phoneShell(page, `<div class="library-scroll">${mobileHeader(page.name, { caption: "3 / 5" })}${stateNotice(page)}${[["杭州 · 自然生活", "地区：杭州；风格：自然", "12 个结果"], ["艺术与展览", "主题：艺术；职业：策展", "8 个结果"], ["周末阅读", "标签：阅读、咖啡", "15 个结果"]].map((item, index) => `<article class="saved-filter-card"><span>${icon("filter")}</span><div><strong>${item[0]}</strong><p>${item[1]}</p><small>${item[2]}</small></div><button type="button" data-action="page-primary">使用</button><button class="icon-button" data-action="secondary">${icon("settings")}</button></article>`).join("")}<button type="button" class="secondary-button" data-action="secondary">管理保存额度</button></div>`);
  }

  function renderProfile(page) {
    return phoneShell(page, `<div class="library-scroll profile-library">${stateNotice(page)}<div class="profile-hero"><img src="./assets/portrait-linxia.png" alt="林夏的虚构演示照片" /><button class="icon-button back-floating" data-action="previous-page">${icon("chevron-left")}</button><button class="icon-button profile-more" data-action="secondary">${icon("settings")}</button><div class="profile-overlay"><span class="tiny-badge">${icon("shield-check")}资料已认证</span><h2>林夏</h2><p>杭州 · 品牌策划 · 生活方式</p></div></div><div class="profile-body"><div class="profile-actions"><button class="circle-action" data-action="toggle-choice">${icon("heart")}</button><button class="circle-action" data-action="toggle-choice">${icon("bookmark")}</button>${primaryButton(page)}</div><div class="disclosure-box"><strong>资料与话题说明</strong><br />资料由 MeiGallery 依据授权素材创建和维护。你发起的话题由平台管理员接收与处理，不代表本人在线或亲自回复。</div><h3>关于林夏</h3><p>喜欢城市散步、独立书店和轻松的周末，也会记录自然与城市生活。</p><div class="tag-wrap"><span class="tag">杭州</span><span class="tag">文艺</span><span class="tag">旅行</span><span class="tag">生活方式</span></div><button class="verification-link" data-action="open-page" data-page="APP-DSC-09">${icon("shield-check")}查看认证范围与更新时间${icon("chevron-right")}</button></div></div>`);
  }

  function renderMedia(page) {
    return `<div class="phone-shell library-phone media-phone"><div class="phone-screen library-phone-screen"><div class="media-viewer">${mobileStatus()}<img src="./assets/portrait-linxia.png" alt="林夏的虚构演示照片" /><header><button class="icon-button" data-action="previous-page">${icon("chevron-left")}</button><span>1 / 4</span><button class="icon-button" data-action="secondary">${icon("alert-circle")}</button></header><footer><div><strong>城市春日记录</strong><span>经平台审核的授权素材</span></div><div class="media-controls"><button data-action="secondary">${icon("search")}缩放</button><button data-action="page-primary">${icon("chevron-right")}下一张</button></div></footer></div></div></div>`;
  }

  function renderVerification(page) {
    return phoneShell(page, `<div class="library-scroll">${mobileHeader(page.name, { caption: "林夏 · 2026-07-18 更新" })}${stateNotice(page)}<div class="verification-hero">${icon("shield-check")}<h2>资料已认证</h2><p>认证仅代表下列核验项目在更新时间内有效。</p></div>${[["主体存在性", "已完成身份范围核验"], ["成年信息", "已确认主体年龄满足发布要求"], ["素材授权", "已核验 App 展示与推荐用途"], ["资料一致性", "公开字段与审核材料一致"]].map(item => `<div class="verification-row">${icon("circle-check")}<span><strong>${item[0]}</strong><small>${item[1]}</small></span></div>`).join("")}<div class="disclosure-box">“资料已认证”不代表本人入驻、在线或亲自回复。资料由平台维护。</div>${primaryButton(page)}</div>`);
  }

  function renderFeed(page) {
    return phoneShell(page, `<div class="library-scroll">${mobileHeader(page.name, { back: false, caption: "4 位关注 · 2 条更新", action: "筛选", actionIcon: "filter" })}${stateNotice(page)}<div class="feed-stories">${people.map((person, index) => `<button data-action="open-page" data-page="APP-DSC-07"><span class="story-ring ${index === 0 ? "new" : ""}"><img src="${person.image}" alt="${person.name}的虚构演示照片" /></span><small>${person.name}</small></button>`).join("")}</div><article class="update-card"><header><img src="./assets/portrait-linxia.png" alt="" /><span><strong>林夏</strong><small>平台更新 · 今天 10:20</small></span></header><img class="update-image" src="./assets/portrait-linxia.png" alt="虚构成年人物演示照片" /><p>新增一组城市春日生活内容，资料与素材均已通过平台审核。</p><div><button data-action="toggle-choice">${icon("heart")}喜欢</button><button data-action="open-page" data-page="APP-DSC-07">查看详情</button></div></article></div>`, "关注");
  }

  function renderPeopleList(page) {
    return phoneShell(page, `<div class="library-scroll">${mobileHeader(page.name, { caption: page.id === "APP-SET-06" ? "2 位已拉黑" : "4 位真人" })}${stateNotice(page)}<label class="search-field">${icon("search")}<input placeholder="搜索已保存的真人" aria-label="搜索列表" /></label>${personRows(4)}<div class="list-boundary">列表只保存用户自己的互动记录，不代表对方已收到或建立关系。</div></div>`, page.id.startsWith("APP-SET") ? "我的" : "关注");
  }

  function renderFolders(page) {
    return phoneShell(page, `<div class="library-scroll">${mobileHeader(page.name, { caption: "3 个文件夹", action: "新建", actionIcon: "plus" })}${stateNotice(page)}${[["默认收藏", 12, people[0].image], ["城市生活", 8, people[1].image], ["艺术与阅读", 6, people[2].image]].map(folder => `<button class="folder-card" data-action="open-page" data-page="APP-INT-04"><img src="${folder[2]}" alt="收藏夹封面" /><span><strong>${folder[0]}</strong><small>${folder[1]} 位真人</small></span>${icon("chevron-right")}</button>`).join("")}<div class="list-boundary">收藏夹仅在本人账号内可见；资料下架后显示为不可用项。</div></div>`, "我的");
  }

  function renderHistory(page) {
    return phoneShell(page, `<div class="library-scroll">${mobileHeader(page.name, { caption: "保留 90 天", action: "清除", actionIcon: "x" })}${stateNotice(page)}<h3 class="list-section-title">今天</h3>${personRows(2)}<h3 class="list-section-title">昨天</h3>${personRows(2)}<button type="button" class="secondary-button" data-action="secondary">清除全部浏览历史</button></div>`, "我的");
  }

  function renderChatList(page) {
    return phoneShell(page, `<div class="library-scroll">${mobileHeader(page.name, { back: false, caption: "平台运营统一接收", action: "筛选", actionIcon: "filter" })}${stateNotice(page)}<div class="chat-list-disclosure">${icon("shield-check")}所有话题均由 MeiGallery 平台运营团队接收与处理</div>${people.slice(0, 3).map((person, index) => `<button class="conversation-row" data-action="open-page" data-page="APP-MSG-03"><span class="avatar-wrap"><img src="${person.image}" alt="" />${index === 0 ? `<i>2</i>` : ""}</span><span><strong>${person.name}<em>平台接收</em></strong><p>${index === 0 ? "已收到你的留言，我们会继续处理…" : "关于近期公开内容的话题会话"}</p><small>${index === 0 ? "10:42" : "昨天"}</small></span>${index === 2 ? icon("bell") : ""}</button>`).join("")}</div>`, "消息");
  }

  function renderConfirm(page) {
    return phoneShell(page, `<div class="library-scroll">${mobileHeader(page.name, { caption: "林夏 · 平台接收" })}${stateNotice(page)}<div class="candidate-head"><img src="./assets/portrait-linxia.png" alt="" /><div><h2>与林夏相关的话题</h2><p>接收主体：MeiGallery 平台运营</p></div></div><section class="confirmation-card"><h3>发起话题前请确认</h3>${[["shield-check", "由平台管理员接收和处理"], ["crown", "需要有效心享会员"], ["message-circle", "今日剩余新话题额度 2 次"], ["history", "平台不保证回复时间或关系结果"]].map(item => `<div>${icon(item[0])}<span>${item[1]}</span></div>`).join("")}</section><label class="check-row"><input type="checkbox" checked />我已了解消息接收主体与服务说明</label>${primaryButton(page)}<button class="secondary-button" data-action="previous-page">暂不发起</button></div>`);
  }

  function renderChat(page) {
    const readonly = /只读|冻结|关闭/.test(selectedState(page));
    return phoneShell(page, `<div class="chat-page-library">${mobileHeader("林夏 · 话题会话", { caption: "平台运营接收", action: "会话设置", actionIcon: "settings" })}${stateNotice(page)}<div class="chat-disclosure">本会话由 MeiGallery 平台管理员接收和处理，不代表林夏本人在线或亲自回复。</div><div class="library-chat-thread"><div class="chat-bubble other"><span>平台运营专员</span><p>你好，这里是 MeiGallery 平台运营团队。我会接收并处理这条会话。</p><small>平台回复 · 10:20</small></div><div class="chat-bubble mine"><p>你好，我很喜欢林夏的城市生活内容。</p><small>已送达平台 · 10:22</small></div><div class="chat-bubble other"><span>平台运营专员</span><p>已收到，我们会整理近期公开内容并通过平台回复。</p><small>平台运营已读 · 10:42</small></div></div><form class="library-chat-input"><input ${readonly ? "disabled" : ""} value="${readonly ? "当前会话只读" : "期待更多城市内容…"}" aria-label="消息内容" /><button type="button" ${readonly ? "disabled" : ""} data-action="page-primary">${icon("send")}</button></form></div>`);
  }

  function renderSettings(page) {
    return phoneShell(page, `<div class="library-scroll">${mobileHeader(page.name, { caption: "林夏 · 话题会话" })}${stateNotice(page)}<div class="chat-list-disclosure">${icon("shield-check")}接收与回复主体：MeiGallery 平台运营团队</div>${[["消息静音", "关闭后不显示新消息角标", "bell"], ["举报会话", "提交给独立安全审核", "alert-circle"], ["拉黑相关真人", "停止推荐、互动和新话题", "x"], ["关闭会话", "历史可查看，停止继续发送", "lock"]].map((item, index) => `<button class="setting-row ${index > 1 ? "danger-row" : ""}" data-action="secondary">${icon(item[2])}<span><strong>${item[0]}</strong><small>${item[1]}</small></span>${index === 0 ? `<i class="switch-control active"></i>` : icon("chevron-right")}</button>`).join("")}${primaryButton(page)}</div>`, "消息");
  }

  function renderNotifications(page) {
    const notices = [["平台话题有新回复", "MeiGallery 平台运营已回复你的话题", "10:42", "message-circle"], ["会员等级已生效", "心知会员有效期至 2026-08-20", "昨天", "crown"], ["金币余额已调整", "平台服务补偿 +100 金币", "07-18", "coin"]];
    return phoneShell(page, `<div class="library-scroll">${mobileHeader(page.name, { caption: "3 条未读", action: "全部已读", actionIcon: "circle-check" })}${stateNotice(page)}<div class="tab-row"><button class="tab-button active">全部</button><button class="tab-button">消息</button><button class="tab-button">会员金币</button><button class="tab-button">安全</button></div>${notices.map(notice => `<button class="notice-row" data-action="open-page" data-page="APP-MSG-06"><span>${icon(notice[3])}</span><div><strong>${notice[0]}</strong><p>${notice[1]}</p><small>${notice[2]}</small></div><i></i></button>`).join("")}</div>`, "消息");
  }

  function renderNoticeDetail(page) {
    return phoneShell(page, `<div class="library-scroll">${mobileHeader(page.name, { caption: "消息与话题" })}${stateNotice(page)}<article class="notice-detail-card"><span class="notice-icon">${icon("message-circle")}</span><small>2026-07-23 10:42</small><h2>平台话题有新回复</h2><p>MeiGallery 平台运营团队已经回复你与“林夏”相关的话题。</p><div class="disclosure-box">消息由平台运营接收和回复，不代表真人本人查看、在线或亲自回复。</div><section><span>当前目标状态</span><strong>话题可用 · 心知会员有效</strong></section>${primaryButton(page, "查看平台话题")}</article></div>`, "消息");
  }

  function renderMembership(page) {
    const selected = levelDetails[2];
    return phoneShell(page, `<div class="library-scroll membership-library">${mobileHeader(page.name, { caption: "站内申请 · 人工发放" })}${stateNotice(page)}<div class="membership-hero"><span>${icon("crown")}</span><small>当前账号</small><h2>尚未获得会员</h2><p>有效会员才可发起由平台接收的话题</p></div><div class="level-switch">${levelDetails.map((level, index) => `<button class="${index === 2 ? "active" : ""}" data-action="toggle-choice"><span>${level.name.slice(-1)}</span><small>${level.name}</small></button>`).join("")}</div><article class="level-detail"><span>当前选择</span><h2>${selected.name}会员</h2><p>rank ${selected.rank} · 权益由服务端目录下发</p>${[["message-circle", `每日新话题 ${selected.topics} 个`], ["bookmark", `保存筛选 ${selected.filters} 个 · 收藏夹 ${selected.folders} 个`], ["filter", `高级筛选：${selected.advanced}`]].map(item => `<div>${icon(item[0])}<span>${item[1]}</span>${icon("circle-check")}</div>`).join("")}</article><div class="gate-note">App 1.0 不在线购买、续订或自动开通。申请由平台人工处理，当前不承诺固定时效；管理员正式发放后权益才生效。</div>${primaryButton(page)}</div>`);
  }

  function renderBenefits(page) {
    return phoneShell(page, `<div class="library-scroll">${mobileHeader(page.name, { caption: "心知会员" })}${stateNotice(page)}<div class="benefit-card"><span>当前等级</span><h2>心知</h2><p>有效期至 2026-08-20 23:59</p><div class="benefit-progress"><span style="width:68%"></span></div><small>剩余 29 天</small></div><h3 class="list-section-title">今日权益使用</h3>${[["新建平台话题", "1 / 4", "message-circle"], ["已保存筛选", "3 / 6", "filter"], ["自定义收藏夹", "4 / 10", "bookmark"], ["高级筛选", "完整开放", "circle-check"]].map(item => `<div class="benefit-row">${icon(item[2])}<span><strong>${item[0]}</strong><small>${item[0] === "新建平台话题" ? "每日 00:00 重置" : "当前使用"}</small></span><em>${item[1]}</em></div>`).join("")}<div class="renewal-note">会员到期后历史会话保留为只读；重新获得会员仍需重新校验会话状态。</div>${primaryButton(page)}</div>`, "我的");
  }

  function renderMembershipApplication(page) {
    const value = selectedState(page);
    const active = ["已提交", "处理中", "待补充", "已通过", "已拒绝", "已取消"].includes(value);
    const statusCopy = {
      "已提交": ["等待平台受理", "申请已进入会员服务队列。"],
      "处理中": ["平台正在处理", "运营人员正在核对申请信息。"],
      "待补充": ["需要补充说明", "请按页面提示补充后重新提交。"],
      "已通过": ["申请审核通过", "管理员发放后权益才会生效。"],
      "已拒绝": ["本次申请未通过", "可查看原因说明或联系平台。"],
      "已取消": ["申请已取消", "未产生会员权益，可重新申请。"]
    };
    const status = statusCopy[value] || ["选择期望等级", "提交后可在此查看人工处理状态。"];
    return phoneShell(page, `<div class="library-scroll membership-application-page">${mobileHeader(page.name, { caption: "人工处理 · 不承诺固定时效" })}${stateNotice(page)}${active ? `<div class="application-progress"><span class="done">${icon("circle-check")}已提交</span><i></i><span class="${value === "已提交" ? "active" : "done"}">${icon(value === "已提交" ? "history" : "circle-check")}平台处理</span><i></i><span class="${value === "已通过" ? "active" : ""}">${icon(value === "已通过" ? "circle-check" : "crown")}管理员发放</span></div>` : ""}<article class="membership-application-card"><span>${value}</span><h2>${status[0]}</h2><p>${status[1]}</p>${active ? `<dl><dt>申请编号</dt><dd>MBR-260723-018</dd><dt>期望等级</dt><dd>心知 · rank 30</dd><dt>已验证邮箱</dt><dd>vi****@example.com</dd><dt>提交时间</dt><dd>2026-07-23 14:30</dd></dl>` : `<label>期望等级<select><option>心知 · 每日 4 个新话题</option><option>心遇 · 每日 1 个新话题</option><option>心悦 · 每日 2 个新话题</option><option>心契 · 每日 6 个新话题</option><option>心耀 · 每日 10 个新话题</option></select></label><label>已验证登录邮箱<input value="viewer@example.com" readonly /></label><label>联系时段偏好<select><option>时间不限</option><option>上午</option><option>下午</option><option>晚间</option></select></label><label>申请说明（选填）<textarea maxlength="300">希望使用平台话题与高级筛选。</textarea></label><label class="check-row"><input type="checkbox" checked />我已了解本版本不在线支付，管理员发放后权益才生效。</label>`}</article><div class="disclosure-box"><strong>处理说明</strong><br />当前不承诺固定处理时效或必然通过。平台话题由平台运营接收，不保证固定回复时间或本人回复。</div>${primaryButton(page, active ? value === "待补充" ? "补充并重新提交" : value === "已通过" ? "查看当前权益" : "查看申请进度" : "提交会员申请")}${["已提交", "待补充"].includes(value) ? `<button class="secondary-button" data-action="secondary">取消申请</button>` : ""}</div>`, "我的");
  }

  function renderHelp(page) {
    return phoneShell(page, `<div class="library-scroll">${mobileHeader(page.name, { caption: "帮助与服务" })}${stateNotice(page)}<label class="search-field">${icon("search")}<input placeholder="搜索帮助问题" aria-label="搜索帮助" /></label><div class="help-feature">${icon("message-circle")}<div><strong>关于平台话题</strong><p>话题由平台运营接收和处理，不代表真人本人回复。</p></div></div>${["账号与登录", "真人认证说明", "平台话题与会员", "金币与账本", "举报、申诉与数据权利"].map(item => `<button class="setting-row" data-action="secondary"><span><strong>${item}</strong><small>查看常见问题</small></span>${icon("chevron-right")}</button>`).join("")}${primaryButton(page, "联系平台")}</div>`, "我的");
  }

  function renderWallet(page) {
    return phoneShell(page, `<div class="library-scroll">${mobileHeader(page.name, { caption: "最后同步 10:46" })}${stateNotice(page)}<div class="wallet-card"><span>金币余额</span><h2>520</h2><p>平台内部记录值，不具现金价值</p>${icon("wallet")}</div><div class="wallet-rule"><strong>金币规则</strong><p>金币由管理员依据业务原因加币或扣币；App 1.0 不提供购买、充值、消费、兑换、转账或提现。</p></div><h3 class="list-section-title">最近明细</h3>${ledgerRows(3)}${primaryButton(page)}</div>`, "我的");
  }

  function ledgerRows(limit = 4) {
    const rows = [["平台服务补偿", "+100", "2026-07-18 · COIN-067827"], ["管理员纠正", "-30", "2026-07-09 · COIN-063104"], ["初始化历史余额", "+450", "2026-07-01 · MIG-000521"], ["冲正原分录", "+20", "2026-06-28 · REV-001842"]];
    return rows.slice(0, limit).map((row, index) => `<button class="ledger-row" data-action="open-page" data-page="APP-WAL-03"><span>${icon(index === 1 ? "arrow-right" : "coin")}</span><div><strong>${row[0]}</strong><small>${row[2]}</small></div><em class="${row[1].startsWith("+") ? "positive" : "negative"}">${row[1]}</em></button>`).join("");
  }

  function renderLedger(page) {
    return phoneShell(page, `<div class="library-scroll">${mobileHeader(page.name, { caption: "共 18 笔" })}${stateNotice(page)}<div class="tab-row"><button class="tab-button active">全部</button><button class="tab-button">增加</button><button class="tab-button">扣减</button></div><div class="ledger-balance"><span>当前余额</span><strong>520 金币</strong><small>以服务端有效分录为准</small></div>${ledgerRows(4)}<button class="secondary-button" data-action="secondary">加载更多</button></div>`, "我的");
  }

  function renderLedgerDetail(page) {
    return phoneShell(page, `<div class="library-scroll">${mobileHeader(page.name, { caption: "有效分录" })}${stateNotice(page)}<div class="entry-amount"><span>增加</span><h2>+100</h2><p>金币</p></div>${[["调整原因", "平台服务补偿"], ["发生时间", "2026-07-18 10:32:18"], ["业务单号", "COIN-067827"], ["执行结果", "已写入有效账本"], ["冲正关系", "无"]].map(item => `<div class="detail-pair"><span>${item[0]}</span><strong>${item[1]}</strong></div>`).join("")}<div class="disclosure-box">分录不可编辑或删除；错误通过新增冲正分录修复。</div>${primaryButton(page)}<button class="secondary-button" data-action="secondary">复制业务单号</button></div>`, "我的");
  }

  function renderMe(page) {
    return phoneShell(page, `<div class="library-scroll me-library">${mobileHeader(page.name, { back: false, caption: "观看者账号", action: "设置", actionIcon: "settings" })}${stateNotice(page)}<div class="account-summary"><span class="account-avatar">小</span><div><h2>小美</h2><p>138 **** 8000</p><small>私有账号资料，不会进入真人列表</small></div>${icon("chevron-right")}</div><div class="me-card-grid"><button data-action="open-page" data-page="APP-MBR-02"><span>${icon("crown")}</span><small>当前会员</small><strong>心知</strong><em>剩余 29 天</em></button><button data-action="open-page" data-page="APP-WAL-01"><span>${icon("wallet")}</span><small>金币余额</small><strong>520</strong><em>查看有效分录</em></button></div>${[["账号与设备", "APP-SET-02", "user"], ["隐私与推荐", "APP-SET-04", "shield-check"], ["站内通知偏好", "APP-SET-05", "bell"], ["举报与申诉", "APP-SET-07", "alert-circle"], ["数据权利", "APP-SET-09", "file-description"], ["帮助与关于", "APP-SET-11", "message-circle"]].map(item => `<button class="setting-row" data-action="open-page" data-page="${item[1]}">${icon(item[2])}<span><strong>${item[0]}</strong></span>${icon("chevron-right")}</button>`).join("")}</div>`, "我的");
  }

  function renderAccount(page) {
    return phoneShell(page, `<div class="library-scroll">${mobileHeader(page.name, { caption: "仅本人可见" })}${stateNotice(page)}<div class="account-edit"><span class="account-avatar large">小</span><button data-action="secondary">更换头像</button></div><div class="library-form"><label><span>私有昵称</span><input value="小美" /></label><label><span>登录标识</span><input value="138 **** 8000" readonly /></label><div class="disclosure-box">昵称与头像仅用于识别本人账号，不会创建或修改公开真人资料。</div>${primaryButton(page)}</div></div>`, "我的");
  }

  function renderDevices(page) {
    return phoneShell(page, `<div class="library-scroll">${mobileHeader(page.name, { caption: "2 台设备" })}${stateNotice(page)}<h3 class="list-section-title">当前设备</h3><div class="device-row current">${icon("shield-check")}<span><strong>iPhone 16 Pro</strong><small>杭州 · 当前使用 · 刚刚</small></span><em>本机</em></div><h3 class="list-section-title">其他设备</h3><div class="device-row">${icon("user")}<span><strong>Pixel 9</strong><small>上海 · 2026-07-20 19:42</small></span><button data-action="page-primary">退出</button></div><div class="security-meta"><span>远程退出后</span><strong>该设备私有缓存与会话将失效</strong></div>${primaryButton(page, "退出其他所有设备")}</div>`, "我的");
  }

  function renderToggles(page) {
    const isNotice = page.id === "APP-SET-05";
    const options = isNotice ? [["消息通知", "平台话题有新回复", true], ["互动通知", "关注资料有新公开内容", true], ["会员与金币", "权益或余额发生变化", true], ["营销通知", "可选活动与内容推荐", false], ["账号与安全", "不可关闭的必要通知", true]] : [["个性化推荐", "依据地区、内容热度和偏好排序", true], ["保存浏览历史", "用于本人查看与推荐优化", true], ["可选产品分析", "帮助改进页面和性能", false], ["精确位置", "App 1.0 不采集", false]];
    return phoneShell(page, `<div class="library-scroll">${mobileHeader(page.name, { caption: isNotice ? "站内通知" : "隐私与用途" })}${stateNotice(page)}${options.map((option, index) => `<button class="toggle-row" data-action="toggle-setting" data-setting="${option[0]}" ${isNotice && index === options.length - 1 ? "disabled" : ""}><span><strong>${option[0]}</strong><small>${option[1]}</small></span><i class="switch-control ${state.toggles.has(option[0]) || option[2] ? "active" : ""}"></i></button>`).join("")}<div class="disclosure-box">关闭可选项目不会影响账号、安全、会员、金币和数据权利等必要通知或服务。</div>${primaryButton(page)}</div>`, "我的");
  }

  function renderCases(page) {
    return phoneShell(page, `<div class="library-scroll">${mobileHeader(page.name, { caption: "2 条记录" })}${stateNotice(page)}${[["举报真人资料", "REP-20260718-0042", "处理中", "林夏 · 资料说明"], ["举报平台消息", "REP-20260705-0018", "已完成", "会话内容合规"]].map(item => `<button class="case-row" data-action="page-primary"><span class="case-status">${item[2]}</span><strong>${item[0]}</strong><p>${item[3]}</p><small>${item[1]}</small>${icon("chevron-right")}</button>`).join("")}<div class="list-boundary">进度只展示用户可以理解的状态，不泄露内部证据、人员或风控规则。</div></div>`, "我的");
  }

  function renderAppeal(page) {
    return phoneShell(page, `<div class="library-scroll">${mobileHeader(page.name, { caption: "独立复核" })}${stateNotice(page)}<div class="library-form"><label><span>申诉对象</span><select><option>账号限制 · SEC-2048</option><option>金币分录 · COIN-067827</option></select></label><label><span>申诉说明</span><textarea>请复核当前限制原因，我可以补充必要说明。</textarea></label><label><span>补充材料说明</span><textarea placeholder="请勿填写证件号码或无关敏感信息"></textarea></label><div class="disclosure-box">申诉由与原处置人员隔离的审核人员处理。页面只显示用户可见进度。</div>${primaryButton(page)}</div></div>`, "我的");
  }

  function renderTask(page) {
    return phoneShell(page, `<div class="library-scroll">${mobileHeader(page.name, { caption: "数据权利" })}${stateNotice(page)}<div class="task-hero">${icon("file-description")}<h2>导出我的数据</h2><p>包括账号、互动、会话摘要、会员、金币与举报记录。受法律要求保留或不属于你的数据不在导出范围。</p></div><div class="task-card"><span>最近任务</span><strong>EXP-20260720-0031</strong><p>处理中 · 已完成 68%</p><div class="benefit-progress"><span style="width:68%"></span></div><small>完成后需要重新验证并在有效期内下载</small></div>${primaryButton(page)}<button class="secondary-button" data-action="secondary">查看数据范围</button></div>`, "我的");
  }

  function renderDanger(page) {
    return phoneShell(page, `<div class="library-scroll danger-screen">${mobileHeader(page.name, { caption: "不可逆操作" })}${stateNotice(page)}<div class="danger-hero">${icon("alert-circle")}<h2>注销后将发生什么</h2><p>账号将停止登录，会员与会话发送资格失效，必要数据按法律与安全要求隔离保留。</p></div>${["设备全部退出", "历史会话转为不可用", "会员资格和金币不再可使用", "已提交的举报与审计依法保留"].map(item => `<div class="danger-check">${icon("check")}<span>${item}</span></div>`).join("")}<label class="check-row"><input type="checkbox" />我已了解注销影响和可取消阶段</label>${primaryButton(page, "重新验证并提交注销")}</div>`, "我的");
  }

  function renderAbout(page) {
    return phoneShell(page, `<div class="library-scroll">${mobileHeader(page.name, { caption: "App 1.0" })}${stateNotice(page)}<div class="about-hero"><span class="welcome-logo">M</span><h2>MeiGallery</h2><p>经授权真人内容发现与平台话题服务</p><small>版本 1.0 · Build 100</small></div>${[["用户协议", "APP-AUTH-06"], ["隐私政策", "APP-AUTH-06"], ["社区与内容规则", "APP-SET-11"], ["开源软件许可", "APP-AUTH-06"], ["联系我们", "APP-SET-11"]].map(item => `<button class="setting-row" data-action="open-page" data-page="${item[1]}"><span><strong>${item[0]}</strong></span>${icon("chevron-right")}</button>`).join("")}</div>`, "我的");
  }

  function renderSystem(page) {
    const map = {
      "APP-SYS-01": ["refresh", "需要更新 App", "当前版本无法安全支持最新服务能力。更新前不会继续执行当前操作。"],
      "APP-SYS-02": ["history", "服务正在维护", "暂时无法获取最新数据，已保存的本地内容不代表当前状态。"],
      "APP-SYS-03": ["shield-check", "账号部分功能受限", "平台话题发送暂不可用，浏览和数据权利入口仍可访问。"],
      "APP-SYS-04": ["alert-circle", "当前内容不可访问", "资料、会话或通知目标可能已下架、删除或不在你的权限范围内。"],
      "APP-SYS-05": ["compass", "当前地区暂未开放", "我们尚未在当前地区提供服务，注册与业务入口已停止。"]
    };
    const content = map[page.id];
    return phoneShell(page, `<div class="system-page">${icon(content[0])}<span>${page.id}</span><h2>${content[1]}</h2><p>${content[2]}</p>${primaryButton(page)}<button class="secondary-button" data-action="secondary">${page.secondary[0] || "查看帮助"}</button><small>如状态发生变化，页面会重新向服务端校验。</small></div>`);
  }

  function renderMobile(page) {
    const renderers = {
      launch: renderLaunch, auth: renderAuth, challenge: renderChallenge, preferences: renderPreferences, document: renderDocument,
      discover: renderDiscover, selection: renderSelection, categories: renderCategories, search: renderSearch, filter: renderFilter,
      saved: renderSaved, profile: renderProfile, media: renderMedia, verification: renderVerification, feed: renderFeed,
      "people-list": renderPeopleList, folders: renderFolders, history: renderHistory, "chat-list": renderChatList, confirm: renderConfirm,
      chat: renderChat, settings: renderSettings, notifications: renderNotifications, "notice-detail": renderNoticeDetail,
      membership: renderMembership, benefits: renderBenefits, "membership-application": renderMembershipApplication, help: renderHelp, wallet: renderWallet, ledger: renderLedger,
      "ledger-detail": renderLedgerDetail, me: renderMe, account: renderAccount, devices: renderDevices, toggles: renderToggles,
      cases: renderCases, appeal: renderAppeal, task: renderTask, danger: renderDanger, about: renderAbout, system: renderSystem
    };
    return (renderers[page.template] || renderHelp)(page);
  }

  function adminNavigation(page) {
    const items = [["运营总览", "home", "ADM-OV"], ["真人与内容", "users", "ADM-PER"], ["发现运营", "compass", "ADM-TAX"], ["互动与安全", "message-circle", "ADM-MSG"], ["会员与金币", "crown", "ADM-MBR"], ["通知与审计", "history", "ADM-AUD"]];
    return `<aside class="library-admin-nav"><div class="admin-mini-brand"><span>M</span><strong>MeiGallery</strong></div>${items.map(item => `<button class="${page.id.startsWith(item[2]) || (item[2] === "ADM-TAX" && page.id.startsWith("ADM-REC")) || (item[2] === "ADM-MBR" && page.id.startsWith("ADM-WAL")) || (item[2] === "ADM-AUD" && page.id.startsWith("ADM-NTF")) ? "active" : ""}">${icon(item[1])}<span>${item[0]}</span></button>`).join("")}<small>生产环境 · 华东</small></aside>`;
  }

  function adminShell(page, body) {
    return `<div class="admin-shell library-admin-shell">${adminNavigation(page)}<main class="library-admin-main"><header class="admin-topline"><div><small>${escapeHtml(page.id)} · ${escapeHtml(groupFor(page)?.name || "管理后台")}</small><h2>${escapeHtml(page.name)}</h2><p>${escapeHtml(page.purpose)}</p></div><div><span class="admin-scope">${icon("shield-check")}当前范围：华东运营组</span><button class="primary-button hotspot" data-action="page-primary">${escapeHtml(page.primary)}</button></div></header>${stateNotice(page)}${body}</main></div>`;
  }

  function adminMetric(label, value, note, tone = "") {
    return `<article class="admin-metric ${tone}"><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`;
  }

  function adminTable(headers, rows, pageId) {
    return `<div class="admin-data-table"><div class="admin-table-row header">${headers.map(item => `<span>${item}</span>`).join("")}</div>${rows.map((row, index) => `<button type="button" class="admin-table-row" data-action="${pageId ? "open-page" : "secondary"}" ${pageId ? `data-page="${pageId}"` : ""}>${row.map((item, cell) => `<span class="${cell === row.length - 1 ? "status-cell" : ""}">${cell === 0 && index < people.length ? `<img src="${people[index].image}" alt="" />` : ""}${item}</span>`).join("")}</button>`).join("")}</div>`;
  }

  function renderAdminDashboard(page) {
    const body = `<div class="admin-metrics">${adminMetric("已发布真人", "86", "本周 +7", "good")}${adminMetric("待认证", "12", "最久等待 3.2 小时")}${adminMetric("待平台回复", "18", "4 条接近服务时段")}${adminMetric("账本差异", "3", "需要人工解释", "warn")}</div><div class="dashboard-grid"><section class="admin-panel"><div class="panel-title"><strong>今日运营主线</strong><span>2026-07-23 · 实时摘要</span></div>${adminTable(["领域", "待处理", "状态"], [["真人认证", "12 项", "正常"], ["平台话题", "18 条", "关注"], ["会员申请/发放", "6 项", "待复核"], ["金币调整", "3 项", "高风险"]])}</section><section class="admin-panel"><div class="panel-title"><strong>数据质量</strong><span>未知不等于 0</span></div><div class="quality-ring"><strong>96.8%</strong><span>可用数据</span></div>${["推荐快照延迟 2 分钟", "通知队列正常", "钱包 Sequence 校验通过"].map(item => `<div class="quality-line">${icon("circle-check")}<span>${item}</span></div>`).join("")}</section></div>`;
    return adminShell(page, body);
  }

  function renderAdminQueue(page) {
    const isConversation = page.id === "ADM-MSG-01";
    const isAppeal = page.id === "ADM-SAF-03";
    const rows = isConversation ? [["林夏 · 话题会话", "华东一组", "等待 18 分钟", "待平台"], ["清禾 · 话题会话", "未分配", "等待 11 分钟", "待分配"], ["知遥 · 话题会话", "安全组", "等待 6 分钟", "安全审核"]] : isAppeal ? [["APL-2081", "账号限制", "独立复核二组", "待复核"], ["APL-2074", "内容处置", "未分配", "即将逾期"], ["APL-2068", "金币分录", "复核一组", "处理中"]] : [["INC-0421", "钱包 Sequence 缺口", "未分配", "P1"], ["INC-0418", "推荐快照延迟", "SRE-华东", "P1"], ["INC-0411", "通知模板失败", "消息组", "已缓解"]];
    const next = page.next;
    const body = `<div class="admin-toolbar"><label>${icon("search")}<input placeholder="搜索 ID、账号或对象" /></label><button data-action="secondary">${icon("filter")}筛选</button><button data-action="secondary">保存视图</button></div><div class="admin-filter-summary"><span>已应用：生产环境</span><span>华东范围</span><span>最近 24 小时</span><button data-action="secondary">清空</button></div>${adminTable([isConversation ? "会话" : isAppeal ? "申诉" : "异常", "当前归属", "等待时间", "状态"], rows, next)}<div class="admin-pagination"><span>共 18 项 · 数据更新于 10:46</span><div><button disabled>上一页</button><button class="active">1</button><button>2</button><button>下一页</button></div></div>`;
    return adminShell(page, body);
  }

  function renderAdminIncident(page) {
    const body = `<div class="admin-detail-grid"><section class="admin-panel"><div class="panel-title"><strong>影响摘要</strong><span class="risk-label">P1 · 处理中</span></div><h3>钱包 Sequence 出现 3 个缺口</h3><p>影响 3 个账号的余额对账；公开余额已进入安全锁定，不影响历史分录读取。</p><div class="impact-grid"><span><small>发现时间</small><strong>09:42</strong></span><span><small>负责人</small><strong>未分配</strong></span><span><small>影响账号</small><strong>3</strong></span></div><div class="safety-actions"><button data-action="secondary">冻结受影响钱包</button><button data-action="secondary">关联 Runbook</button></div></section><section class="admin-panel"><div class="panel-title"><strong>处置时间线</strong><span>所有记录进入审计</span></div>${[["09:42", "完整性校验发现缺口"], ["09:45", "系统自动锁定余额变更"], ["10:02", "SRE 完成初步定位"]].map(item => `<div class="timeline-row"><span>${item[0]}</span><i></i><p>${item[1]}</p></div>`).join("")}<label class="admin-note"><span>添加处置记录</span><textarea>已核对 3 个账号的有效分录，准备创建 forward-fix。</textarea></label></section></div>`;
    return adminShell(page, body);
  }

  function renderAdminTablePage(page) {
    const body = `<div class="admin-toolbar"><label>${icon("search")}<input placeholder="搜索展示名、稳定 ID 或地区" /></label><button data-action="secondary">${icon("filter")}状态与地区</button><button data-action="secondary">批量导入</button></div>${adminTable(["真人", "认证状态", "发布状态", "授权有效期", "最近更新"], [["林夏 · PER-2841", "已认证", "已发布", "2027-03-18", "10:32"], ["清禾 · PER-2839", "待复核", "草稿", "2027-01-06", "09:18"], ["知遥 · PER-2836", "待认证", "草稿", "未知", "昨天"], ["沐青 · PER-2828", "已认证", "已暂停", "2026-11-20", "07-20"]], "ADM-PER-03")}<div class="admin-pagination"><span>86 项 · 第 1–4 项</span><div><button class="active">1</button><button>2</button><button>下一页</button></div></div>`;
    return adminShell(page, body);
  }

  function adminFormFields(page) {
    if (page.id.startsWith("ADM-WAL")) return [["稳定账号", "138 0013 8000 · ACCT-002841"], ["调整方向", "加币"], ["数量", "100"], ["标准原因", "平台服务补偿"], ["业务单号", "COIN-067827"]];
    if (page.id.startsWith("ADM-MBR")) return [["稳定账号", "viewer@example.com · ACCT-002841"], ["会员等级", "心知 · rank 30"], ["生效时间", "2026-07-22 10:30"], ["到期时间", "2026-08-20 23:59"], ["业务单号", "MBR-024811"]];
    return [["展示名", "林夏"], ["地区范围", "浙江 · 杭州"], ["主体来源", "授权素材导入"], ["授权用途", "App 展示、推荐与互动"], ["公开说明", "资料由平台维护"]];
  }

  function renderAdminForm(page) {
    const fields = adminFormFields(page);
    const body = `<div class="admin-form-layout"><section class="admin-panel"><div class="panel-title"><strong>基础信息</strong><span>保存草稿不等于提交</span></div><div class="admin-grid-form">${fields.map((field, index) => `<label class="${index === fields.length - 1 ? "full" : ""}"><span>${field[0]}</span>${index === fields.length - 1 ? `<textarea>${field[1]}</textarea>` : `<input value="${field[1]}" />`}</label>`).join("")}</div></section><aside class="admin-panel admin-impact"><div class="panel-title"><strong>提交前检查</strong><span>5 / 5</span></div>${["对象 ID 已确认", "来源与业务单号完整", "用户可见说明已填写", "内部原因与公开文案分离", "幂等键未重复"].map(item => `<div>${icon("circle-check")}<span>${item}</span></div>`).join("")}<div class="audit-note">所有写操作记录操作者、角色范围、原因、请求 ID 和前后差异。</div></aside></div>`;
    return adminShell(page, body);
  }

  function renderAdminWorkbench(page) {
    const body = `<div class="workbench-layout"><section class="admin-panel"><div class="person-workbench-head"><img src="./assets/portrait-linxia.png" alt="林夏的虚构演示照片" /><div><span>PER-2841</span><h3>林夏</h3><p>浙江 · 杭州 · 品牌策划</p></div><div><em>认证：待审核</em><em>发布：草稿</em></div></div><nav class="workbench-tabs"><button class="active">公开资料</button><button>媒体</button><button>来源授权</button><button>版本</button></nav><div class="preview-columns"><div><span>App 公开预览</span><img src="./assets/portrait-linxia.png" alt="" /><strong>林夏</strong><small>资料已认证 · 平台维护</small></div><div>${[["展示名", "林夏"], ["地区", "杭州"], ["职业", "品牌策划"], ["授权有效期", "2027-03-18"]].map(item => `<p><span>${item[0]}</span><strong>${item[1]}</strong></p>`).join("")}</div></div></section><aside class="admin-panel"><div class="panel-title"><strong>状态与版本</strong><span>v12</span></div><div class="status-timeline"><div class="done">${icon("circle-check")}<span><strong>内容草稿</strong><small>已保存 · 09:12</small></span></div><div class="current">${icon("history")}<span><strong>认证审核</strong><small>等待审核员领取</small></span></div><div>${icon("lock")}<span><strong>发布审核</strong><small>认证通过后可发起</small></span></div></div><button class="secondary-button" data-action="secondary">查看版本差异</button></aside></div>`;
    return adminShell(page, body);
  }

  function renderAdminImport(page) {
    const body = `<div class="import-dropzone">${icon("file-description")}<h3>拖入 gallery-import.zip</h3><p>包含 manifest.csv、content.md、cover.jpg 与至少一张图片</p><button data-action="secondary">选择导入包</button></div><div class="admin-metrics">${adminMetric("待校验", "12", "正在读取 manifest")}${adminMetric("可导入", "86", "将创建草稿", "good")}${adminMetric("失败", "3", "不阻塞其他项目", "warn")}</div>${adminTable(["目录", "标题", "校验", "媒体", "结果"], [["gallery-001", "夏日生活", "通过", "8 张", "可导入"], ["gallery-002", "城市空间", "通过", "6 张", "可导入"], ["gallery-003", "阅读日常", "缺少来源", "4 张", "失败"]])}`;
    return adminShell(page, body);
  }

  function renderAdminReview(page) {
    const publication = page.id === "ADM-PER-06";
    const body = `<div class="review-layout"><section class="admin-panel review-preview"><div class="panel-title"><strong>${publication ? "App 发布预览" : "待审核资料"}</strong><span>锁定版本 v12</span></div><div class="review-person"><img src="./assets/portrait-zhiyao.png" alt="知遥的虚构演示照片" /><div><span class="tiny-badge">${icon("shield-check")}${publication ? "认证已通过" : "待认证"}</span><h3>知遥</h3><p>南京 · 出版编辑 · 阅读生活</p><small>资料由 MeiGallery 依据授权素材创建和维护</small></div></div></section><section class="admin-panel"><div class="panel-title"><strong>${publication ? "发布门禁" : "认证检查"}</strong><span>4 / 4</span></div>${[publication ? "认证当前有效" : "主体存在性与身份范围", "成年信息满足发布要求", "App 展示与推荐授权", "媒体权利与公开字段一致"].map(item => `<button class="review-check checked" data-action="toggle-choice">${icon("circle-check")}<span>${item}</span><small>已核验</small></button>`).join("")}<label class="admin-note"><span>审核结论与原因</span><textarea>材料完整，公开说明与实际核验范围一致。</textarea></label><div class="review-actions"><button class="secondary-button" data-action="secondary">退回补充</button><button class="primary-button" data-action="page-primary">${page.primary}</button></div></section></div>`;
    return adminShell(page, body);
  }

  function renderAdminTree(page) {
    const body = `<div class="tree-layout"><section class="admin-panel"><div class="panel-title"><strong>目录版本 2026.07</strong><span>当前生效</span></div><label class="admin-search">${icon("search")}<input placeholder="搜索词条或别名" /></label>${["地区", "身份", "职业", "风格", "内容类型"].map((item, index) => `<button class="tree-node ${index === 0 ? "active" : ""}" data-action="secondary">${icon(index === 0 ? "compass" : "file-description")}<span><strong>${item}</strong><small>${[34, 18, 42, 27, 16][index]} 个词条</small></span>${icon("chevron-right")}</button>`).join("")}</section><section class="admin-panel"><div class="panel-title"><strong>地区 / 浙江</strong><button data-action="secondary">新建子词条</button></div>${adminTable(["词条", "稳定 ID", "引用", "状态"], [["杭州", "REG-HGH", "28", "生效"], ["宁波", "REG-NGB", "14", "生效"], ["绍兴", "REG-SXG", "8", "生效"]], "ADM-TAX-02")}</section></div>`;
    return adminShell(page, body);
  }

  function renderAdminTerm(page) {
    const body = `<div class="admin-form-layout"><section class="admin-panel"><div class="panel-title"><strong>词条事实</strong><span>TERM-REG-HGH</span></div><div class="admin-grid-form"><label><span>显示名称</span><input value="杭州" /></label><label><span>稳定 ID</span><input value="REG-HGH" readonly /></label><label class="full"><span>别名</span><input value="杭州市, Hangzhou, HGH" /></label><label class="full"><span>legacy 映射</span><textarea>浙江/杭州；华东/杭州；城市-330100</textarea></label></div></section><aside class="admin-panel admin-impact"><div class="panel-title"><strong>引用与合并影响</strong><span>28 个对象</span></div>${[["真人资料", "18"], ["推荐规则", "4"], ["已保存筛选", "6"]].map(item => `<div class="impact-row"><span>${item[0]}</span><strong>${item[1]}</strong></div>`).join("")}<button class="secondary-button" data-action="secondary">预览合并影响</button></aside></div>`;
    return adminShell(page, body);
  }

  function renderAdminRelease(page) {
    const body = `<div class="release-summary"><span>目录版本</span><h3>2026.08 候选版</h3><p>新增 8 个词条，更新 4 个别名，合并 2 个重复项</p></div><div class="admin-detail-grid"><section class="admin-panel"><div class="panel-title"><strong>兼容性检查</strong><span>5 / 6 通过</span></div>${["未知引用已清零", "公开资料可重新投影", "推荐规则字段兼容", "客户端 1.0 支持目录版本", "保存筛选可迁移", "2 个 legacy 值需要人工映射"].map((item, index) => `<div class="release-check ${index === 5 ? "warn" : ""}">${icon(index === 5 ? "alert-circle" : "circle-check")}<span>${item}</span></div>`).join("")}</section><section class="admin-panel"><div class="panel-title"><strong>影响范围</strong><span>共 42 个对象</span></div>${adminTable(["对象类型", "数量", "处理"], [["真人资料", "24", "自动映射"], ["推荐规则", "6", "无需修改"], ["保存筛选", "10", "版本迁移"], ["未知值", "2", "人工复核"]])}</section></div>`;
    return adminShell(page, body);
  }

  function renderAdminRules(page) {
    const body = `<div class="admin-toolbar"><label>${icon("search")}<input placeholder="搜索规则版本" /></label><button data-action="secondary">比较版本</button></div>${adminTable(["版本", "候选策略", "状态", "流量", "最近更新"], [["REC-2026.07.3", "地区 + 偏好 + 热度", "当前生效", "100%", "10:32"], ["REC-2026.08.1", "地区 + 内容质量", "灰度", "10%", "09:20"], ["REC-2026.06.4", "基础热度", "已回滚", "0%", "07-18"]], "ADM-REC-02")}<div class="safety-filter-card">${icon("shield-check")}<div><strong>安全过滤固定前置</strong><p>认证、授权、发布和安全状态不可由推荐规则关闭或降低。</p></div></div>`;
    return adminShell(page, body);
  }

  function renderAdminEditor(page) {
    const body = `<div class="editor-layout"><section class="admin-panel"><div class="panel-title"><strong>候选与排序配置</strong><span>草稿 REC-2026.08.1</span></div>${[["候选集合", "已发布 + 认证有效 + 授权有效"], ["地区因子", "模糊地区一致性 · 权重 25"], ["偏好因子", "标签与内容主题 · 权重 35"], ["热度因子", "7 天衰减内容热度 · 权重 20"], ["质量因子", "内容完整度 · 权重 20"]].map(item => `<div class="rule-block"><span>${icon("settings")}</span><div><strong>${item[0]}</strong><p>${item[1]}</p></div><button data-action="secondary">编辑</button></div>`).join("")}</section><aside class="admin-panel"><div class="panel-title"><strong>不可关闭前置</strong><span>平台安全</span></div>${["认证有效", "授权用途有效", "发布状态为 published", "无安全隐藏", "地区服务可用"].map(item => `<div class="release-check">${icon("lock")}<span>${item}</span></div>`).join("")}<div class="audit-note">排序配置不能修改认证、授权或安全资格。</div></aside></div>`;
    return adminShell(page, body);
  }

  function renderAdminCompare(page) {
    const body = `<div class="compare-controls"><label>合成场景<select><option>杭州 · 喜欢自然与阅读</option></select></label><button data-action="page-primary">运行 Dry-run</button></div><div class="compare-layout">${[["当前版本", "REC-2026.07.3", [0, 1, 2]], ["候选版本", "REC-2026.08.1", [1, 0, 3]]].map(column => `<section class="admin-panel"><div class="panel-title"><strong>${column[0]}</strong><span>${column[1]}</span></div>${column[2].map((index, rank) => `<div class="rank-row"><em>${rank + 1}</em><img src="${people[index].image}" alt="" /><span><strong>${people[index].name}</strong><small>${people[index].meta}</small></span><p>${rank === 0 ? "地区与偏好高度相关" : "内容质量与热度稳定"}</p></div>`).join("")}</section>`).join("")}</div>`;
    return adminShell(page, body);
  }

  function renderAdminCalendar(page) {
    const body = `<div class="placement-grid"><section class="admin-panel"><div class="panel-title"><strong>本周精选排期</strong><span>2026-07-20 — 07-26</span></div><div class="calendar-head">${["一", "二", "三", "四", "五", "六", "日"].map(item => `<span>${item}</span>`).join("")}</div><div class="calendar-body">${Array.from({ length: 7 }, (_, index) => `<button class="calendar-day ${index === 2 ? "active" : ""}"><small>${20 + index}</small>${index < 5 ? `<span>${people[index % 4].name}<em>平台精选</em></span>` : ""}</button>`).join("")}</div></section><aside class="admin-panel"><div class="panel-title"><strong>排期详情</strong><span>PL-0842</span></div><label><span>展示位置</span><input value="推荐首页 · 首屏精选" /></label><label><span>公开披露</span><input value="平台精选" /></label><label><span>开始 / 结束</span><input value="07-22 10:00 — 07-23 22:00" /></label><div class="review-person compact"><img src="./assets/portrait-linxia.png" alt="" /><div><strong>林夏</strong><small>认证与授权当前有效</small></div></div></aside></div>`;
    return adminShell(page, body);
  }

  function renderAdminConversation(page) {
    const body = `<div class="conversation-workbench"><section class="admin-panel conversation-list"><div class="panel-title"><strong>待处理队列</strong><span>18</span></div>${people.slice(0, 3).map((person, index) => `<button class="queue-item ${index === 0 ? "active" : ""}"><span class="queue-person"><img src="${person.image}" alt="" /><span><strong>${person.name} · 话题会话</strong><small>${index === 0 ? "等待平台回复 · 18 分钟" : "等待运营处理"}</small></span></span><span class="queue-count">${index + 1}</span></button>`).join("")}</section><section class="admin-panel operator-thread"><div class="panel-title"><strong>林夏 · 话题会话</strong><span>租约剩余 12:48</span></div><div class="operator-disclosure">前台固定披露：本会话由平台管理员接收和处理。</div><div class="operator-messages"><p class="user-message">你好，我很喜欢林夏的城市生活内容。</p><p class="platform-message">已收到，我们会整理近期公开内容。</p></div><label class="admin-note"><span>平台回复</span><textarea>已收到你的留言，我们会通过平台继续回复相关公开内容。</textarea></label><div class="operator-actions"><button data-action="secondary">内部备注</button><button data-action="secondary">转派</button><button class="primary-button" data-action="page-primary">以平台运营身份发送</button></div></section><aside class="admin-panel conversation-context"><div class="panel-title"><strong>最小必要上下文</strong><span>只读</span></div>${[["观看者", "ACCT-002841"], ["会员", "心知 · 有效"], ["今日额度", "剩余 2 次"], ["安全状态", "正常"], ["接收主体", "平台运营"]].map(item => `<div class="detail-pair"><span>${item[0]}</span><strong>${item[1]}</strong></div>`).join("")}</aside></div>`;
    return adminShell(page, body);
  }

  function renderAdminSchedule(page) {
    const body = `<div class="admin-metrics">${adminMetric("当前值班", "8", "华东一组")}${adminMetric("可用容量", "42", "会话并发上限", "good")}${adminMetric("队列负载", "78%", "接近预警")}</div><div class="schedule-layout"><section class="admin-panel"><div class="panel-title"><strong>今日班次</strong><span>10:00 — 22:00</span></div>${[["早班", "10:00—16:00", "4 人", "正常"], ["晚班", "16:00—22:00", "4 人", "正常"], ["安全值守", "全天", "2 人", "独立队列"]].map(item => `<div class="shift-row"><span>${item[0]}</span><strong>${item[1]}</strong><em>${item[2]}</em><small>${item[3]}</small></div>`).join("")}</section><section class="admin-panel"><div class="panel-title"><strong>自动分配规则</strong><span>v8</span></div>${["运营组与地区一致", "最长等待优先", "安全冻结不进入普通队列", "单人并发不超过 6", "领取后租约 15 分钟"].map(item => `<div class="release-check">${icon("circle-check")}<span>${item}</span></div>`).join("")}</section></div>`;
    return adminShell(page, body);
  }

  function renderAdminQuality(page) {
    const body = `<div class="admin-metrics">${adminMetric("本周样本", "80", "合规抽样")}${adminMetric("身份披露", "98.8%", "目标 ≥ 99%", "warn")}${adminMetric("越权读取", "0", "必须保持 0", "good")}</div><div class="quality-layout"><section class="admin-panel"><div class="panel-title"><strong>抽检样本</strong><span>最小正文授权</span></div>${adminTable(["会话", "运营组", "抽检原因", "状态"], [["CONV-1208", "华东一组", "随机样本", "待检查"], ["CONV-1192", "华东二组", "披露规则", "需改进"], ["CONV-1187", "华东一组", "新员工样本", "合格"]])}</section><aside class="admin-panel"><div class="panel-title"><strong>检查项</strong><span>CONV-1192</span></div>${["平台运营身份持续披露", "未暗示本人在线或已读", "未承诺回复或见面", "未泄露内部备注", "服务文案准确"].map((item, index) => `<button class="review-check ${index === 1 ? "warn" : "checked"}">${icon(index === 1 ? "alert-circle" : "circle-check")}<span>${item}</span><small>${index === 1 ? "需改进" : "合格"}</small></button>`).join("")}</aside></div>`;
    return adminShell(page, body);
  }

  function renderAdminCase(page) {
    const body = `<div class="case-layout"><section class="admin-panel"><div class="panel-title"><strong>最小必要证据</strong><span>CASE-2081</span></div><div class="evidence-block"><span>举报对象</span><strong>真人资料 · PER-2841</strong><p>用户认为认证说明可能过期，请核对授权与资料更新时间。</p></div><div class="evidence-block"><span>公开快照</span><div class="review-person compact"><img src="./assets/portrait-linxia.png" alt="" /><div><strong>林夏</strong><small>资料已认证 · 2026-07-18 更新</small></div></div></div><div class="evidence-restricted">${icon("lock")}未授权证件与无关会话正文已隐藏</div></section><section class="admin-panel"><div class="panel-title"><strong>处置结论</strong><span>独立审核</span></div><label><span>结论</span><select><option>请求补充授权证据</option><option>维持公开</option><option>暂停资料</option></select></label><label class="admin-note"><span>用户可见说明</span><textarea>平台正在复核资料认证范围，处理期间已停止新的话题入口。</textarea></label><label class="admin-note"><span>内部理由</span><textarea>授权有效期字段需要与原件重新核对。</textarea></label></section></div>`;
    return adminShell(page, body);
  }

  function renderAdminCatalog(page) {
    const body = `<div class="catalog-version-head"><div><span>当前生效版本</span><h3>会员目录 1.0</h3><p>建议基线 · 5 个等级 · 精确额度待客户确认</p></div><button data-action="secondary">比较版本</button></div><div class="membership-admin-grid">${levelDetails.map((level, index) => `<article class="membership-admin-card ${index === 2 ? "active" : ""}"><span>${level.name.slice(-1)}</span><small>rank ${level.rank}</small><h3>${level.name}</h3><p>每日 ${level.topics} 个新话题 · 保存筛选 ${level.filters}</p><em>收藏夹 ${level.folders} · ${level.advanced}</em></article>`).join("")}</div><div class="safety-filter-card">${icon("file-description")}<div><strong>名称与权限分离</strong><p>业务逻辑只比较 rank 和稳定 entitlement key，不硬编码会员名称。</p></div></div>`;
    return adminShell(page, body);
  }

  function renderAdminDefinition(page) {
    const body = `<div class="definition-layout"><section class="admin-panel"><div class="panel-title"><strong>Entitlement 定义</strong><span>12 项</span></div>${[["messaging.send", "发送平台话题消息", "boolean"], ["messaging.new_quota", "每日新话题额度", "integer"], ["filter.advanced", "高级筛选", "enum"], ["saved_filter.limit", "保存筛选上限", "integer"]].map((item, index) => `<button class="definition-row ${index === 0 ? "active" : ""}"><code>${item[0]}</code><span>${item[1]}</span><em>${item[2]}</em></button>`).join("")}</section><section class="admin-panel"><div class="panel-title"><strong>messaging.send</strong><span>v3 · 生效</span></div><label><span>数据类型</span><input value="boolean" readonly /></label><label><span>默认值</span><input value="false" /></label><label><span>支持客户端</span><input value="App ≥ 1.0" /></label><label class="admin-note"><span>用途说明</span><textarea>允许有效会员在服务端校验后发送平台话题消息。</textarea></label></section></div>`;
    return adminShell(page, body);
  }

  function renderAdminGrantList(page) {
    const body = `<div class="admin-toolbar"><label>${icon("search")}<input value="viewer@example.com" /></label><button data-action="secondary">查询账号</button></div><div class="account-grant-head"><span class="account-avatar">小</span><div><strong>待处理申请 · MBR-260723-018</strong><p>期望：心知会员 · 提交于 2026-07-23 14:30</p></div><button data-action="page-primary">受理会员申请</button></div>${adminTable(["申请/业务单号", "等级", "来源", "申请版本", "状态"], [["MBR-260723-018", "心知", "用户站内申请", "v1", "待处理"], ["MBR-024811", "心知", "用户申请后发放", "v4", "生效"], ["MBR-021404", "心悦", "管理员直接发放", "v2", "到期"]])}`;
    return adminShell(page, body);
  }

  function renderAdminApproval(page) {
    const wallet = page.id.startsWith("ADM-WAL");
    const body = `<div class="approval-layout"><section class="admin-panel"><div class="panel-title"><strong>申请内容</strong><span>${wallet ? "COIN-067827" : "MBR-024811"}</span></div>${(wallet ? [["账号", "ACCT-002841"], ["调整", "+100 金币"], ["调整前", "520"], ["预计调整后", "620"], ["原因", "平台服务补偿"]] : [["账号", "ACCT-002841"], ["当前等级", "免费"], ["申请等级", "心知 · rank 30"], ["有效期", "2026-08-20 23:59"], ["来源", "线下资格确认"]]).map(item => `<div class="detail-pair"><span>${item[0]}</span><strong>${item[1]}</strong></div>`).join("")}<div class="audit-note">申请人：会员运营-小周；当前复核人：复核-小陈。职责分离检查通过。</div></section><section class="admin-panel"><div class="panel-title"><strong>复核检查</strong><span>4 / 4</span></div>${["申请人与复核人不同", "账号当前状态已刷新", "业务单号未重复", wallet ? "余额变化未导致负数" : "权益差异与有效期明确"].map(item => `<div class="release-check">${icon("circle-check")}<span>${item}</span></div>`).join("")}<label class="admin-note"><span>复核理由</span><textarea>已核对业务来源、账号状态和前后影响，同意执行。</textarea></label><div class="review-actions"><button class="secondary-button" data-action="secondary">拒绝</button><button class="primary-button" data-action="page-primary">${page.primary}</button></div></section></div>`;
    return adminShell(page, body);
  }

  function renderAdminMigration(page) {
    const body = `<div class="admin-metrics">${adminMetric("待映射", "248", "legacy vip/svip")}${adminMetric("可自动", "182", "证据完整", "good")}${adminMetric("需复核", "66", "有效期或来源缺失", "warn")}</div>${adminTable(["旧账号", "旧等级", "证据", "建议映射", "结果"], [["LEG-10281", "svip", "有效期明确", "心知", "可执行"], ["LEG-10272", "vip", "仅来源", "心遇", "需复核"], ["LEG-10260", "svip", "有效期缺失", "不自动映射", "冲突"]])}<div class="migration-footer"><span>${icon("shield-check")}迁移采用先双读对账、再切换读主；不长期应用层双写。</span><button data-action="secondary">导出冲突</button></div>`;
    return adminShell(page, body);
  }

  function renderAdminWalletSearch(page) {
    const body = `<div class="wallet-search-hero"><span>${icon("search")}</span><h3>查询用户钱包</h3><p>使用稳定账号 ID、手机号摘要或业务单号查询；不支持按余额排名。</p><label><input value="138 0013 8000" /><button data-action="page-primary">查询</button></label></div><div class="recent-searches"><div class="panel-title"><strong>最近授权查询</strong><span>仅本人视图</span></div>${adminTable(["账号", "余额", "对账", "查询原因"], [["ACCT-002841", "520", "正常", "用户申诉"], ["ACCT-002812", "180", "差异", "异常核查"], ["ACCT-002706", "0", "正常", "会员服务"]], "ADM-WAL-02")}</div>`;
    return adminShell(page, body);
  }

  function renderAdminWallet(page) {
    const body = `<div class="wallet-admin-head"><div><small>稳定账号</small><h3>ACCT-002841</h3><p>138 **** 8000 · 状态正常</p></div><div><small>有效余额</small><strong>520</strong><span>Sequence 18 · 校验通过</span></div></div><div class="admin-detail-grid"><section class="admin-panel"><div class="panel-title"><strong>有效分录</strong><span>最后同步 10:46</span></div>${adminTable(["分录", "原因", "数量", "Sequence"], [["COIN-067827", "服务补偿", "+100", "18"], ["COIN-063104", "管理员纠正", "-30", "17"], ["MIG-000521", "历史迁移", "+450", "16"]])}</section><aside class="admin-panel"><div class="panel-title"><strong>完整性</strong><span>正常</span></div>${[["有效分录合计", "520"], ["缓存余额", "520"], ["Sequence", "连续"], ["未决申请", "1"]].map(item => `<div class="detail-pair"><span>${item[0]}</span><strong>${item[1]}</strong></div>`).join("")}<div class="audit-note">余额不可直接编辑，只能通过批准后的追加分录变化。</div></aside></div>`;
    return adminShell(page, body);
  }

  function renderAdminBatch(page) {
    const body = `<div class="batch-stepper"><span class="done">1 上传</span><span class="done">2 校验</span><span class="active">3 复核</span><span>4 执行</span></div><div class="admin-metrics">${adminMetric("总账号", "120", "CSV 批量任务")}${adminMetric("预计净变化", "+8,400", "需要独立复核")}${adminMetric("高风险项", "3", "超过单笔阈值", "warn")}</div>${adminTable(["账号", "方向", "数量", "原因", "校验"], [["ACCT-002841", "加币", "+100", "服务补偿", "通过"], ["ACCT-002812", "扣币", "-30", "管理员纠正", "通过"], ["ACCT-002706", "加币", "+1,200", "活动补发", "需复核"]])}`;
    return adminShell(page, body);
  }

  function renderAdminReconciliation(page) {
    const body = `<div class="admin-metrics">${adminMetric("待解释差异", "3", "影响 3 个钱包", "warn")}${adminMetric("已锁定", "3", "停止新调整")}${adminMetric("校验通过", "12,842", "最近一轮", "good")}</div>${adminTable(["账号", "有效分录合计", "缓存余额", "差异", "状态"], [["ACCT-002812", "180", "150", "+30", "待认领"], ["ACCT-002706", "0", "20", "-20", "调查中"], ["ACCT-002668", "620", "520", "+100", "待解释"]])}<div class="safety-filter-card">${icon("shield-check")}<div><strong>仅允许 Forward-fix</strong><p>不能覆盖原分录或直接修改余额；修复必须新增关联原分录的冲正或纠正记录。</p></div></div>`;
    return adminShell(page, body);
  }

  function renderAdminEvent(page) {
    const body = `<div class="admin-toolbar"><label>${icon("search")}<input placeholder="搜索事件 key" /></label><button data-action="secondary">必要通知</button></div>${adminTable(["事件 Key", "用户用途", "必要性", "版本", "状态"], [["conversation.platform_reply", "平台话题新回复", "必要", "v3", "生效"], ["membership.granted", "会员已生效", "必要", "v2", "生效"], ["wallet.entry_created", "金币余额变化", "必要", "v4", "生效"], ["content.following_update", "关注内容更新", "可选", "v2", "生效"]], "ADM-NTF-02")}`;
    return adminShell(page, body);
  }

  function renderAdminTemplate(page) {
    const body = `<div class="template-layout"><section class="admin-panel"><div class="panel-title"><strong>模板草稿</strong><span>conversation.platform_reply · v4</span></div><label><span>标题</span><input value="平台话题有新回复" /></label><label class="admin-note"><span>正文</span><textarea>MeiGallery 平台运营团队已经回复你与“{{person_display_name}}”相关的话题。</textarea></label><div class="variable-list"><span>{{person_display_name}}</span><span>{{conversation_id}}</span><span>{{event_time}}</span></div><div class="disclosure-box">模板禁止写“本人回复”“本人已读”“正在输入”或保证回复。</div></section><section class="admin-panel"><div class="panel-title"><strong>用户预览</strong><span>简体中文 · 华东</span></div><div class="notification-preview"><span>${icon("message-circle")}</span><div><strong>平台话题有新回复</strong><p>MeiGallery 平台运营团队已经回复你与“林夏”相关的话题。</p><small>刚刚</small></div></div><div class="detail-pair"><span>目标动作</span><strong>打开平台话题</strong></div><div class="detail-pair"><span>必要性</span><strong>不可由营销开关屏蔽</strong></div></section></div>`;
    return adminShell(page, body);
  }

  function renderAdminDelivery(page) {
    const body = `<div class="admin-metrics">${adminMetric("今日生成", "12,842", "去重后")}${adminMetric("失败", "18", "模板变量缺失", "warn")}${adminMetric("抑制", "426", "用户偏好或防重")}</div>${adminTable(["事件 ID", "事件类型", "目标账号", "结果", "防重键"], [["EVT-88201", "platform_reply", "ACCT-002841", "已生成", "conv-1208-seq18"], ["EVT-88192", "membership_granted", "ACCT-002812", "已生成", "grant-24811"], ["EVT-88181", "following_update", "ACCT-002706", "已抑制", "content-0821"]])}`;
    return adminShell(page, body);
  }

  function renderAdminAudit(page) {
    const body = `<div class="audit-query"><label>时间范围<input value="2026-07-22 00:00 — 10:46" /></label><label>动作<select><option>全部高风险动作</option></select></label><label>对象或业务单号<input value="" placeholder="ID / 业务单号" /></label><label>操作者<input value="" placeholder="管理员或系统" /></label><button data-action="page-primary">执行查询</button></div>${adminTable(["时间", "操作者", "动作", "对象", "结果"], [["10:42:18", "operator-018", "conversation.reply", "CONV-1208", "成功"], ["10:32:04", "reviewer-006", "coin.approve", "COIN-067827", "成功"], ["10:18:51", "publisher-012", "person.publish", "PER-2841", "成功"], ["09:42:07", "system-integrity", "wallet.lock", "ACCT-002812", "成功"]], "ADM-AUD-02")}`;
    return adminShell(page, body);
  }

  function renderAdminAuditDetail(page) {
    const body = `<div class="audit-detail-layout"><section class="admin-panel"><div class="panel-title"><strong>审计事件</strong><span>AUD-984120</span></div>${[["发生时间", "2026-07-23 10:32:04.182"], ["操作者", "reviewer-006 · 财务复核"], ["动作", "coin.adjustment.approve"], ["对象", "COIN-067827 / ACCT-002841"], ["请求链", "REQ-c8421 / Trace-83f1"], ["结果", "成功"]].map(item => `<div class="detail-pair"><span>${item[0]}</span><strong>${item[1]}</strong></div>`).join("")}</section><section class="admin-panel"><div class="panel-title"><strong>脱敏差异</strong><span>不可修改</span></div><div class="diff-card before"><span>执行前</span><code>balance: 520<br />sequence: 17<br />status: pending</code></div><div class="diff-card after"><span>执行后</span><code>balance: 620<br />sequence: 18<br />status: approved</code></div><div class="audit-note">平台话题正文、证件、Token、签名 URL 与内部备注未进入通用审计展示。</div></section></div>`;
    return adminShell(page, body);
  }

  function renderAdminIntegrity(page) {
    const body = `<div class="integrity-hero good">${icon("shield-check")}<div><span>最近完整性校验</span><h3>99.98% 通过</h3><p>2026-07-22 10:30 · 校验 42,810 个业务事件</p></div><button data-action="page-primary">重新运行</button></div><div class="admin-detail-grid"><section class="admin-panel"><div class="panel-title"><strong>异常类型</strong><span>3 项</span></div>${[["Sequence 缺口", "2", "钱包与会员"], ["业务成功但无审计", "1", "通知模板"], ["孤立审批", "0", "正常"]].map(item => `<div class="integrity-row"><span>${item[0]}</span><strong>${item[1]}</strong><small>${item[2]}</small></div>`).join("")}</section><section class="admin-panel"><div class="panel-title"><strong>校验范围</strong><span>生产 · 华东</span></div>${["会员申请/批准/执行", "金币分录与余额 Sequence", "真人认证与发布投影", "会话领取与平台回复", "安全处置与申诉改判"].map(item => `<div class="release-check">${icon("circle-check")}<span>${item}</span></div>`).join("")}</section></div>`;
    return adminShell(page, body);
  }

  function renderAdminExport(page) {
    const body = `<div class="export-layout"><section class="admin-panel"><div class="panel-title"><strong>新建受控导出</strong><span>需要独立复核</span></div><label><span>查询范围</span><input value="2026-07-23 · 高风险写操作 · 华东" readonly /></label><label><span>导出目的</span><select><option>内部合规复核</option></select></label><label class="admin-note"><span>用途说明</span><textarea>用于季度金币与会员高风险操作抽样复核。</textarea></label><div class="disclosure-box">导出不包含平台话题正文、证件、Token 或内部备注。批准后使用短期下载凭证。</div></section><section class="admin-panel"><div class="panel-title"><strong>历史申请</strong><span>最近 30 天</span></div>${[["EXP-AUD-2041", "已批准", "剩余 18 分钟"], ["EXP-AUD-2034", "已过期", "不可下载"], ["EXP-AUD-2028", "待复核", "范围已变化"]].map(item => `<div class="export-row"><span><strong>${item[0]}</strong><small>${item[2]}</small></span><em>${item[1]}</em><button data-action="secondary">查看</button></div>`).join("")}</section></div>`;
    return adminShell(page, body);
  }

  function renderAdmin(page) {
    const renderers = {
      dashboard: renderAdminDashboard, queue: renderAdminQueue, incident: renderAdminIncident, table: renderAdminTablePage,
      form: renderAdminForm, workbench: renderAdminWorkbench, import: renderAdminImport, review: renderAdminReview,
      tree: renderAdminTree, term: renderAdminTerm, release: renderAdminRelease, rules: renderAdminRules, editor: renderAdminEditor,
      compare: renderAdminCompare, calendar: renderAdminCalendar, conversation: renderAdminConversation, schedule: renderAdminSchedule,
      quality: renderAdminQuality, case: renderAdminCase, catalog: renderAdminCatalog, definition: renderAdminDefinition,
      "grant-list": renderAdminGrantList, approval: renderAdminApproval, migration: renderAdminMigration,
      "wallet-search": renderAdminWalletSearch, "wallet-admin": renderAdminWallet, batch: renderAdminBatch,
      reconciliation: renderAdminReconciliation, event: renderAdminEvent, "template-editor": renderAdminTemplate,
      delivery: renderAdminDelivery, audit: renderAdminAudit, "audit-detail": renderAdminAuditDetail,
      integrity: renderAdminIntegrity, export: renderAdminExport
    };
    return (renderers[page.template] || renderAdminDashboard)(page);
  }

  const layoutDescriptions = {
    launch: "品牌与恢复状态居中；最低版本和维护状态优先于业务入口。", auth: "单任务表单；错误就近呈现；观看者身份边界位于主操作之后。",
    discover: "推荐范围、搜索、频道与真人内容构成首屏；卡片优先展示认证和推荐理由。", profile: "媒体主视觉、单向互动、身份披露和资料正文依次展开。",
    chat: "接收主体固定置顶；消息线程、状态和输入区清晰分层。", membership: "当前身份、五级切换、精确权益和站内申请入口构成完整门槛。",
    "membership-application": "申请表单、人工处理说明、权威状态和管理员发放结果构成完整闭环。",
    system: "单一事实、明确影响和安全下一步，不暴露内部风控细节。", dashboard: "指标摘要、质量状态和专题入口分层，未知值不显示为零。",
    queue: "筛选、范围、等待时间和状态优先，列表与详情入口稳定。", review: "锁定版本预览与审核检查并列，编辑和批准职责分离。",
    conversation: "队列、会话正文和最小必要上下文三栏分工，发送主体不可选择。", approval: "申请事实与复核检查并列，前后影响和职责分离始终可见。"
  };

  function ruleFor(page) {
    if (page.id.startsWith("APP-AUTH")) return "注册和登录只处理观看者账号，不创建公开真人资料。";
    if (page.id.startsWith("APP-DSC")) return "只展示认证有效、已发布、授权有效且未被安全隐藏的资料。";
    if (page.id.startsWith("APP-INT")) return "喜欢、关注和收藏互相独立，不产生匹配、通知对方或双向关系。";
    if (page.id.startsWith("APP-MSG")) return "话题由平台管理员接收与处理；只有有效会员可以新建和发送。";
    if (page.id.startsWith("APP-MBR")) return "App 1.0 不在线支付；提交申请不产生权限，管理员 grant 生效后才获得会员权益。";
    if (page.id.startsWith("APP-WAL")) return "金币不具现金价值；客户端只读余额和有效分录，不出现购买、充值、消费、兑换、转账或提现。";
    if (page.id.startsWith("APP-SET")) return "账号设置不改变公开真人资料；敏感操作需要服务端重验。";
    if (page.id.startsWith("APP-SYS")) return "缓存不能冒充最新事实；必须提供可理解原因和安全返回路径。";
    if (page.id.startsWith("ADM-MSG")) return "管理员只能以固定平台运营身份发送，正文读取按租约和对象范围控制。";
    if (page.id.startsWith("ADM-WAL")) return "余额只允许通过追加分录变化；高风险申请需要独立复核。";
    if (page.id.startsWith("ADM-MBR")) return "等级名称配置化，权限使用 rank 与稳定 entitlement key。";
    return "后台操作必须经过 capability、对象范围、版本检查和不可删除审计。";
  }

  function renderInspector(page) {
    const next = catalog.pages.find(item => item.id === page.next);
    els.inspectorContent.innerHTML = `<div class="page-inspector-title"><span>${escapeHtml(page.id)} · ${escapeHtml(page.priority)}</span><h2>${escapeHtml(page.name)}</h2><p>${escapeHtml(page.purpose)}</p></div><section class="rule-card"><h3>页面目标与入口</h3><dl><dt>交付优先级</dt><dd><strong>${escapeHtml(page.priority)}</strong></dd><dt>进入方式</dt><dd>${escapeHtml(page.entry)}</dd><dt>设计路由</dt><dd><code>${escapeHtml(page.route)}</code></dd><dt>主要操作</dt><dd>${escapeHtml(page.primary)}</dd></dl></section><section class="interaction-card"><h3>页面结构</h3><p>${escapeHtml(layoutDescriptions[page.template] || `${page.name}采用与当前业务任务匹配的独立布局，重点突出事实、主操作和状态反馈。`)}</p><div class="inspector-actions"><strong>次要操作</strong><div>${page.secondary.map(item => `<span>${escapeHtml(item)}</span>`).join("") || "<span>返回上一页</span>"}</div></div></section><section class="state-spec-card"><h3>必须覆盖的状态</h3><div>${page.states.map(item => `<button type="button" class="${selectedState(page) === item ? "active" : ""}" data-action="set-page-state" data-state="${escapeHtml(item)}">${escapeHtml(item)}</button>`).join("")}</div></section><section class="expected-card"><h3>不可变规则</h3><p>${escapeHtml(ruleFor(page))}</p></section><section class="acceptance-card"><h3>页面级验收</h3><ol><li>入口、Page ID 和返回路径明确。</li><li>主操作有加载、成功和失败反馈。</li><li>服务端状态变化后不会展示过期权限。</li><li>空、错误和受限状态提供安全下一步。</li><li>不存在 App 1.0 范围外入口。</li></ol></section><div class="next-page-card"><span>建议下一页</span><strong>${next ? `${next.id} · ${next.name}` : "返回页面目录"}</strong><button type="button" data-action="${next ? "open-page" : "reset-page"}" ${next ? `data-page="${next.id}"` : ""}>继续评审${icon("chevron-right")}</button></div><p class="inspector-footnote">页面数据、账号、人物和金额均为本地演示，不连接生产系统。</p>`;
  }

  function renderNav() {
    const query = state.search.trim().toLowerCase();
    const pages = activePages().filter(item => !query || `${item.id} ${item.name} ${item.route}`.toLowerCase().includes(query));
    const groups = catalog.groups.filter(group => group.platform === state.platform);
    els.nav.innerHTML = groups.map(group => {
      const prefixes = [group.prefix, ...(group.extraPrefixes || [])];
      const items = pages.filter(item => prefixes.some(prefix => item.id.startsWith(prefix)));
      if (!items.length) return "";
      return `<section class="page-nav-group"><header><strong>${group.name}</strong><span>${items.length}</span></header>${items.map(item => `<button type="button" class="page-nav-item ${state.currentId === item.id ? "active" : ""}" data-action="open-page" data-page="${item.id}"><span>${item.id.replace("APP-", "").replace("ADM-", "")}</span><strong>${item.name}</strong><em class="page-priority ${item.priority.toLowerCase()}">${item.priority}</em>${state.completed.has(item.id) ? icon("circle-check") : ""}</button>`).join("")}</section>`;
    }).join("") || `<div class="catalog-empty">没有找到页面<br /><button data-action="clear-search">清除搜索</button></div>`;
  }

  function renderStates(page) {
    els.states.innerHTML = `<span>页面状态</span>${page.states.map(item => `<button type="button" class="${selectedState(page) === item ? "active" : ""}" data-action="set-page-state" data-state="${escapeHtml(item)}">${escapeHtml(item)}</button>`).join("")}`;
  }

  function renderCaptureStateSummary(page) {
    if (!captureMode || !els.captureStateSummary) return;
    const value = selectedState(page);
    const risk = isRiskState(value);
    els.captureStateSummary.classList.toggle("risk", risk);
    els.captureStateSummary.innerHTML = `${icon(risk ? "alert-circle" : "circle-check")}<div><span>当前原型状态</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(stateDescription(value))}</small></div>`;
  }

  function markCaptureReady() {
    if (!captureMode) return;
    document.documentElement.dataset.captureReady = "false";
    const images = Array.from(document.images);
    Promise.all(images.map(image => {
      if (image.complete && image.naturalWidth > 0) return Promise.resolve();
      if (typeof image.decode === "function") return image.decode().catch(() => undefined);
      return new Promise(resolve => {
        image.addEventListener("load", resolve, { once: true });
        image.addEventListener("error", resolve, { once: true });
      });
    })).then(() => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        document.documentElement.dataset.captureReady = "true";
      }));
    });
  }

  function updateHistory(page) {
    const url = new URL(location.href);
    url.searchParams.set("page", page.id);
    url.searchParams.set("state", selectedState(page));
    history.replaceState(null, "", url);
  }

  function render() {
    const page = currentPage();
    if (!page.states.includes(state.currentState)) state.currentState = normalState(page);
    document.documentElement.dataset.currentPageId = page.id;
    document.documentElement.dataset.currentState = selectedState(page);
    const group = groupFor(page);
    const index = catalog.pages.findIndex(item => item.id === page.id);
    els.title.textContent = page.name;
    els.kicker.textContent = `${page.platform === "mobile" ? "移动端" : "管理后台"} · ${group ? group.name : "页面设计"}`;
    els.route.textContent = `${page.id} · ${page.priority} · ${page.route}`;
    els.statePill.textContent = selectedState(page);
    els.progressText.textContent = `${String(index + 1).padStart(2, "0")} / ${catalog.pages.length}`;
    els.footerLabel.textContent = page.id;
    els.progressBar.style.width = `${((index + 1) / catalog.pages.length) * 100}%`;
    els.stage.classList.toggle("admin-page-preview", page.platform === "admin");
    els.stage.style.animation = "none";
    void els.stage.offsetWidth;
    els.stage.style.animation = "sceneEnter 360ms var(--ease) both";
    els.stage.innerHTML = page.platform === "mobile" ? renderMobile(page) : renderAdmin(page);
    renderStates(page);
    renderCaptureStateSummary(page);
    renderNav();
    renderInspector(page);
    document.querySelectorAll("[data-action='set-platform']").forEach(button => button.classList.toggle("active", button.dataset.platform === state.platform));
    updateHistory(page);
    requestAnimationFrame(() => {
      const active = els.nav.querySelector(".page-nav-item.active");
      if (active && !active.matches(":hover")) active.scrollIntoView({ block: "nearest" });
    });
    markCaptureReady();
  }

  function openPage(pageId) {
    const page = catalog.pages.find(item => item.id === pageId);
    if (!page) return;
    state.currentId = page.id;
    state.platform = page.platform;
    state.currentState = normalState(page);
    els.catalog.classList.remove("open");
    els.inspector.classList.remove("open");
    render();
  }

  function movePage(delta) {
    const index = catalog.pages.findIndex(item => item.id === state.currentId);
    const nextIndex = Math.min(catalog.pages.length - 1, Math.max(0, index + delta));
    openPage(catalog.pages[nextIndex].id);
  }

  function handleAction(action, target) {
    const page = currentPage();
    switch (action) {
      case "open-page": openPage(target.dataset.page); break;
      case "previous-page": movePage(-1); break;
      case "next-page": movePage(1); break;
      case "set-page-state": state.currentState = target.dataset.state; render(); break;
      case "set-platform": {
        state.platform = target.dataset.platform;
        const first = catalog.pages.find(item => item.platform === state.platform);
        state.currentId = first.id;
        state.currentState = normalState(first);
        render();
        break;
      }
      case "page-primary":
        state.completed.add(page.id);
        showToast(`“${page.primary}”已记录，准备进入建议下一页`);
        renderNav();
        if (target.dataset.navigate === "false") break;
        if (page.next) window.setTimeout(() => openPage(page.next), 320);
        break;
      case "secondary": showToast("次要操作已触发；原型保留当前页面便于继续评审"); break;
      case "toggle-choice": target.classList.toggle("selected"); break;
      case "select-legal-document": state.legalDocument = target.dataset.document || "terms"; render(); break;
      case "toggle-setting": {
        const key = target.dataset.setting;
        if (state.toggles.has(key)) state.toggles.delete(key); else state.toggles.add(key);
        target.querySelector(".switch-control")?.classList.toggle("active", state.toggles.has(key));
        break;
      }
      case "toggle-catalog": els.catalog.classList.toggle("open"); break;
      case "toggle-page-inspector": els.inspector.classList.toggle("open"); break;
      case "clear-search": state.search = ""; els.search.value = ""; renderNav(); break;
      case "reset-page": state.currentState = normalState(page); state.completed.delete(page.id); render(); showToast("当前页面已恢复默认状态"); break;
      default: break;
    }
  }

  document.addEventListener("click", event => {
    const target = event.target.closest("[data-action]");
    if (target) handleAction(target.dataset.action, target);
  });

  els.search.addEventListener("input", event => {
    state.search = event.target.value;
    renderNav();
  });

  document.addEventListener("keydown", event => {
    const tag = document.activeElement?.tagName;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;
    if (event.key === "ArrowUp") { event.preventDefault(); movePage(-1); }
    if (event.key === "ArrowDown") { event.preventDefault(); movePage(1); }
    if (event.key === "Escape") { els.catalog.classList.remove("open"); els.inspector.classList.remove("open"); }
  });

  render();
})();
