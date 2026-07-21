(() => {
  "use strict";

  const CATEGORY_ORDER = ["AS", "BG", "HS", "IG", "OS", "PS", "ST", "SE", "KEY"];
  const CATEGORY_NAMES = {
    AS: "Atmospheric Sciences",
    BG: "Biogeosciences",
    HS: "Hydrological Sciences",
    IG: "Interdisciplinary Geosciences",
    OS: "Ocean Sciences",
    PS: "Planetary Sciences",
    ST: "Solar-Terrestrial Sciences",
    SE: "Solid Earth Sciences",
    KEY: "Key & Special"
  };
  const PROGRAM_TYPE_NAMES = {
    AL: "Axford Lecture",
    DL: "Distinguished Lecture",
    KL: "Kamide Lecture",
    SL: "Special Lecture",
    ML: "Medal Lecture",
    SS: "Special Session",
    KEY: "Key & Special"
  };
  const BATCH_SIZE = 20;

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const esc = (value) =>
    String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[character]);
  const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();

  const state = {
    view: "guide",
    scope: "sessions",
    query: "",
    categories: [],
    type: "",
    date: "",
    time: "",
    location: "",
    topic: "",
    visibleCount: BATCH_SIZE,
    timetableDate: ""
  };

  let catalog = null;
  let groups = [];
  let currentMatches = [];
  let renderToken = 0;
  let searchTimer = null;
  let lastDetailFocus = null;
  let lastHelpFocus = null;
  let lastFilterFocus = null;
  let currentDetailGroup = null;
  let toastTimer = null;
  const presentationPromises = new Map();
  const presentationsByCategory = new Map();
  const presentationsById = new Map();
  const groupByKey = new Map();
  const timetableTargets = new Map();
  const timeOptionLabels = new Map();

  const categoryOf = (row) => row.category || String(row.session_code || "").slice(0, 2);
  const groupKeyOf = (row) => `${categoryOf(row)}|${row.session_code}`;
  const presentationTypeOf = (row) =>
    categoryOf(row) === "KEY"
      ? row.program_code || row.presentation_type
      : row.presentation_type || row.program_code;
  const scheduleTypeOf = (row, category) =>
    category === "KEY" ? row.program_code || row.session_type : row.session_type || row.program_code;
  const categoryName = (category) => CATEGORY_NAMES[category] || category;
  const categoryClass = (category) => `category-${String(category || "").toLowerCase()}`;
  const venueGroup = (venue) => {
    const value = String(venue || "").trim().toUpperCase();
    if (value.startsWith("FICC")) return "FICC";
    if (value.startsWith("HALL")) return "Hall";
    return "";
  };
  const typeClass = (type) => type === "Oral" ? "oral" : type === "Poster" ? "poster" : "special";
  const typeLabel = (type) => PROGRAM_TYPE_NAMES[type] ? `${type} · ${PROGRAM_TYPE_NAMES[type]}` : type;
  const dayLabel = (date) => catalog?.meta.day_labels?.[date] || date;

  function setHidden(element, hidden) {
    element.classList.toggle("hidden", hidden);
  }

  function showToast(message) {
    const toast = $("#toast");
    toast.textContent = message;
    setHidden(toast, false);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => setHidden(toast, true), 2200);
  }

  function updateBodyLock() {
    const modalOpen = ["#filter-sheet", "#detail-drawer", "#help-dialog"]
      .some((selector) => !$(selector).classList.contains("hidden"));
    document.body.classList.toggle("modal-open", modalOpen);
  }

  function visibleDialog() {
    return [$("#detail-drawer"), $("#filter-sheet"), $("#help-dialog")]
      .find((element) => !element.classList.contains("hidden"));
  }

  function focusableElements(container) {
    return $$Within(container, "button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])")
      .filter((element) => !element.classList.contains("hidden") && element.offsetParent !== null);
  }

  function $$Within(container, selector) {
    return [...container.querySelectorAll(selector)];
  }

  function openFilterSheet() {
    lastFilterFocus = document.activeElement;
    setHidden($("#filter-backdrop"), false);
    setHidden($("#filter-sheet"), false);
    updateBodyLock();
    $("#close-filter-sheet").focus();
  }

  function closeFilterSheet() {
    setHidden($("#filter-backdrop"), true);
    setHidden($("#filter-sheet"), true);
    updateBodyLock();
    lastFilterFocus?.focus();
  }

  function openHelp() {
    lastHelpFocus = document.activeElement;
    setHidden($("#help-backdrop"), false);
    setHidden($("#help-dialog"), false);
    updateBodyLock();
    $("#close-help").focus();
  }

  function closeHelp() {
    setHidden($("#help-backdrop"), true);
    setHidden($("#help-dialog"), true);
    updateBodyLock();
    lastHelpFocus?.focus();
  }

  function openDetailShell() {
    lastDetailFocus = document.activeElement;
    setHidden($("#detail-backdrop"), false);
    setHidden($("#detail-drawer"), false);
    updateBodyLock();
    $("#close-detail").focus();
  }

  function closeDetail() {
    setHidden($("#detail-backdrop"), true);
    setHidden($("#detail-drawer"), true);
    $("#detail-content").innerHTML = "";
    $("#detail-back").classList.add("hidden");
    currentDetailGroup = null;
    updateBodyLock();
    lastDetailFocus?.focus();
  }

  function closeCategoryPopover() {
    setHidden($("#category-popover"), true);
    $("#category-trigger").setAttribute("aria-expanded", "false");
  }

  function handleGlobalKeydown(event) {
    if (event.key === "Escape") {
      if (!$("#detail-drawer").classList.contains("hidden")) closeDetail();
      else if (!$("#help-dialog").classList.contains("hidden")) closeHelp();
      else if (!$("#filter-sheet").classList.contains("hidden")) closeFilterSheet();
      else if (!$("#category-popover").classList.contains("hidden")) closeCategoryPopover();
      return;
    }

    if (event.key !== "Tab") return;
    const dialog = visibleDialog();
    if (!dialog) return;
    const focusable = focusableElements(dialog);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function showView(view) {
    state.view = view;
    const guideActive = view === "guide";
    setHidden($("#guide-view"), !guideActive);
    setHidden($("#timetable-view"), guideActive);
    $$("[data-view]").forEach((button) => {
      const active = button.dataset.view === view;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });
    if (!guideActive && catalog) renderTimetable();
  }

  function setScope(scope) {
    state.scope = scope;
    state.visibleCount = BATCH_SIZE;
    $$("[data-scope]").forEach((button) => {
      const active = button.dataset.scope === scope;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });
    const presentationScope = scope === "presentations";
    $("#scope-note").textContent = presentationScope
      ? "搜尋題名、作者、機構與 Abstract ID"
      : "搜尋 session code、題名與主題";
    $("#search-input").placeholder = presentationScope
      ? "輸入題名、作者、機構、Abstract ID 或 session code"
      : "輸入 session code、題名或主題";
    renderResults();
  }

  function updateConferenceSummary() {
    const meta = catalog.meta;
    const oralPoster = meta.oral + meta.poster;
    $("#conference-summary").innerHTML = [
      `${meta.session_groups} sessions`,
      `${oralPoster.toLocaleString()} presentations`,
      `${meta.days} days`,
      "JST"
    ].map((label) => `<span>${esc(label)}</span>`).join("");
  }

  function buildDateOptions() {
    const options = catalog.meta.dates
      .map((date) => `<option value="${esc(date)}">${esc(dayLabel(date))}</option>`)
      .join("");
    $("#date-filter").innerHTML = `<option value="">所有日期</option>${options}`;
  }

  function timeKey(start, end) {
    return `${start}-${end}`;
  }

  function scheduleTimeKey(schedule) {
    const range = parseTimeRange(schedule.time_range || schedule.program_slot);
    return range ? timeKey(range.start, range.end) : "";
  }

  function formatTimeRange(value) {
    const [start, end] = String(value).split("-").map(Number);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return value;
    const format = (minutes) => {
      const hour = String(Math.floor(minutes / 60) % 24).padStart(2, "0");
      const minute = String(minutes % 60).padStart(2, "0");
      return `${hour}:${minute}`;
    };
    return `${format(start)}–${format(end)}`;
  }

  function timeTag(rows) {
    const labels = rows.map(({ schedule }) => String(schedule.program_slot || "").trim());
    const namedSlot = ["AM1", "AM2", "PM1", "PM2"]
      .find((name) => labels.some((label) => label.toUpperCase().startsWith(name)));
    if (namedSlot) return namedSlot;
    const poster = rows.some(({ schedule, group }) =>
      scheduleTypeOf(schedule, group.category) === "Poster"
      || /^Poster\b/i.test(String(schedule.program_slot || "")));
    return poster ? "Poster" : "";
  }

  function formatTimeOption(value) {
    return timeOptionLabels.get(value) || formatTimeRange(value);
  }

  function buildTimeOptions() {
    const schedulesByTime = new Map();
    groups.forEach((group) => group.schedules.forEach((schedule) => {
      const key = scheduleTimeKey(schedule);
      if (!key) return;
      if (!schedulesByTime.has(key)) schedulesByTime.set(key, []);
      schedulesByTime.get(key).push({ schedule, group });
    }));
    const slots = [...schedulesByTime.keys()]
      .sort((a, b) => Number(a.split("-")[0]) - Number(b.split("-")[0]) || Number(a.split("-")[1]) - Number(b.split("-")[1]));
    timeOptionLabels.clear();
    slots.forEach((slot) => {
      const tag = timeTag(schedulesByTime.get(slot));
      timeOptionLabels.set(slot, [tag, formatTimeRange(slot)].filter(Boolean).join(" · "));
    });
    const options = slots.map((slot) => `<option value="${esc(slot)}">${esc(formatTimeOption(slot))}</option>`).join("");
    $("#time-filter").innerHTML = `<option value="">所有時間</option>${options}`;
    $("#sheet-time-filter").innerHTML = `<option value="">所有時間</option>${options}`;
  }

  function buildCategoryOptions() {
    $("#category-options").innerHTML = CATEGORY_ORDER
      .filter((category) => groups.some((group) => group.category === category))
      .map((category) => `
        <label class="category-option" data-category-option="${esc(category)}">
          <input type="checkbox" value="${esc(category)}">
          <span><strong>${esc(category)}</strong> · ${esc(categoryName(category))}</span>
        </label>
      `).join("");
    updateCategoryUi();
  }

  function updateCategoryUi() {
    const selected = state.categories;
    $("#category-trigger").textContent = selected.length
      ? selected.map((category) => `${category} · ${categoryName(category)}`).join(" + ")
      : "所有類別";
    $$("#category-options input[type='checkbox']").forEach((input) => {
      input.checked = selected.includes(input.value);
      const disabled = !input.checked && selected.length >= 2;
      input.disabled = disabled;
      input.closest(".category-option").classList.toggle("is-disabled", disabled);
    });
  }

  function allTopics() {
    return [...new Set(groups.flatMap((group) => group.topics).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-Hant"));
  }

  function renderTopicStrip() {
    const topics = allTopics();
    $("#topic-strip").innerHTML = ["", ...topics].map((topic) => {
      const active = state.topic === topic;
      return `<button class="topic-chip${active ? " active" : ""}" type="button" data-topic="${esc(topic)}" aria-pressed="${active}">${esc(topic || "全部")}</button>`;
    }).join("");
  }

  function syncControls() {
    $("#search-input").value = state.query;
    $("#date-filter").value = state.date;
    $("#type-filter").value = state.type;
    $("#time-filter").value = state.time;
    $("#sheet-time-filter").value = state.time;
    $("#location-filter").value = state.location;
    $("#sheet-location-filter").value = state.location;
    setHidden($("#clear-search"), !state.query);
    updateCategoryUi();
    renderTopicStrip();
    renderActiveFilters();
  }

  function renderActiveFilters() {
    const filters = [
      ...state.categories.map((category) => ({ key: "category", value: category, label: `${category} · ${categoryName(category)}` })),
      state.type && { key: "type", label: state.type },
      state.date && { key: "date", label: dayLabel(state.date) },
      state.time && { key: "time", label: formatTimeOption(state.time) },
      state.location && { key: "location", label: state.location },
      state.topic && { key: "topic", label: state.topic }
    ].filter(Boolean);
    const container = $("#active-filters");
    setHidden(container, !filters.length);
    container.innerHTML = filters.length
      ? `${filters.map((filter) => `<button class="filter-chip" type="button" data-clear-filter="${esc(filter.key)}" data-filter-value="${esc(filter.value || "")}">${esc(filter.label)}</button>`).join("")}<button class="text-button" type="button" data-clear-filter="all">清除全部</button>`
      : "";
  }

  function clearFilters() {
    state.categories = [];
    state.type = "";
    state.date = "";
    state.time = "";
    state.location = "";
    state.topic = "";
    state.visibleCount = BATCH_SIZE;
    syncControls();
    renderResults();
  }

  function clearSingleFilter(key, value) {
    if (key === "all") {
      clearFilters();
      return;
    }
    if (key === "category") state.categories = state.categories.filter((category) => category !== value);
    else state[key] = "";
    state.visibleCount = BATCH_SIZE;
    syncControls();
    renderResults();
  }

  function scheduleMatches(schedule, group, includeTime = true) {
    return (!state.type || scheduleTypeOf(schedule, group.category) === state.type)
      && (!state.date || schedule.date === state.date)
      && (!includeTime || !state.time || scheduleTimeKey(schedule) === state.time)
      && (!state.location || venueGroup(schedule.venue) === state.location);
  }

  function matchingSchedules(group) {
    return group.schedules.filter((schedule) => scheduleMatches(schedule, group));
  }

  function groupMatches(group) {
    if (state.categories.length && !state.categories.includes(group.category)) return false;
    if (state.topic && !group.topics.includes(state.topic)) return false;
    const hasScheduleFilter = Boolean(state.type || state.date || state.time || state.location);
    if (hasScheduleFilter && !matchingSchedules(group).length) return false;
    const query = normalize(state.query);
    if (!query) return true;
    return normalize([group.category, categoryName(group.category), group.code, group.title, ...group.topics].join(" ")).includes(query);
  }

  function sessionRank(group) {
    const query = normalize(state.query);
    if (!query) return 4;
    if (normalize(group.code) === query) return 0;
    if (normalize(group.title).includes(query)) return 1;
    if (normalize(group.topics.join(" ")).includes(query)) return 2;
    return 3;
  }

  function presentationSearchText(row) {
    const type = presentationTypeOf(row);
    return [
      categoryOf(row),
      categoryName(categoryOf(row)),
      PROGRAM_TYPE_NAMES[type],
      row.presentation_type,
      type,
      row.abstract_id,
      row.session_code,
      row.session_title,
      row.presentation_title,
      row.presenting_author,
      row.institution
    ].join(" ");
  }

  function presentationMatches(row) {
    const category = categoryOf(row);
    const type = presentationTypeOf(row);
    if (state.categories.length && !state.categories.includes(category)) return false;
    if (state.type && type !== state.type) return false;
    if (state.date && row.date !== state.date) return false;
    if (state.time && scheduleTimeKey(row) !== state.time) return false;
    if (state.location && venueGroup(row.venue) !== state.location) return false;
    if (state.topic && ![row.topic_primary, row.topic_secondary].includes(state.topic)) return false;
    return normalize(presentationSearchText(row)).includes(normalize(state.query));
  }

  function presentationRank(row) {
    const query = normalize(state.query);
    if ([normalize(row.abstract_id), normalize(row.session_code)].includes(query)) return 0;
    if (normalize(row.presentation_title).includes(query)) return 1;
    if (normalize([row.presenting_author, row.institution].join(" ")).includes(query)) return 2;
    return 3;
  }

  async function loadPresentationCategory(category) {
    if (presentationsByCategory.has(category)) return presentationsByCategory.get(category);
    if (!presentationPromises.has(category)) {
      const request = fetch(`./data/presentations/${encodeURIComponent(category)}.json`)
        .then((response) => {
          if (!response.ok) throw new Error(`${category} 題目資料載入失敗（${response.status}）`);
          return response.json();
        })
        .then((payload) => {
          const rows = payload.presentations || [];
          presentationsByCategory.set(category, rows);
          rows.forEach((row) => presentationsById.set(row.id, row));
          return rows;
        })
        .catch((error) => {
          presentationPromises.delete(category);
          throw error;
        });
      presentationPromises.set(category, request);
    }
    return presentationPromises.get(category);
  }

  async function presentationResults() {
    const categories = state.categories.length ? state.categories : CATEGORY_ORDER;
    const chunks = await Promise.all(categories.map(loadPresentationCategory));
    return chunks.flat()
      .filter(presentationMatches)
      .sort((a, b) => presentationRank(a) - presentationRank(b)
        || `${a.date}${a.time_range}${a.session_code}${a.abstract_id}`.localeCompare(`${b.date}${b.time_range}${b.session_code}${b.abstract_id}`));
  }

  function sessionCardHtml(group) {
    const schedules = matchingSchedules(group);
    const visibleSchedules = schedules.length ? schedules : group.schedules;
    const schedule = visibleSchedules[0];
    const extraSchedules = Math.max(0, visibleSchedules.length - 1);
    const typePills = group.types.map((type) => `<span class="type-pill ${typeClass(type)}">${esc(type)}</span>`).join("");
    const tags = group.topics.slice(0, 3).map((topic) => `<span class="theme-tag">${esc(topic)}</span>`).join("");
    const countParts = [
      group.counts.oral && `${group.counts.oral} Oral`,
      group.counts.poster && `${group.counts.poster} Poster`,
      group.counts.other && `${group.counts.other} Key & Special`
    ].filter(Boolean);
    const scheduleHtml = schedule ? `
      <div class="schedule-summary">
        <strong>${esc(schedule.day || schedule.date)}</strong>
        <span>${esc(schedule.program_slot || schedule.time_range)}</span>
        <span class="room">${esc([schedule.venue, schedule.room].filter(Boolean).join(" · ") || "場地待確認")}</span>
      </div>` : `<div class="schedule-summary"><span>時段資料待確認</span></div>`;
    return `
      <article class="result-card">
        <div class="card-top">
          <div class="card-identity">
            <div class="card-code">${esc(group.category)} · ${esc(categoryName(group.category))} · ${esc(group.code)}</div>
            <button class="card-title-button" type="button" data-open-session="${esc(group.key)}" aria-label="查看 ${esc(group.code)} 詳情">${esc(group.title || "Untitled session")}</button>
          </div>
          <div class="type-pills">${typePills}</div>
        </div>
        ${tags ? `<div class="card-tags">${tags}</div>` : ""}
        ${scheduleHtml}
        <div class="card-foot">
          <span>${esc(countParts.join(" · ") || "尚無題目資料")}${extraSchedules ? ` · 另有 ${extraSchedules} 場` : ""}</span>
          <span class="card-open-hint">查看詳情 →</span>
        </div>
      </article>`;
  }

  function presentationCardHtml(row) {
    const type = presentationTypeOf(row) || "Presentation";
    const group = groupByKey.get(groupKeyOf(row));
    const author = [row.presenting_author, row.institution].filter(Boolean).join(" · ") || "作者資料待確認";
    const schedule = [row.day || row.date, row.program_slot || row.time_range].filter(Boolean).join(" · ");
    const room = [row.venue, row.room].filter(Boolean).join(" · ");
    return `
      <article class="result-card presentation-card">
        <div class="card-top">
          <div class="card-identity">
            <div class="card-code">${esc(type)} · ${esc(row.abstract_id || row.session_code)}</div>
            <button class="card-title-button" type="button" data-open-presentation="${esc(row.id)}" aria-label="查看 ${esc(row.abstract_id || "題目")} 詳情">${esc(row.presentation_title || "Untitled presentation")}</button>
          </div>
          <div class="type-pills"><span class="type-pill ${typeClass(type)}">${esc(type)}</span></div>
        </div>
        <div class="presentation-meta"><span><strong>作者</strong> ${esc(author)}</span></div>
        <div class="presentation-meta">
          <span><strong>Session</strong> ${esc(row.session_code)} · ${esc(group?.title || row.session_title || "")}</span>
          <span><strong>時間</strong> ${esc(schedule || "待確認")}</span>
          <span><strong>場地</strong> ${esc(room || "待確認")}</span>
        </div>
        <div class="card-foot"><span>${esc(row.category)} · ${esc(categoryName(row.category))}</span><span class="card-open-hint">查看詳情 →</span></div>
      </article>`;
  }

  function updateResultHeading(total) {
    const sessionScope = state.scope === "sessions";
    $("#results-kicker").textContent = sessionScope ? "SESSION GUIDE" : "PRESENTATION SEARCH";
    $("#results-heading").textContent = sessionScope ? "符合條件的 sessions" : "題目與作者";
    $("#results-count").textContent = sessionScope
      ? `${total.toLocaleString()} / ${groups.length.toLocaleString()} sessions`
      : `${total.toLocaleString()} presentations`;
    $("#sheet-apply").textContent = total ? `顯示 ${total.toLocaleString()} 筆結果` : "顯示結果";
  }

  function renderVisibleResults() {
    const shown = currentMatches.slice(0, state.visibleCount);
    $("#results-list").innerHTML = shown.map((item) => state.scope === "sessions" ? sessionCardHtml(item) : presentationCardHtml(item)).join("");
    setHidden($("#load-more"), shown.length >= currentMatches.length);
    if (shown.length < currentMatches.length) {
      $("#load-more").textContent = `載入更多（尚有 ${(currentMatches.length - shown.length).toLocaleString()} 筆）`;
    }
  }

  function showResultsStatus(name) {
    ["loading-panel", "error-panel", "empty-panel", "search-prompt"].forEach((id) => setHidden($(`#${id}`), id !== name));
  }

  async function renderResults() {
    if (!catalog) return;
    const token = ++renderToken;
    syncControls();
    $("#results-list").innerHTML = "";
    setHidden($("#load-more"), true);
    showResultsStatus("");

    if (state.scope === "presentations" && !normalize(state.query)) {
      currentMatches = [];
      showResultsStatus("search-prompt");
      updateResultHeading(0);
      return;
    }

    try {
      if (state.scope === "presentations") showResultsStatus("loading-panel");
      const matches = state.scope === "sessions"
        ? groups.filter(groupMatches).sort((a, b) => sessionRank(a) - sessionRank(b)
          || CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category)
          || a.code.localeCompare(b.code, undefined, { numeric: true }))
        : await presentationResults();
      if (token !== renderToken) return;
      currentMatches = matches;
      updateResultHeading(matches.length);
      showResultsStatus(matches.length ? "" : "empty-panel");
      renderVisibleResults();
    } catch (error) {
      if (token !== renderToken) return;
      currentMatches = [];
      $("#error-message").textContent = error.message || "請確認連線後重試。";
      showResultsStatus("error-panel");
      updateResultHeading(0);
    }
  }

  function detailScheduleHtml(schedule, group) {
    return `
      <div class="detail-schedule">
        <strong>${esc(typeLabel(scheduleTypeOf(schedule, group.category)))} · ${esc(schedule.day || schedule.date)}</strong>
        <span>${esc(schedule.program_slot || schedule.time_range)} · ${esc([schedule.venue, schedule.room].filter(Boolean).join(" · ") || "場地待確認")}</span>
      </div>`;
  }

  function renderSessionDetail(group, presentations) {
    currentDetailGroup = group;
    $("#detail-back").classList.add("hidden");
    const source = group.schedules.find((schedule) => schedule.source_url)?.source_url;
    const peopleSource = group.schedules.find((schedule) => schedule.convener || schedule.session_chairs);
    const tags = group.topics.map((topic) => `<span class="theme-tag">${esc(topic)}</span>`).join("");
    const presentationRows = presentations.map((row) => {
      const type = presentationTypeOf(row) || "Presentation";
      return `<button class="detail-presentation" type="button" data-open-presentation-detail="${esc(row.id)}"><span>${esc(type)} · ${esc(row.abstract_id || "")}</span><strong>${esc(row.presentation_title || "Untitled presentation")}</strong><small>${esc(row.presenting_author || "作者資料待確認")}</small></button>`;
    }).join("");
    $("#detail-content").innerHTML = `
      <div class="detail-kicker">${esc(group.category)} · ${esc(categoryName(group.category))} · ${esc(group.code)}</div>
      <h2 id="detail-title">${esc(group.title || "Untitled session")}</h2>
      ${tags ? `<div class="detail-tags">${tags}</div>` : ""}
      <section class="detail-section">
        <h3>所有時段與場地</h3>
        <div class="detail-schedules">${group.schedules.map((schedule) => detailScheduleHtml(schedule, group)).join("") || "<p>時段資料待確認。</p>"}</div>
      </section>
      ${peopleSource ? `<section class="detail-section"><h3>Session 人員</h3><div class="detail-people">${peopleSource.convener ? `<div><b>Convener</b>${esc(peopleSource.convener)}</div>` : ""}${peopleSource.session_chairs ? `<div><b>Session chairs</b>${esc(peopleSource.session_chairs)}</div>` : ""}</div></section>` : ""}
      <section class="detail-section">
        <h3>題目清單 · ${presentations.length.toLocaleString()} 筆</h3>
        <div class="detail-presentations">${presentationRows || "<p class='detail-copy'>目前沒有題目資料。</p>"}</div>
      </section>
      ${source ? `<a class="official-link" href="${esc(source)}" target="_blank" rel="noreferrer">開啟官方議程 ↗</a>` : ""}`;
    $("#detail-content").scrollTop = 0;
  }

  async function openSession(group) {
    openDetailShell();
    currentDetailGroup = group;
    $("#detail-content").innerHTML = `<div class="status-panel">正在載入 ${esc(group.code)} 題目資料…</div>`;
    try {
      const rows = await loadPresentationCategory(group.category);
      const presentations = rows.filter((row) => groupKeyOf(row) === group.key);
      renderSessionDetail(group, presentations);
    } catch (error) {
      $("#detail-content").innerHTML = `<div class="status-panel error-panel"><strong>題目資料載入失敗</strong><span>${esc(error.message)}</span><button class="primary-button" type="button" data-retry-session="${esc(group.key)}">重新載入</button></div>`;
    }
  }

  function renderPresentationDetail(row, group) {
    currentDetailGroup = group || groupByKey.get(groupKeyOf(row)) || null;
    $("#detail-back").classList.toggle("hidden", !currentDetailGroup);
    const type = presentationTypeOf(row) || "Presentation";
    const schedule = [row.day || row.date, row.program_slot || row.time_range].filter(Boolean).join(" · ");
    const room = [row.venue, row.room].filter(Boolean).join(" · ");
    $("#detail-content").innerHTML = `
      <div class="detail-kicker">${esc(type)} · ${esc(row.abstract_id || row.session_code)}</div>
      <h2 id="detail-title">${esc(row.presentation_title || "Untitled presentation")}</h2>
      <section class="detail-section">
        <div class="detail-people">
          <div><b>作者</b>${esc(row.presenting_author || "作者資料待確認")}</div>
          ${row.institution ? `<div><b>機構</b>${esc(row.institution)}</div>` : ""}
          <div><b>Session</b>${esc(row.session_code)} · ${esc(currentDetailGroup?.title || row.session_title || "")}</div>
          <div><b>時間</b>${esc(schedule || "待確認")}</div>
          <div><b>場地</b>${esc(room || "待確認")}</div>
        </div>
      </section>
      <section class="detail-section">
        <h3>摘要</h3>
        <div class="detail-copy">${esc(row.abstract || (type === "Poster" ? "官方 Poster 端點未提供摘要。" : "官方議程未提供摘要。"))}</div>
      </section>
      ${row.source_url ? `<a class="official-link" href="${esc(row.source_url)}" target="_blank" rel="noreferrer">開啟官方議程 ↗</a>` : ""}`;
    $("#detail-content").scrollTop = 0;
  }

  function openPresentation(row) {
    openDetailShell();
    renderPresentationDetail(row, groupByKey.get(groupKeyOf(row)));
  }

  function parseTimeRange(value) {
    const matches = [...String(value || "").matchAll(/(\d{1,2}):(\d{2})\s*(AM|PM)?/gi)];
    if (matches.length < 2) return null;
    const clockMinutes = (match, marker) => {
      let hour = Number(match[1]);
      const minute = Number(match[2]);
      if (marker === "AM" && hour === 12) hour = 0;
      if (marker === "PM" && hour !== 12) hour += 12;
      return hour * 60 + minute;
    };
    const startMarker = (matches[0][3] || matches[1][3] || "").toUpperCase();
    const endMarker = (matches[1][3] || matches[0][3] || "").toUpperCase();
    const start = clockMinutes(matches[0], startMarker);
    let end = clockMinutes(matches[1], endMarker);
    if (end <= start) end += 1440;
    return { start, end };
  }

  function formatMinutes(value) {
    const hour24 = Math.floor(value / 60) % 24;
    const hour = hour24 % 12 || 12;
    const minute = String(value % 60).padStart(2, "0");
    return `${hour}:${minute} ${hour24 >= 12 ? "PM" : "AM"}`;
  }

  function timetableEvents(date) {
    return groups.flatMap((group) => group.schedules
      .filter((schedule) => schedule.date === date)
      .map((schedule) => {
        const range = parseTimeRange(schedule.time_range);
        if (!range) return null;
        return {
          ...range,
          category: group.category,
          type: scheduleTypeOf(schedule, group.category),
          groupKey: group.key
        };
      })
      .filter(Boolean));
  }

  function timetableSegments(date) {
    const events = timetableEvents(date);
    const points = [...new Set(events.flatMap((event) => [event.start, event.end]))].sort((a, b) => a - b);
    return points.slice(0, -1).map((start, index) => ({
      start,
      end: points[index + 1],
      events: events.filter((event) => event.start < points[index + 1] && event.end > start)
    }));
  }

  function compactDateLabel(date) {
    const parsed = new Date(`${date}T00:00:00`);
    const weekday = parsed.toLocaleDateString("en-US", { weekday: "short" });
    return { main: `${parsed.getMonth() + 1}/${parsed.getDate()}`, sub: weekday };
  }

  function renderTimetableDates() {
    $("#timetable-dates").innerHTML = catalog.meta.dates.map((date) => {
      const label = compactDateLabel(date);
      const active = state.timetableDate === date;
      return `<button class="date-tab${active ? " active" : ""}" type="button" role="tab" aria-selected="${active}" data-timetable-date="${esc(date)}"><strong>${esc(label.main)}</strong>${esc(label.sub)}</button>`;
    }).join("");
  }

  function timetableTargetKey(date, start, end, category) {
    return `${date}|${start}|${end}|${category}`;
  }

  function typesForEvents(events) {
    const order = { Oral: 0, Poster: 1, AL: 2, DL: 3, KL: 4, SL: 5, ML: 6, SS: 7, KEY: 8, Special: 9 };
    return [...new Set(events.map((event) => event.type).filter(Boolean))]
      .sort((a, b) => (order[a] ?? 99) - (order[b] ?? 99));
  }

  function renderTimetable() {
    if (!catalog) return;
    if (!state.timetableDate) state.timetableDate = catalog.meta.dates[0];
    renderTimetableDates();
    timetableTargets.clear();
    const segments = timetableSegments(state.timetableDate);
    const header = `<div class="matrix-head"><div>TIME</div>${CATEGORY_ORDER.map((category) => `<div class="${categoryClass(category)}">${esc(category)}</div>`).join("")}</div>`;
    const rows = segments.map((segment) => {
      const cells = CATEGORY_ORDER.map((category) => {
        const events = segment.events.filter((event) => event.category === category);
        if (!events.length) return `<div class="matrix-cell" aria-label="${esc(category)} 無議程"></div>`;
        const types = typesForEvents(events);
        const key = timetableTargetKey(state.timetableDate, segment.start, segment.end, category);
        timetableTargets.set(key, events);
        return `<div class="matrix-cell ${categoryClass(category)}"><button class="matrix-event" type="button" data-timetable-target="${esc(key)}" aria-label="${esc(categoryName(category))}：${esc(types.join(" + "))}"><strong>${esc(category)}</strong><span>${esc(types.join(" + "))}</span></button></div>`;
      }).join("");
      return `<div class="matrix-row"><div class="matrix-time">${esc(formatMinutes(segment.start))}<br>–<br>${esc(formatMinutes(segment.end))}</div>${cells}</div>`;
    }).join("");

    const mobile = segments.map((segment) => {
      const categories = CATEGORY_ORDER.map((category) => {
        const events = segment.events.filter((event) => event.category === category);
        if (!events.length) return "";
        const types = typesForEvents(events);
        const key = timetableTargetKey(state.timetableDate, segment.start, segment.end, category);
        timetableTargets.set(key, events);
        return `<button class="mobile-event ${categoryClass(category)}" type="button" data-timetable-target="${esc(key)}"><strong>${esc(category)} · ${esc(categoryName(category))}</strong><span>${esc(types.join(" + "))}</span></button>`;
      }).filter(Boolean).join("");
      return `<article class="time-card"><h3>${esc(formatMinutes(segment.start))} – ${esc(formatMinutes(segment.end))}</h3><div class="mobile-events">${categories || `<div class="free-slot">此時段沒有議程</div>`}</div></article>`;
    }).join("");

    $("#timetable-content").innerHTML = `
      <div class="matrix-wrap"><div class="matrix-scroll">${header}${rows}</div></div>
      <div class="mobile-agenda">${mobile || `<div class="status-panel">這一天沒有可用的時程資料。</div>`}</div>`;
  }

  function applyTimetableTarget(key) {
    const events = timetableTargets.get(key);
    if (!events?.length) return;
    const event = [...events].sort((a, b) => a.start - b.start)[0];
    state.categories = [event.category];
    state.date = state.timetableDate;
    state.time = timeKey(event.start, event.end);
    state.type = "";
    state.topic = "";
    state.query = "";
    state.visibleCount = BATCH_SIZE;
    showView("guide");
    setScope("sessions");
    $("#guide-view").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function loadCatalog() {
    showResultsStatus("loading-panel");
    try {
      const response = await fetch("./data/session-catalog.json");
      if (!response.ok) throw new Error(`Session catalog 載入失敗（${response.status}）`);
      catalog = await response.json();
      groups = catalog.groups || [];
      groups.forEach((group) => groupByKey.set(group.key, group));
      state.timetableDate = catalog.meta.dates[0] || "";
      updateConferenceSummary();
      buildDateOptions();
      buildTimeOptions();
      buildCategoryOptions();
      renderTopicStrip();
      renderTimetableDates();
      syncControls();
      await renderResults();
    } catch (error) {
      $("#error-message").textContent = error.message || "請確認連線後重試。";
      showResultsStatus("error-panel");
      $("#results-count").textContent = "載入失敗";
    }
  }

  function bindEvents() {
    document.addEventListener("keydown", handleGlobalKeydown);
    $$("[data-view]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
    $$("[data-scope]").forEach((button) => button.addEventListener("click", () => setScope(button.dataset.scope)));

    $("#search-input").addEventListener("input", (event) => {
      state.query = event.target.value;
      state.visibleCount = BATCH_SIZE;
      setHidden($("#clear-search"), !state.query);
      clearTimeout(searchTimer);
      searchTimer = setTimeout(renderResults, 150);
    });
    $("#clear-search").addEventListener("click", () => {
      clearTimeout(searchTimer);
      state.query = "";
      state.visibleCount = BATCH_SIZE;
      syncControls();
      renderResults();
      $("#search-input").focus();
    });

    [["#date-filter", "date"], ["#type-filter", "type"], ["#time-filter", "time"], ["#location-filter", "location"]]
      .forEach(([selector, key]) => $(selector).addEventListener("change", (event) => {
        state[key] = event.target.value;
        state.visibleCount = BATCH_SIZE;
        syncControls();
        renderResults();
      }));

    $("#sheet-time-filter").addEventListener("change", (event) => {
      state.time = event.target.value;
      state.visibleCount = BATCH_SIZE;
      syncControls();
      renderResults();
    });
    $("#sheet-location-filter").addEventListener("change", (event) => {
      state.location = event.target.value;
      state.visibleCount = BATCH_SIZE;
      syncControls();
      renderResults();
    });

    $("#category-trigger").addEventListener("click", () => {
      const willOpen = $("#category-popover").classList.contains("hidden");
      setHidden($("#category-popover"), !willOpen);
      $("#category-trigger").setAttribute("aria-expanded", String(willOpen));
    });
    $("#category-options").addEventListener("change", (event) => {
      const input = event.target.closest("input[type='checkbox']");
      if (!input) return;
      if (input.checked && state.categories.length >= 2) {
        input.checked = false;
        showToast("類別最多選擇兩個");
        return;
      }
      state.categories = input.checked
        ? [...state.categories, input.value]
        : state.categories.filter((category) => category !== input.value);
      state.visibleCount = BATCH_SIZE;
      syncControls();
      renderResults();
    });
    $("#clear-categories").addEventListener("click", () => {
      state.categories = [];
      state.visibleCount = BATCH_SIZE;
      syncControls();
      renderResults();
    });
    document.addEventListener("click", (event) => {
      if (!event.target.closest(".category-field")) closeCategoryPopover();
    });

    $("#topic-strip").addEventListener("click", (event) => {
      const button = event.target.closest("[data-topic]");
      if (!button) return;
      state.topic = button.dataset.topic;
      state.visibleCount = BATCH_SIZE;
      syncControls();
      renderResults();
    });
    $("#active-filters").addEventListener("click", (event) => {
      const button = event.target.closest("[data-clear-filter]");
      if (!button) return;
      clearSingleFilter(button.dataset.clearFilter, button.dataset.filterValue || "");
    });

    $("#load-more").addEventListener("click", () => {
      state.visibleCount += BATCH_SIZE;
      renderVisibleResults();
    });
    $("#results-list").addEventListener("click", (event) => {
      const sessionButton = event.target.closest("[data-open-session]");
      if (sessionButton) {
        const group = groupByKey.get(sessionButton.dataset.openSession);
        if (group) openSession(group);
        return;
      }
      const presentationButton = event.target.closest("[data-open-presentation]");
      if (presentationButton) {
        const row = presentationsById.get(presentationButton.dataset.openPresentation);
        if (row) openPresentation(row);
      }
    });

    $("#detail-content").addEventListener("click", (event) => {
      const presentationButton = event.target.closest("[data-open-presentation-detail]");
      if (presentationButton) {
        const row = presentationsById.get(presentationButton.dataset.openPresentationDetail);
        if (row) renderPresentationDetail(row, currentDetailGroup);
        return;
      }
      const retryButton = event.target.closest("[data-retry-session]");
      if (retryButton) {
        const group = groupByKey.get(retryButton.dataset.retrySession);
        if (group) openSession(group);
      }
    });
    $("#detail-back").addEventListener("click", async () => {
      if (!currentDetailGroup) return;
      const rows = await loadPresentationCategory(currentDetailGroup.category);
      renderSessionDetail(currentDetailGroup, rows.filter((row) => groupKeyOf(row) === currentDetailGroup.key));
    });
    $("#close-detail").addEventListener("click", closeDetail);
    $("#detail-backdrop").addEventListener("click", closeDetail);

    $("#more-filter-button").addEventListener("click", openFilterSheet);
    $("#close-filter-sheet").addEventListener("click", closeFilterSheet);
    $("#filter-backdrop").addEventListener("click", closeFilterSheet);
    $("#sheet-apply").addEventListener("click", closeFilterSheet);
    $("#sheet-clear").addEventListener("click", () => {
      clearFilters();
      closeFilterSheet();
    });

    $("#help-button").addEventListener("click", openHelp);
    $("#close-help").addEventListener("click", closeHelp);
    $("#help-backdrop").addEventListener("click", closeHelp);

    $("#timetable-dates").addEventListener("click", (event) => {
      const button = event.target.closest("[data-timetable-date]");
      if (!button) return;
      state.timetableDate = button.dataset.timetableDate;
      renderTimetable();
    });
    $("#timetable-content").addEventListener("click", (event) => {
      const button = event.target.closest("[data-timetable-target]");
      if (button) applyTimetableTarget(button.dataset.timetableTarget);
    });

    $("#retry-button").addEventListener("click", () => catalog ? renderResults() : loadCatalog());
  }

  bindEvents();
  loadCatalog();
})();
