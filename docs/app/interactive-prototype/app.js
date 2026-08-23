(function () {
  "use strict";

  const icon = (name, className = "") => `<img class="${className}" src="./assets/icons/${name}.svg" alt="" />`;

  const people = [
    { id: "linxia", name: "林夏", age: 27, city: "杭州", field: "品牌策划", style: "松弛自然", image: "./assets/portrait-linxia.png", bio: "喜欢城市散步、独立书店和轻松的周末。资料由平台依据授权素材整理并维护。", tags: ["浙江", "文艺", "旅行", "生活方式"] },
    { id: "qinghe", name: "清禾", age: 29, city: "上海", field: "空间设计", style: "冷静知性", image: "./assets/portrait-qinghe.png", bio: "关注空间、设计与日常秩序，愿意分享关于展览和城市生活的片段。", tags: ["上海", "设计", "展览", "简约"] },
    { id: "zhiyao", name: "知遥", age: 31, city: "南京", field: "出版编辑", style: "温暖从容", image: "./assets/portrait-zhiyao.png", bio: "常在书页和咖啡香之间工作，也记录安静但有趣的城市角落。", tags: ["江苏", "阅读", "咖啡", "温暖"] },
    { id: "muqing", name: "沐青", age: 26, city: "成都", field: "艺术策展", style: "独立清新", image: "./assets/portrait-muqing.png", bio: "喜欢当代艺术、摄影与具有地方气息的生活内容。", tags: ["四川", "艺术", "摄影", "清新"] }
  ];

  const levels = [
    { id: "xinyu", name: "心遇", rank: 10, initial: "遇", topics: 1, filters: 1, folders: 3, advanced: "不开放" },
    { id: "xinyue", name: "心悦", rank: 20, initial: "悦", topics: 2, filters: 3, folders: 5, advanced: "基础组合" },
    { id: "xinzhi", name: "心知", rank: 30, initial: "知", topics: 4, filters: 6, folders: 10, advanced: "完整开放" },
    { id: "xinqi", name: "心契", rank: 40, initial: "契", topics: 6, filters: 12, folders: 20, advanced: "完整开放" },
    { id: "xinyao", name: "心耀", rank: 50, initial: "耀", topics: 10, filters: 20, folders: 30, advanced: "完整开放" }
  ];

  const params = new URLSearchParams(location.search);
  const initialScene = Math.min(7, Math.max(0, Number(params.get("scene") || 0)));

  const state = {
    scene: initialScene,
    loggedIn: params.get("logged") === "1",
    category: "推荐",
    liked: new Set(),
    followed: new Set(),
    selectedPerson: people[0],
    selectedLevel: "xinyu",
    membershipRequest: null,
    member: params.get("member") === "1",
    memberLevel: "心遇",
    memberExpiry: "2026-08-20 23:59",
    chatReadonly: params.get("readonly") === "1",
    chatMessages: [
      { mine: false, author: "平台运营专员", text: "你好，这里是 MeiGallery 平台运营团队。我会接收并处理这条会话。", status: "平台回复" },
      { mine: true, text: "你好，我很喜欢林夏的城市生活内容，想了解更多。", status: "已送达平台" }
    ],
    chatDraft: "想了解近期更新的城市生活内容",
    walletTab: params.get("wallet") === "coins" ? "金币" : "通知",
    walletBalance: 520,
    reviewPerson: people[2],
    reviewStatus: "待审核",
    reviewChecks: { authorization: true, adult: true, identity: false },
    operationTab: ["消息", "会员", "金币"].includes(params.get("op")) ? params.get("op") : "消息",
    coinRequest: null,
    filterCity: "全部地区"
  };

  const scenes = [
    {
      title: "欢迎与登录",
      short: "进入与账号",
      kicker: "移动端 · 首次进入",
      state: () => state.loggedIn ? "已登录" : "未登录",
      lead: "App 1.0 使用邮箱密码登录，注册增加邮箱验证码。普通注册用户仅作为内容观看者，不会自动成为列表中的真人。",
      rule: "注册身份与真人资料完全分离。只有管理员认证或管理员创建并发布的真人资料，才会出现在发现列表。",
      actions: [
        { label: "填写邮箱和密码并登录", action: "login" },
        { label: "查看完整业务流程", action: "show-overview" }
      ],
      expected: "登录成功后进入发现页；用户没有资料发布入口，也不会被其他观看者检索。",
      render: renderWelcome
    },
    {
      title: "发现真人",
      short: "推荐与筛选",
      kicker: "移动端 · 核心浏览",
      state: () => `${state.category} · ${state.filterCity}`,
      lead: "以经过管理员审核的真人资料为核心，通过地区、热度和内容标签进行喜好推荐。",
      rule: "仅展示 published 且认证通过的资料。不展示在线状态、精确距离、即时匹配或回复保证。",
      actions: [
        { label: "切换推荐分类", action: "category-hot" },
        { label: "打开地区与标签筛选", action: "open-filter" },
        { label: "进入林夏详情", action: "open-profile" }
      ],
      expected: "用户可搜索、筛选、喜欢、关注或收藏；所有偏好行为只影响个人内容体验。",
      render: renderDiscovery
    },
    {
      title: "真人详情",
      short: "资料与关系",
      kicker: "移动端 · 内容详情",
      state: () => state.member ? `${state.memberLevel}会员` : "普通用户",
      lead: "详情页强化素材质量、认证来源和平台维护边界，同时提供喜欢、关注、收藏和平台话题入口。",
      rule: "当前资料多数并非真人本人运营。详情页必须明确说明资料由平台维护，话题由平台管理员接收和处理。",
      actions: [
        { label: "切换喜欢状态", action: "toggle-like" },
        { label: "关注该真人", action: "toggle-follow" },
        { label: "尝试发起话题", action: "try-message" }
      ],
      expected: "非会员点击“发起话题”进入会员门槛；有效会员可直接创建或继续平台话题会话。",
      render: renderProfile
    },
    {
      title: "会员门槛",
      short: "五级权限",
      kicker: "移动端 · 权限说明",
      state: () => state.member ? `${state.memberLevel} · 有效` : state.membershipRequest ? state.membershipRequest.status : "未申请",
      lead: "五个会员等级展示精确额度；用户在 App 内提交申请，平台处理后由管理员发放。",
      rule: "App 1.0 不接入支付。提交申请不等于获得会员；只有管理员发放生效后，用户才能新建和发送平台话题。",
      actions: [
        { label: "选择心知等级", action: "select-xinzhi" },
        { label: "提交会员申请", action: "request-membership" },
        { label: "模拟管理员审核并发放", action: "prototype-grant" },
        { label: "会员有效后进入会话", action: "open-chat" }
      ],
      expected: "申请状态可查询，管理员 grant 生效后才获得权限；会员到期后会话保留但输入区只读。",
      render: renderMembership
    },
    {
      title: "平台话题",
      short: "话题与披露",
      kicker: "移动端 · 平台接收",
      state: () => state.chatReadonly ? "会员到期 · 只读" : state.member ? "会员有效" : "无发送权限",
      lead: "用户面向所选真人发起话题，但消息实际由平台管理员接收和处理，界面全程保持披露。",
      rule: "不需要双方同意。有效心享会员即可发送；不得暗示真人本人在线、正在输入、已读或亲自回复。",
      actions: [
        { label: "发送一条演示消息", action: "send-demo-message" },
        { label: "模拟平台运营回复", action: "operator-reply" },
        { label: "切换会员到期只读", action: "toggle-readonly" }
      ],
      expected: "消息状态使用“已送达平台/平台已处理”；会员失效后历史消息仍可查看，但不能继续发送。",
      render: renderChat
    },
    {
      title: "通知与钱包",
      short: "明细与账号",
      kicker: "移动端 · 个人资产",
      state: () => `${state.walletBalance} 金币`,
      lead: "把会员变更、运营回复和金币变动汇总为可追溯通知，同时提供清晰的金币明细。",
      rule: "金币不具现金价值。App 1.0 没有购买、充值、消费、兑换、转账、提现或赠礼入口；管理员调整必须生成不可覆盖的明细。",
      actions: [
        { label: "查看金币明细", action: "wallet-coins" },
        { label: "返回通知中心", action: "wallet-notices" },
        { label: "前往后台调币演示", action: "goto-coins" }
      ],
      expected: "每笔余额变化显示类型、数额、原因、时间和业务单号；客户端只读，不提供充值按钮。",
      render: renderWallet
    },
    {
      title: "内容审核",
      short: "认证与发布",
      kicker: "管理后台 · 真人供给",
      state: () => state.reviewStatus,
      lead: "管理员创建或导入真人资料，校验成年、授权、素材来源与身份信息后，才能发布到 App。",
      rule: "未通过认证的资料永远不能出现在公开列表；公开发布和审核操作必须写入审计日志。",
      actions: [
        { label: "补全身份核验", action: "complete-review" },
        { label: "批准并发布资料", action: "approve-person" },
        { label: "退回并填写原因", action: "return-person" }
      ],
      expected: "审核通过后状态变为“已发布”；退回不会影响其他资料，原因与操作者进入审计记录。",
      render: renderAdminReview
    },
    {
      title: "运营与调币",
      short: "话题和内控",
      kicker: "管理后台 · 运营工作台",
      state: () => `${state.operationTab}工作台`,
      lead: "统一处理平台话题、会员申请与发放、金币调整，并通过固定发送主体、审批与审计控制运营风险。",
      rule: "管理员回复的发送主体固定为平台运营；加币扣币采用申请与审批分离，余额只允许通过账本流水变更。",
      actions: [
        { label: "切换会员发放", action: "operation-member" },
        { label: "创建金币调整申请", action: "operation-coin" },
        { label: "完成独立审批", action: "coin-approve" }
      ],
      expected: "会员即时生效并有明确到期时间；金币审批后生成唯一流水并同步到用户钱包。",
      render: renderOperations
    }
  ];

  const els = {
    nav: document.getElementById("scene-nav"),
    title: document.getElementById("scene-title"),
    kicker: document.getElementById("scene-kicker"),
    state: document.getElementById("scene-state"),
    progressText: document.getElementById("scene-progress-text"),
    progressBar: document.getElementById("progress-bar"),
    stage: document.getElementById("device-stage"),
    inspector: document.getElementById("inspector"),
    inspectorContent: document.getElementById("inspector-content"),
    sidebar: document.getElementById("scene-sidebar"),
    modal: document.getElementById("modal-layer"),
    toast: document.getElementById("toast-region")
  };

  function phoneStatus() {
    return `<div class="phone-status"><span>9:41</span><span class="status-icons">▮▮▮ ◉ ▰</span></div>`;
  }

  function phoneTabs(active = "推荐") {
    const tabs = [
      ["推荐", "compass", 1],
      ["关注", "photo-scan", 1],
      ["消息", "message-circle", 4],
      ["我的", "user", 5]
    ];
    return `<div class="phone-tabs">${tabs.map(([label, glyph, scene]) => `
      <button type="button" class="bottom-tab ${active === label ? "active" : ""}" data-action="goto-scene" data-scene="${scene}">
        ${icon(glyph)}<span>${label}</span>
      </button>`).join("")}</div>`;
  }

  function renderWelcome() {
    return `<div class="phone-shell">
      <div class="phone-screen welcome-screen">
        ${phoneStatus()}
        <div class="welcome-content">
          <div class="welcome-logo">M</div>
          <h2>遇见值得了解的人</h2>
          <p>浏览经过平台审核的真人资料与内容</p>
          <label class="form-field">${icon("mail")}<input id="login-email" inputmode="email" value="viewer@example.com" aria-label="邮箱" /></label>
          <label class="form-field">${icon("lock")}<input id="login-password" type="password" value="password" aria-label="密码" /></label>
          <div class="welcome-actions">
            <button type="button" class="primary-button hotspot" data-action="login">${icon("login")}登录并继续</button>
            <button type="button" class="secondary-button" data-action="login">注册观看者账号</button>
          </div>
          <div class="welcome-legal">注册需逐项确认当前四类生效文档；文档更新后登录也需重新确认。<br />注册用户仅为观看者，不会自动成为公开真人资料。</div>
        </div>
      </div>
    </div>`;
  }

  function renderDiscovery() {
    return `<div class="phone-shell">
      <div class="phone-screen">
        ${phoneStatus()}
        <div class="phone-content">
          <div class="phone-toolbar">
            <div><strong>${state.filterCity}</strong><span style="color:var(--muted);font-size:9px;margin-left:4px">内容推荐</span></div>
            <div class="toolbar-actions"><button class="icon-button hotspot" type="button" data-action="open-filter" aria-label="筛选" title="筛选">${icon("adjustments-horizontal")}</button></div>
          </div>
          <div class="search-field" role="search" data-action="open-filter">${icon("search")}<span>搜索名字、地区、职业或标签</span></div>
          <div class="tab-row">${["推荐", "热度", "同城", "艺术", "生活"].map(item => `<button type="button" class="tab-button ${state.category === item ? "active" : ""}" data-action="set-category" data-category="${item}">${item}</button>`).join("")}</div>
          <div class="person-grid">${people.map((person, index) => `
            <button type="button" class="person-card ${index === 0 ? "hotspot" : ""}" data-action="open-person" data-person="${person.id}">
              <div class="person-photo"><img src="${person.image}" alt="${person.name}的虚构演示照片" /><span class="tiny-badge">${icon("shield-check")}资料已认证</span></div>
              <div class="person-copy"><strong>${person.name}</strong><p>${person.age}岁 · ${person.field}</p><small>${person.city} · ${person.style}</small></div>
            </button>`).join("")}</div>
        </div>
        ${phoneTabs("推荐")}
      </div>
    </div>`;
  }

  function renderProfile() {
    const person = state.selectedPerson;
    const liked = state.liked.has(person.id);
    const followed = state.followed.has(person.id);
    return `<div class="phone-shell">
      <div class="phone-screen">
        <div class="profile-hero">
          <img src="${person.image}" alt="${person.name}的虚构演示照片" />
          <button class="icon-button back-floating" type="button" data-action="goto-scene" data-scene="1" aria-label="返回发现">${icon("chevron-left")}</button>
          <div class="profile-overlay"><h2>${person.name}</h2><p>${person.age}岁 · ${person.city} · ${person.field}</p></div>
        </div>
        <div class="phone-content">
          <div class="profile-body">
            <div class="profile-actions">
              <button type="button" class="circle-action ${liked ? "active" : ""}" data-action="toggle-like" aria-label="喜欢" title="喜欢">${icon("heart")}</button>
              <button type="button" class="circle-action ${followed ? "active" : ""}" data-action="toggle-follow" aria-label="关注" title="关注">${icon("bookmark")}</button>
              <button type="button" class="primary-button hotspot" data-action="try-message">${icon("message-circle")}发起话题</button>
            </div>
            <div class="disclosure-box"><strong>资料与话题说明</strong><br />该资料经平台审核，由 MeiGallery 依据授权素材创建和维护。你发起的话题由平台管理员接收与处理，并不代表真人本人在线或亲自回复。</div>
            <h3 class="section-title">关于 ${person.name}</h3>
            <p class="profile-bio">${person.bio}</p>
            <h3 class="section-title">内容标签</h3>
            <div class="tag-wrap">${person.tags.map(tag => `<span class="tag">${tag}</span>`).join("")}</div>
          </div>
        </div>
        ${phoneTabs("推荐")}
      </div>
    </div>`;
  }

  function renderMembership() {
    const selected = levels.find(level => level.id === state.selectedLevel) || levels[0];
    const request = state.membershipRequest;
    return `<div class="phone-shell">
      <div class="phone-screen">
        ${phoneStatus()}
        <div class="phone-toolbar"><button class="icon-button" type="button" data-action="goto-scene" data-scene="2" aria-label="返回详情">${icon("chevron-left")}</button><strong>会员权益</strong><span style="width:38px"></span></div>
        <div class="phone-content">
          <div class="gate-content">
            <div class="gate-visual">${icon("crown")}</div>
            <h2 class="gate-title">平台话题需要有效会员</h2>
            <p class="gate-subtitle">选择等级查看精确权益。App 1.0 不在线支付，提交申请后由平台人工处理。</p>
            <div class="membership-list">${levels.map(level => `<button type="button" class="member-card ${state.selectedLevel === level.id ? "selected" : ""}" data-action="select-level" data-level="${level.id}"><span class="level-icon">${level.initial}</span><span><strong>${level.name}</strong><p>每日 ${level.topics} 个新话题 · 保存 ${level.filters} 个筛选</p></span><small>收藏夹 ${level.folders}</small></button>`).join("")}</div>
            <article class="membership-rights">
              <div><span>${selected.name}权益</span><strong>rank ${selected.rank}</strong></div>
              <p>${icon("message-circle")}每日新话题 <b>${selected.topics}</b> 个</p>
              <p>${icon("filter")}保存筛选 <b>${selected.filters}</b> 个 · 收藏夹 <b>${selected.folders}</b> 个</p>
              <p>${icon("circle-check")}高级筛选：<b>${selected.advanced}</b></p>
            </article>
            ${request ? `<button type="button" class="membership-request-card" data-action="view-membership-request"><span class="request-state">${request.status}</span><strong>${request.levelName}会员申请</strong><small>申请编号 ${request.id} · ${request.submittedAt}</small><em>查看处理进度 ${icon("chevron-right")}</em></button>` : ""}
            <div class="gate-note">申请由平台人工处理，当前不承诺固定处理时效或必然通过。提交申请不代表已获得会员，平台话题不保证固定回复时间。</div>
            <button type="button" class="primary-button hotspot" data-action="${state.member ? "open-chat" : request ? "view-membership-request" : "request-membership"}">${state.member ? icon("circle-check") + `${state.memberLevel}已生效，进入话题` : request ? icon("history") + "查看会员申请" : icon("shield-check") + "提交会员申请"}</button>
          </div>
        </div>
      </div>
    </div>`;
  }

  function renderChat() {
    const person = state.selectedPerson;
    const cannotSend = !state.member || state.chatReadonly;
    return `<div class="phone-shell">
      <div class="phone-screen chat-screen">
        ${phoneStatus()}
        <div class="chat-head">
          ${icon("chevron-left")}
          <img class="chat-avatar" src="${person.image}" alt="" />
          <div class="chat-head-copy"><strong>${person.name} · 话题会话</strong><span>由平台运营团队处理中</span></div>
          <span class="platform-badge">平台接收</span>
        </div>
        <div class="chat-disclosure">本会话由 MeiGallery 平台管理员接收和处理，不代表 ${person.name} 本人在线或亲自回复。</div>
        <div class="chat-thread" id="chat-thread">
          <div class="chat-date">今天 15:30</div>
          ${state.chatMessages.map(message => message.mine ? `
            <div class="message-row mine"><div class="bubble">${escapeHtml(message.text)}<small>${message.status}</small></div></div>` : `
            <div class="message-row"><img class="chat-avatar" src="${person.image}" alt="" /><div class="bubble"><div class="message-author"><strong>${message.author}</strong></div>${escapeHtml(message.text)}<small>${message.status}</small></div></div>`).join("")}
          ${state.chatReadonly ? `<div class="system-message">会员已到期，会话已转为只读</div>` : ""}
        </div>
        ${cannotSend ? `<div class="chat-composer readonly">${icon("lock")} ${state.chatReadonly ? "会员到期，重新获得会员后可继续发送" : "有效心享会员才能发送平台话题消息"}</div>` : `<form class="chat-composer" id="chat-form"><input id="chat-input" value="${escapeHtml(state.chatDraft)}" aria-label="输入消息" placeholder="输入平台话题消息" /><button class="icon-button hotspot" type="submit" aria-label="发送" title="发送">${icon("send")}</button></form>`}
      </div>
    </div>`;
  }

  function renderWallet() {
    const isCoins = state.walletTab === "金币";
    return `<div class="phone-shell">
      <div class="phone-screen">
        ${phoneStatus()}
        <div class="phone-header"><h2>我的</h2><p>账号、通知与资产记录</p></div>
        <div class="tab-row"><button type="button" class="tab-button ${!isCoins ? "active" : ""}" data-action="wallet-notices">通知</button><button type="button" class="tab-button ${isCoins ? "active" : ""}" data-action="wallet-coins">金币明细</button></div>
        <div class="phone-content">
          ${isCoins ? renderCoinWallet() : renderNotices()}
        </div>
        ${phoneTabs("我的")}
      </div>
    </div>`;
  }

  function renderNotices() {
    return `<div class="notice-list">
      <button class="notice-item" type="button" data-action="goto-scene" data-scene="4"><span class="notice-icon">${icon("message-circle")}</span><span class="notice-copy"><strong>平台运营回复了你的会话</strong><p>关于林夏的城市生活内容，运营专员已经处理。</p><small>5 分钟前</small></span><span class="unread-dot"></span></button>
      <button class="notice-item" type="button" data-action="wallet-coins"><span class="notice-icon">${icon("coin")}</span><span class="notice-copy"><strong>金币余额发生变动</strong><p>管理员调整 +120，原因：活动补发。</p><small>昨天 18:32</small></span></button>
      <button class="notice-item" type="button" data-action="goto-scene" data-scene="3"><span class="notice-icon">${icon("crown")}</span><span class="notice-copy"><strong>${state.member ? `${state.memberLevel}会员已生效` : state.membershipRequest ? `会员申请${state.membershipRequest.status}` : "会员权益提醒"}</strong><p>${state.member ? `有效期至 ${state.memberExpiry}` : state.membershipRequest ? `申请编号 ${state.membershipRequest.id}` : "有效会员可发起由平台接收的话题。"}</p><small>2026-07-23</small></span></button>
    </div>`;
  }

  function renderCoinWallet() {
    return `<div class="wallet-hero"><div class="row-between"><div><span>当前金币</span><strong>${state.walletBalance}</strong><small>平台内部记录值，不具现金价值</small></div>${icon("wallet")}</div></div>
      <div class="gate-note wallet-disclaimer">App 1.0 仅展示余额和明细，不支持购买、充值、消费、兑换、转账或提现。</div>
      <div class="coin-list">
        <div class="coin-row"><div><strong>活动补发</strong><p>业务单号 COIN-20260720-018 · 管理员调整</p></div><span class="coin-amount plus">+120</span></div>
        <div class="coin-row"><div><strong>异常数据冲正</strong><p>业务单号 COIN-20260718-009 · 审批通过</p></div><span class="coin-amount">-30</span></div>
        <div class="coin-row"><div><strong>初始账户发放</strong><p>业务单号 COIN-20260701-001 · 系统建账</p></div><span class="coin-amount plus">+430</span></div>
      </div>`;
  }

  function adminShell(active, title, subtitle, body) {
    const nav = [
      ["工作台", "home"], ["真人内容", "users"], ["平台话题", "message-circle"], ["会员管理", "crown"], ["金币账本", "coin"], ["审计日志", "history"]
    ];
    return `<div class="admin-shell">
      <aside class="admin-sidebar"><div class="admin-brand"><span class="brand-mark">M</span>MeiGallery</div><nav class="admin-nav">${nav.map(([label, glyph]) => `<button type="button" class="${active === label ? "active" : ""}">${icon(glyph)}${label}</button>`).join("")}</nav></aside>
      <section class="admin-main"><header class="admin-topbar"><div><strong>${title}</strong><small>${subtitle}</small></div><div class="admin-user"><span>管</span>内容管理员</div></header><div class="admin-content">${body}</div></section>
    </div>`;
  }

  function renderAdminReview() {
    const p = state.reviewPerson;
    const allChecks = Object.values(state.reviewChecks).every(Boolean);
    const body = `<div class="metric-grid">
      <div class="metric-card"><div class="metric-label"><span>待审核资料</span>${icon("history")}</div><strong>12</strong><small>今日新增 4</small></div>
      <div class="metric-card"><div class="metric-label"><span>已认证发布</span>${icon("shield-check")}</div><strong>86</strong><small>本周 +7</small></div>
      <div class="metric-card"><div class="metric-label"><span>授权待补充</span>${icon("alert-circle")}</div><strong>3</strong><small style="color:var(--warning)">需要处理</small></div>
      <div class="metric-card"><div class="metric-label"><span>今日审计事件</span>${icon("history")}</div><strong>28</strong><small>全部已记录</small></div>
    </div>
    <div class="admin-grid">
      <section class="admin-panel"><div class="panel-title"><strong>真人资料审核队列</strong><span>按提交时间排序</span></div><div class="review-list">${people.map(person => `<button class="review-item ${person.id === p.id ? "active" : ""}" type="button" data-action="select-review" data-person="${person.id}"><img src="${person.image}" alt="" /><span><strong>${person.name}</strong><p>${person.city} · ${person.field}</p></span><span class="admin-state ${state.reviewStatus === "已发布" && person.id === p.id ? "success" : ""}">${person.id === p.id ? state.reviewStatus : "待审核"}</span></button>`).join("")}</div></section>
      <section class="admin-panel"><div class="panel-title"><strong>认证与发布检查</strong><span>候选编号 MG-P-1048</span></div><div class="review-detail"><div class="candidate-head"><img src="${p.image}" alt="" /><div><h3>${p.name}</h3><p>${p.age} 岁 · ${p.city} · ${p.field}</p><p>资料来源：管理员上传 · 授权批次 AUTH-2407</p></div></div><div class="checklist">
        <div class="check-line">${icon("circle-check")}素材授权文件完整</div>
        <div class="check-line">${icon("circle-check")}成年声明与内容边界通过</div>
        <button type="button" class="check-line ${state.reviewChecks.identity ? "" : "pending hotspot"}" style="border:0;text-align:left;cursor:pointer" data-action="complete-review">${icon(state.reviewChecks.identity ? "circle-check" : "alert-circle")}身份资料交叉核验${state.reviewChecks.identity ? "已完成" : "待完成"}</button>
      </div><div class="approval-actions"><button type="button" class="secondary-button" data-action="return-person">退回补充</button><button type="button" class="primary-button ${allChecks ? "hotspot" : ""}" data-action="approve-person" ${allChecks ? "" : "disabled"}>审核通过并发布</button></div></div></section>
    </div>`;
    return adminShell("真人内容", "真人内容审核", "只有认证通过的资料可发布到 App", body);
  }

  function renderOperations() {
    const body = `<div class="operations-grid">
      <section class="admin-panel"><div class="panel-title"><strong>${state.operationTab === "会员" ? "会员申请队列" : "待处理队列"}</strong><span>${state.operationTab === "会员" ? "人工审核" : "平台统一接收"}</span></div><div class="queue-list">${renderOperationQueue()}</div></section>
      <section class="admin-panel"><div class="operation-tabs">${["消息", "会员", "金币"].map(tab => `<button type="button" class="${state.operationTab === tab ? "active" : ""}" data-action="set-operation" data-tab="${tab}">${tab === "消息" ? "平台话题" : tab === "会员" ? "申请与发放" : "金币调整"}</button>`).join("")}</div><div class="operation-body">${renderOperationBody()}</div></section>
    </div>`;
    return adminShell(state.operationTab === "消息" ? "平台话题" : state.operationTab === "会员" ? "会员管理" : "金币账本", "运营与会员工作台", "所有操作记录操作者、原因、时间和业务单号", body);
  }

  function renderOperationQueue() {
    if (state.operationTab === "会员") {
      const request = state.membershipRequest;
      return request
        ? `<button type="button" class="queue-item active" data-action="operation-member"><span class="queue-person"><span class="queue-letter">用</span><span><strong>138 0013 8000 · ${request.levelName}</strong><small>${request.id} · ${request.status}</small></span></span><span class="queue-count">1</span></button>`
        : `<div class="queue-empty"><strong>暂无用户申请</strong><p>管理员仍可按授权规则直接发放，但必须填写来源和原因。</p></div>`;
    }
    return people.slice(0, 3).map((person, index) => `<button type="button" class="queue-item ${index === 0 ? "active" : ""}" data-action="operation-message"><span class="queue-person"><img src="${person.image}" alt="" /><span><strong>${person.name} · 话题会话</strong><small>${index === 0 ? "用户询问近期内容" : "等待运营处理"}</small></span></span><span class="queue-count">${index + 1}</span></button>`).join("");
  }

  function renderOperationBody() {
    if (state.operationTab === "会员") {
      const request = state.membershipRequest;
      const requestedLevel = request ? request.levelName : state.memberLevel;
      const grantedLevel = levels.find(level => level.name === state.memberLevel) || levels[0];
      if (state.member && request && request.status === "已发放") {
        return `<div class="operation-success">${icon("circle-check")}<span>申请与 grant 已完成</span></div><h3>${state.memberLevel}会员已生效</h3><p>申请 ${request.id} 已完成审核，会员 grant 已写入，用户 entitlement 将以服务端权威快照为准。</p><div class="application-summary"><span>已发放</span><strong>${state.memberLevel}会员</strong><p>每日 ${grantedLevel.topics} 个新话题 · 保存筛选 ${grantedLevel.filters} 个 · 收藏夹 ${grantedLevel.folders} 个</p><small>有效期至 ${escapeHtml(state.memberExpiry)} · 申请、发放与审计记录已关联</small></div><div class="audit-note">再次发放、续期、替换或撤销必须创建新的业务操作，不允许重复提交原申请或覆盖历史 grant。</div><div class="form-actions"><button class="primary-button hotspot" type="button" data-action="goto-scene" data-scene="4">查看用户平台话题权限</button></div>`;
      }
      return `<h3>${request ? "审核会员申请并发放" : "管理员直接发放会员"}</h3><p>${request ? `申请 ${request.id} 已由用户提交，先记录处理结论，再创建会员 grant。` : "没有用户申请时可直接发放，但必须填写来源、业务单号和原因。"}</p>${request ? `<div class="application-summary"><span>${request.status}</span><strong>${request.levelName}会员申请</strong><p>${escapeHtml(request.note || "用户未填写申请说明")}</p><small>${request.submittedAt} · 人工处理 · 不承诺固定时效</small></div>` : ""}<form class="admin-form" id="member-form"><label>用户账号<input value="viewer@example.com · 已验证邮箱" readonly /></label><label>会员等级<select id="admin-member-level">${levels.map(level => `<option ${level.name === requestedLevel ? "selected" : ""}>${level.name}</option>`).join("")}</select></label><label>有效期至<input id="member-expiry" value="2026-08-20 23:59" /></label><label>申请来源<input value="${request ? `用户申请 ${request.id}` : "管理员直接发放"}" readonly /></label><label>发放原因<textarea>${request ? "会员申请审核通过，人工资格确认完成" : "线下资格确认，授权管理员直接发放"}</textarea></label><div class="audit-note">提交后才影响平台话题权限，并自动写入申请处理、会员变更与后台审计记录。</div><div class="form-actions"><button class="primary-button hotspot" type="submit">${request ? "批准申请并发放会员" : "确认发放会员"}</button></div></form>`;
    }
    if (state.operationTab === "金币") {
      const pending = state.coinRequest && state.coinRequest.status === "待审批";
      const approved = state.coinRequest && state.coinRequest.status === "已通过";
      const delta = state.coinRequest ? state.coinRequest.delta : 100;
      return `<h3>金币调整与审批</h3><p>余额不允许直接编辑。先创建调整申请，再由不同权限角色审批入账。</p><form class="admin-form" id="coin-form"><label>用户账号<input value="138 0013 8000 · 当前余额 ${state.walletBalance}" readonly /></label><label>调整方向<select id="coin-direction"><option>加币</option><option>扣币</option></select></label><label>调整数量<input id="coin-amount" inputmode="numeric" value="100" /></label><label>调整原因<textarea id="coin-reason">客户活动补发，业务核对完成</textarea></label><div class="balance-preview"><span>调整前<strong>${approved ? state.walletBalance - delta : state.walletBalance}</strong></span>${icon("arrow-right")}<span>预计调整后<strong>${approved ? state.walletBalance : state.walletBalance + delta}</strong></span></div><div class="audit-note">申请人和审批人必须分离。流水写入后不可修改或删除，只能通过新的冲正流水纠正。</div><div class="form-actions">${pending ? `<button class="secondary-button" type="button" disabled>申请 ${state.coinRequest.id} 待审批</button><button class="primary-button hotspot" type="button" data-action="coin-approve">切换审批人并通过</button>` : approved ? `<button class="primary-button" type="button" disabled>${icon("circle-check")}已审批入账</button>` : `<button class="primary-button hotspot" type="submit">创建调整申请</button>`}</div></form>`;
    }
    return `<h3>平台话题回复</h3><p>用户看到的接收与回复主体始终是 MeiGallery 平台运营团队。</p><div class="candidate-head"><img src="${state.selectedPerson.image}" alt="" /><div><h3>${state.selectedPerson.name} · 话题会话</h3><p>观看者：138 0013 8000</p><p>当前状态：等待平台运营处理</p></div></div><div class="chat-disclosure" style="margin:13px 0;border-radius:8px">前台固定披露：本会话由平台管理员接收和处理。</div><form class="admin-form" id="operator-form"><label>发送主体<input value="MeiGallery 平台运营专员（固定，不可修改）" readonly /></label><label>回复内容<textarea id="operator-text">已收到你的留言，我们会整理近期公开内容并通过平台回复。</textarea></label><div class="audit-note">可回答公开资料、内容更新和平台规则；不得代表真人描述私人经历、情感、行程或关系意愿。</div><div class="form-actions"><button class="primary-button hotspot" type="submit">以平台运营身份发送</button></div></form>`;
  }

  function renderInspector() {
    const scene = scenes[state.scene];
    els.inspectorContent.innerHTML = `<h2>${scene.title}</h2><p class="inspector-lead">${scene.lead}</p><section class="rule-card"><h3>不可变业务规则</h3><p>${scene.rule}</p></section><section class="interaction-card"><h3>建议操作</h3><div class="interaction-list">${scene.actions.map((item, index) => `<button type="button" class="action-tile" data-action="${item.action}"><span>${index + 1}</span><span>${item.label}</span>${icon("chevron-right")}</button>`).join("")}</div></section><section class="expected-card"><h3>预期结果</h3><p>${scene.expected}</p></section><p class="inspector-footnote">这是需求确认用交互原型。内容、账号、余额和状态均为本地演示数据，不会提交到生产系统。</p>`;
  }

  function renderNav() {
    els.nav.innerHTML = scenes.map((scene, index) => `<button type="button" class="scene-item ${state.scene === index ? "active" : ""}" data-action="goto-scene" data-scene="${index}"><span class="scene-index">${String(index + 1).padStart(2, "0")}</span><span class="scene-copy"><strong>${scene.title}</strong><small>${scene.short}</small></span></button>`).join("");
  }

  function render() {
    const scene = scenes[state.scene];
    els.title.textContent = scene.title;
    els.kicker.textContent = scene.kicker;
    els.state.textContent = scene.state();
    els.progressText.textContent = `${String(state.scene + 1).padStart(2, "0")} / 08`;
    els.progressBar.style.width = `${((state.scene + 1) / scenes.length) * 100}%`;
    els.stage.style.animation = "none";
    void els.stage.offsetWidth;
    els.stage.style.animation = "sceneEnter 430ms var(--ease) both";
    els.stage.innerHTML = params.get("dual") === "member" && state.scene === 2
      ? `<div class="comparison-stage">${renderProfile()}${renderMembership()}</div>`
      : scene.render();
    renderNav();
    renderInspector();
    history.replaceState(null, "", `${location.pathname}?scene=${state.scene}${params.get("capture") ? "&capture=1" : ""}`);
    requestAnimationFrame(() => {
      const thread = document.getElementById("chat-thread");
      if (thread) thread.scrollTop = thread.scrollHeight;
    });
  }

  function showToast(message) {
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = message;
    els.toast.appendChild(toast);
    window.setTimeout(() => toast.remove(), 2400);
  }

  function goToScene(index) {
    state.scene = Math.min(scenes.length - 1, Math.max(0, Number(index)));
    els.sidebar.classList.remove("open");
    els.inspector.classList.remove("open");
    render();
  }

  function showFilter() {
    els.modal.hidden = false;
    els.modal.innerHTML = `<div class="modal-card" style="max-width:520px;margin-top:8vh"><div class="modal-head"><h2>筛选推荐内容</h2><button type="button" class="icon-button" data-action="close-modal" aria-label="关闭">${icon("x")}</button></div><div class="overview-body"><div class="admin-form"><label>地区范围<select id="filter-city"><option>全部地区</option><option>杭州</option><option>上海</option><option>南京</option><option>成都</option></select></label><label>偏好标签<div class="tag-wrap"><button class="tag" type="button">生活方式</button><button class="tag" type="button">艺术</button><button class="tag" type="button">设计</button><button class="tag" type="button">阅读</button></div></label><div class="disclosure-box">推荐依据为地区、内容热度和用户偏好，不使用精确距离，也不代表真人在线或会回复。</div><button type="button" class="primary-button" data-action="apply-filter">应用筛选</button></div></div></div>`;
  }

  function showMembershipRequest() {
    const level = levels.find(item => item.id === state.selectedLevel) || levels[0];
    els.modal.hidden = false;
    els.modal.innerHTML = `<div class="modal-card request-modal" style="max-width:560px;margin-top:5vh"><div class="modal-head"><div><small>心享会员 · 人工处理</small><h2>提交${level.name}会员申请</h2></div><button type="button" class="icon-button" data-action="close-modal" aria-label="关闭">${icon("x")}</button></div><form class="overview-body admin-form" id="membership-request-form"><div class="application-summary"><span>申请等级</span><strong>${level.name} · 每日 ${level.topics} 个新话题</strong><p>保存筛选 ${level.filters} 个 · 收藏夹 ${level.folders} 个 · 高级筛选${level.advanced}</p></div><label>已验证登录邮箱<input value="viewer@example.com" readonly /></label><label>联系时段偏好<select><option>时间不限</option><option>上午</option><option>下午</option><option>晚间</option></select></label><label>申请说明（选填，最多 300 字）<textarea id="membership-note" maxlength="300" placeholder="可说明希望使用的平台功能">希望围绕感兴趣的真人资料发起内容话题。</textarea></label><label class="check-row"><input id="membership-confirm" type="checkbox" required />我已了解 App 1.0 不在线支付，申请由平台人工处理，管理员发放后权益才生效。</label><div class="disclosure-box"><strong>处理与服务说明</strong><br />当前不承诺固定处理时效或必然通过。平台话题由平台运营接收，不保证固定回复时间或本人回复。</div><div class="form-actions"><button type="button" class="secondary-button" data-action="close-modal">暂不申请</button><button type="submit" class="primary-button hotspot">确认提交申请</button></div></form></div>`;
  }

  function showMembershipRequestStatus() {
    const request = state.membershipRequest;
    if (!request) return showMembershipRequest();
    els.modal.hidden = false;
    els.modal.innerHTML = `<div class="modal-card request-modal" style="max-width:540px;margin-top:8vh"><div class="modal-head"><div><small>申请编号 ${request.id}</small><h2>会员申请${request.status}</h2></div><button type="button" class="icon-button" data-action="close-modal" aria-label="关闭">${icon("x")}</button></div><div class="overview-body"><div class="request-progress"><span class="done">${icon("circle-check")}已提交</span><i></i><span class="${request.status === "已提交" ? "current" : "done"}">${icon(request.status === "已提交" ? "history" : "circle-check")}平台处理</span><i></i><span class="${request.status === "已通过" ? "done" : ""}">${icon(request.status === "已通过" ? "circle-check" : "crown")}管理员发放</span></div><article class="application-summary"><span>${request.status}</span><strong>${request.levelName}会员申请</strong><p>${escapeHtml(request.note || "未填写申请说明")}</p><small>提交于 ${request.submittedAt}</small></article><div class="disclosure-box">提交申请不会直接获得话题权限。管理员发放成功后，App 会展示会员等级、有效期和可用额度。</div><button type="button" class="primary-button" data-action="close-modal">知道了</button></div></div>`;
  }

  function showOverview() {
    els.modal.hidden = false;
    els.modal.innerHTML = `<div class="modal-card"><div class="modal-head"><h2>App 1.0 端到端业务总览</h2><button type="button" class="icon-button" data-action="close-modal" aria-label="关闭">${icon("x")}</button></div><div class="overview-body"><p class="overview-lead">从真人资料进入平台，到观看者浏览并发起平台话题，再到会员申请、管理员运营和内控，所有关键节点都由明确状态、服务端权限和审计记录连接。</p><div class="overview-flow">${[
      ["内容供给", "管理员创建或导入授权真人素材"], ["认证发布", "成年、授权、身份与内容边界审核"], ["发现浏览", "观看者按地区、热度和偏好筛选"], ["建立关系", "喜欢、关注、收藏不触发匹配"],
      ["会员申请", "选择等级并提交站内申请"], ["管理员发放", "审核通过后 grant 才使权益生效"], ["平台话题", "消息由管理员接收并以平台身份回复"], ["账本内控", "金币申请、独立审批、流水与审计"]
    ].map((step, i) => `<article class="flow-step"><span>${String(i + 1).padStart(2, "0")}</span><h3>${step[0]}</h3><p>${step[1]}</p></article>`).join("")}</div><div class="overview-boundaries"><article class="boundary-card"><strong>身份边界</strong><p>注册用户只是观看者；公开真人必须由管理员创建或认证发布。</p></article><article class="boundary-card"><strong>沟通边界</strong><p>有效心享会员是发送门槛，接收与回复主体始终为平台运营，不暗示本人。</p></article><article class="boundary-card"><strong>商业边界</strong><p>1.0 不含支付、充值、礼物与装扮购买；金币不具现金价值且仅由管理员调整。</p></article></div></div></div>`;
  }

  function handleAction(action, target) {
    switch (action) {
      case "previous": goToScene(state.scene - 1); break;
      case "next": goToScene(state.scene + 1); break;
      case "goto-scene": goToScene(target.dataset.scene); break;
      case "login":
        state.loggedIn = true;
        showToast("登录成功，已进入发现页");
        goToScene(1);
        break;
      case "set-category":
        state.category = target.dataset.category;
        render();
        showToast(`已切换到“${state.category}”推荐`);
        break;
      case "category-hot":
        state.category = "热度";
        if (state.scene !== 1) state.scene = 1;
        render();
        showToast("已按内容热度重新排序");
        break;
      case "open-filter": showFilter(); break;
      case "apply-filter":
        state.filterCity = document.getElementById("filter-city").value;
        els.modal.hidden = true;
        render();
        showToast(`已应用筛选：${state.filterCity}`);
        break;
      case "close-modal": els.modal.hidden = true; break;
      case "show-overview": showOverview(); break;
      case "open-person":
        state.selectedPerson = people.find(p => p.id === target.dataset.person) || people[0];
        goToScene(2);
        break;
      case "open-profile": state.selectedPerson = people[0]; goToScene(2); break;
      case "toggle-like":
        toggleSet(state.liked, state.selectedPerson.id);
        render();
        showToast(state.liked.has(state.selectedPerson.id) ? "已加入喜欢" : "已取消喜欢");
        break;
      case "toggle-follow":
        toggleSet(state.followed, state.selectedPerson.id);
        render();
        showToast(state.followed.has(state.selectedPerson.id) ? "已关注，更新会出现在关注页" : "已取消关注");
        break;
      case "try-message": state.member && !state.chatReadonly ? goToScene(4) : goToScene(3); break;
      case "select-level":
        state.selectedLevel = target.dataset.level;
        render();
        break;
      case "select-xinzhi": state.selectedLevel = "xinzhi"; if (state.scene !== 3) state.scene = 3; render(); break;
      case "request-membership": showMembershipRequest(); break;
      case "view-membership-request": showMembershipRequestStatus(); break;
      case "prototype-grant": {
        if (!state.membershipRequest) {
          showToast("请先提交会员申请，再进入管理员审核流程");
          showMembershipRequest();
          break;
        }
        state.membershipRequest.status = "处理中";
        state.operationTab = "会员";
        goToScene(7);
        showToast("已进入管理员会员申请队列");
        break;
      }
      case "open-chat": state.member ? goToScene(4) : (showToast("会员尚未生效，请先提交申请并等待管理员发放"), goToScene(3)); break;
      case "send-demo-message":
        if (!state.member || state.chatReadonly) { showToast("当前无发送权限"); break; }
        state.chatMessages.push({ mine: true, text: "希望平台后续可以更新更多展览和城市生活内容。", status: "已送达平台" });
        if (state.scene !== 4) state.scene = 4;
        render();
        showToast("消息已送达平台运营队列");
        break;
      case "operator-reply":
        state.chatMessages.push({ mine: false, author: "平台运营专员", text: "已收到你的留言，我们会整理相关公开内容并通过平台继续回复。", status: "平台回复" });
        if (state.scene !== 4) state.scene = 4;
        render();
        showToast("已模拟平台运营回复");
        break;
      case "toggle-readonly":
        state.chatReadonly = !state.chatReadonly;
        if (state.chatReadonly) state.member = false;
        else state.member = true;
        if (state.scene !== 4) state.scene = 4;
        render();
        showToast(state.chatReadonly ? "会员已到期，会话转为只读" : "会员权限已恢复");
        break;
      case "wallet-coins": state.walletTab = "金币"; if (state.scene !== 5) state.scene = 5; render(); break;
      case "wallet-notices": state.walletTab = "通知"; if (state.scene !== 5) state.scene = 5; render(); break;
      case "goto-coins": state.operationTab = "金币"; goToScene(7); break;
      case "select-review":
        state.reviewPerson = people.find(p => p.id === target.dataset.person) || people[0];
        state.reviewStatus = "待审核";
        state.reviewChecks.identity = false;
        render();
        break;
      case "complete-review":
        state.reviewChecks.identity = true;
        render();
        showToast("身份资料交叉核验已完成");
        break;
      case "approve-person":
        if (!Object.values(state.reviewChecks).every(Boolean)) { showToast("请先完成全部认证检查"); break; }
        state.reviewStatus = "已发布";
        render();
        showToast("资料已发布，审计事件 MG-AUD-1056 已生成");
        break;
      case "return-person":
        state.reviewStatus = "已退回";
        render();
        showToast("资料已退回，原因已写入审核记录");
        break;
      case "set-operation": state.operationTab = target.dataset.tab; render(); break;
      case "operation-message": state.operationTab = "消息"; if (state.scene !== 7) state.scene = 7; render(); break;
      case "operation-member": state.operationTab = "会员"; if (state.scene !== 7) state.scene = 7; render(); break;
      case "operation-coin": state.operationTab = "金币"; if (state.scene !== 7) state.scene = 7; render(); break;
      case "coin-approve":
        if (!state.coinRequest) { state.operationTab = "金币"; state.scene = 7; render(); showToast("请先创建金币调整申请"); break; }
        if (state.coinRequest.status === "待审批") {
          state.coinRequest.status = "已通过";
          state.walletBalance += state.coinRequest.delta;
          render();
          showToast(`审批通过，余额已调整为 ${state.walletBalance}`);
        } else showToast("当前没有待审批申请");
        break;
      case "toggle-scenes": els.sidebar.classList.toggle("open"); break;
      case "toggle-inspector": els.inspector.classList.toggle("open"); break;
      case "reset":
        location.href = `${location.pathname}?scene=0`;
        break;
      default: break;
    }
  }

  function toggleSet(set, value) {
    if (set.has(value)) set.delete(value);
    else set.add(value);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
  }

  document.addEventListener("click", event => {
    const target = event.target.closest("[data-action]");
    if (target) handleAction(target.dataset.action, target);
  });

  document.addEventListener("submit", event => {
    event.preventDefault();
    if (event.target.id === "membership-request-form") {
      const level = levels.find(item => item.id === state.selectedLevel) || levels[0];
      state.membershipRequest = {
        id: `MBR-${Date.now().toString().slice(-6)}`,
        levelId: level.id,
        levelName: level.name,
        note: document.getElementById("membership-note").value.trim(),
        status: "已提交",
        submittedAt: "2026-07-23 14:30"
      };
      els.modal.hidden = true;
      render();
      showToast("会员申请已提交，平台将在服务时段内处理");
    }
    if (event.target.id === "chat-form") {
      if (!state.member || state.chatReadonly) return showToast("当前无发送权限");
      const input = document.getElementById("chat-input");
      if (!input.value.trim()) return;
      state.chatMessages.push({ mine: true, text: input.value.trim(), status: "已送达平台" });
      state.chatDraft = "";
      render();
      showToast("消息已送达平台运营队列");
    }
    if (event.target.id === "operator-form") {
      const value = document.getElementById("operator-text").value.trim();
      if (!value) return showToast("请输入平台回复内容");
      state.chatMessages.push({ mine: false, author: "平台运营专员", text: value, status: "平台回复" });
      render();
      showToast("已以平台运营身份发送，前台披露保持不变");
    }
    if (event.target.id === "member-form") {
      state.member = true;
      state.chatReadonly = false;
      state.memberLevel = document.getElementById("admin-member-level").value;
      state.memberExpiry = document.getElementById("member-expiry").value;
      if (state.membershipRequest) state.membershipRequest.status = "已发放";
      render();
      showToast(`${state.memberLevel}会员已发放并生效，申请与审计记录已更新`);
    }
    if (event.target.id === "coin-form") {
      const direction = document.getElementById("coin-direction").value;
      const amount = Math.max(1, Number(document.getElementById("coin-amount").value) || 0);
      state.coinRequest = { id: `COIN-${Date.now().toString().slice(-6)}`, delta: direction === "加币" ? amount : -amount, status: "待审批" };
      render();
      showToast("调整申请已创建，等待独立审批人处理");
    }
  });

  document.addEventListener("keydown", event => {
    if (!els.modal.hidden && event.key === "Escape") { els.modal.hidden = true; return; }
    const tag = document.activeElement && document.activeElement.tagName;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;
    if (event.key === "ArrowLeft") goToScene(state.scene - 1);
    if (event.key === "ArrowRight") goToScene(state.scene + 1);
  });

  document.querySelector(".stage-heading").addEventListener("click", event => {
    if (window.innerWidth <= 1050 && event.target.closest(".stage-heading")) els.inspector.classList.add("open");
  });

  render();
  if (params.get("overview") === "1") showOverview();
})();
