/* 访谈稿匿名化映射编辑器 —— 前端逻辑
 *
 * 核心规则（优先级从高到低）：
 * 1. 显式框选优先：用户框选的片段占据其字符区间，称呼命中与保留原文例外与之重叠时让位；
 * 2. 保留原文例外：按原稿字符区间记录，区间内原文照录，并屏蔽与之重叠的所有自动称呼命中；
 *    显式框选仍可切开、覆盖例外；
 * 3. 最长称呼优先：称呼命中之间发生重叠时，更长的称呼优先，长度相同则先出现者优先；
 * 4. 原稿永不改动：匿名结果只体现在预览中，同时维护双向字符区间映射。
 *
 * 共享称呼裁决：同一称呼登记在多位人物名下时即构成冲突，未裁决的冲突称呼不参与自动
 * 替换（不再由人物列表顺序暗中决定代号）；在侧栏为冲突称呼选定归属人物后，其命中按
 * 上述既有优先级进入匿名预览与区间映射，巡检状态与引文随之重算。人物删除/合并导致
 * 候选集合变化时，失效裁决自动清除；冲突消失（仅剩一位候选）即恢复唯一归属、自动参与
 * 替换。每次裁决（含改选、取消）与标记例外、恢复匿名、添加/删除/合并人物、框选、
 * 批量同文指派一样进入同一个撤销栈；
 * 合并人物为原子操作：一次入栈，撤销时按原 ID、列表位置、称呼与全部关联区间精确恢复；
 * 批量同文指派同样整批一条记录：撤销即恢复操作前的区间集合与匿名预览。
 */
(function () {
  'use strict';

  // ---------- 状态 ----------
  var state = {
    text: '',          // 原稿（加载后只读）
    persons: [],       // { id, codename, aliases:[], color }
    selections: [],    // { id, start, end, personId } 显式框选
    exceptions: [],    // { id, start, end, personId } 保留原文例外
    history: [],       // 撤销栈：person / selection / exception / restore / removePerson / mergePerson / batchAssign / inspectAssign / resolveAlias
    currentPreview: '',
    currentMap: [],    // { id, kind, oStart, oEnd, pStart, pEnd, personId, explicit, exId }
    candidates: [],    // 敏感信息巡检候选（随原稿一次性离线扫描，detectSensitive 结果）
    inspect: [],       // 候选依据最新映射判定后的结果（每次渲染重算，含 cid/status/leakRanges）
    inspectFilter: 'all', // 巡检侧栏状态筛选：all / leaking / kept / anonymized
    citations: [],     // 引文：{ id, start, end } 原稿非空半开区间（按添加顺序），引文正文每次渲染重算
    sharedAliases: [], // 共享称呼冲突（每次渲染由 detectSharedAliases 重算）：{ alias, personIds, hits }
    resolutions: Object.create(null) // 共享称呼裁决表：称呼 -> 归属人物 id（无原型键，避免特殊称呼串干扰）
  };
  var personSeq = 1;
  var selSeq = 1;
  var excSeq = 1;
  var citSeq = 1;

  var PALETTE = ['#ffe08a', '#b5e0a8', '#a8d8ff', '#ffc6c6', '#e3c6ff', '#ffd9a8', '#a8e6e0', '#f5c6e0'];

  // ---------- DOM ----------
  var $ = function (id) { return document.getElementById(id); };
  var inputSection = $('inputSection'), editorSection = $('editorSection');
  var textInput = $('textInput');
  var originalView = $('originalView'), previewView = $('previewView');
  var personForm = $('personForm'), codenameInput = $('codenameInput'), aliasesInput = $('aliasesInput');
  var personList = $('personList'), exceptionList = $('exceptionList'), statsEl = $('stats');
  var sharedList = $('sharedList');
  var inspectFilters = $('inspectFilters'), inspectList = $('inspectList');
  var mappingBody = document.querySelector('#mappingTable tbody');
  var selPopup = $('selPopup'), popupPerson = $('popupPerson'), popupNewFields = $('popupNewFields');
  var popupCodename = $('popupCodename'), popupAlias = $('popupAlias');
  var mergeDialog = $('mergeDialog'), mergeTargetEl = $('mergeTarget'), mergeSource = $('mergeSource');
  var mergeCodenames = $('mergeCodenames'), mergeAliases = $('mergeAliases'), mergeCounts = $('mergeCounts');
  var batchDialog = $('batchDialog'), batchFrag = $('batchFrag'), batchTargetEl = $('batchTarget');
  var batchTotal = $('batchTotal'), batchOk = $('batchOk');
  var batchClashSel = $('batchClashSel'), batchClashEx = $('batchClashEx');
  var citationList = $('citationList');
  var toastEl = $('toast');

  // ---------- 工具 ----------
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.remove('hidden');
    clearTimeout(toastEl._timer);
    toastEl._timer = setTimeout(function () { toastEl.classList.add('hidden'); }, 2200);
  }

  function parseAliases(raw) {
    return raw.split(/[,，、;；\n]/).map(function (s) { return s.trim(); }).filter(Boolean);
  }

  function personById(id) {
    for (var i = 0; i < state.persons.length; i++) {
      if (state.persons[i].id === id) return state.persons[i];
    }
    return null;
  }

  function exceptionById(id) {
    for (var i = 0; i < state.exceptions.length; i++) {
      if (state.exceptions[i].id === id) return state.exceptions[i];
    }
    return null;
  }

  // ---------- 匿名化引擎（public/anonymize.js，纯函数） ----------
  function anonymize() {
    return Anonymizer.anonymize(state.text, state.persons, state.selections, state.exceptions, state.resolutions);
  }

  // ---------- 渲染 ----------
  // 在 frag（匿名映射区间，互不重叠）与 marks（巡检候选投影区间，互不重叠）的并集
  // 边界处切分文本，生成 span / 文本节点；同一字符可同时落在 frag 与 mark 中。
  function renderView(container, text, intervals, marks) {
    container.innerHTML = '';
    var bounds = [0, text.length];
    intervals.forEach(function (iv) { bounds.push(iv.start, iv.end); });
    marks.forEach(function (mk) { bounds.push(mk.start, mk.end); });
    var uniq = bounds.slice().sort(function (a, b) { return a - b; })
      .filter(function (b, i, arr) { return i === 0 || b !== arr[i - 1]; });

    function findIv(start, end) {
      for (var i = 0; i < intervals.length; i++) {
        if (intervals[i].start <= start && end <= intervals[i].end) return intervals[i];
      }
      return null;
    }
    function findMk(start, end) {
      for (var i = 0; i < marks.length; i++) {
        if (marks[i].start <= start && end <= marks[i].end) return marks[i];
      }
      return null;
    }

    var node;
    for (var k = 0; k + 1 < uniq.length; k++) {
      var s = uniq[k], e = uniq[k + 1];
      if (e <= s) continue;
      var iv = findIv(s, e);
      var mk = findMk(s, e);
      var fragEl = null;
      if (iv) {
        fragEl = document.createElement('span');
        fragEl.className = 'frag' + (iv.kind === 'keep' ? ' keep' : (iv.explicit ? ' explicit' : ''));
        fragEl.dataset.mid = iv.id;
        fragEl.style.background = iv.color;
        node = fragEl;
      } else {
        node = document.createTextNode('');
      }
      if (mk) {
        var markEl = document.createElement('span');
        markEl.className = 'mark st-' + mk.status;
        markEl.dataset.cids = mk.cids.join(' ');
        markEl.textContent = text.slice(s, e);
        if (fragEl) fragEl.appendChild(markEl); else node = markEl;
      } else {
        if (fragEl) fragEl.textContent = text.slice(s, e); else node.nodeValue = text.slice(s, e);
      }
      container.appendChild(fragEl || node);
    }
  }

  // 通过最终匿名映射把原稿字符偏移换算为预览字符偏移
  // 落在替换项起点上的偏移优先归到替换项内部（映射区间为左闭右开）
  function origOffsetToPreview(off, map, previewLen) {
    var i;
    for (i = 0; i < map.length; i++) {
      var m = map[i];
      if (off < m.oStart) return off + (m.pStart - m.oStart); // 在该映射之前的原文空隙
      if (off >= m.oStart && off < m.oEnd) {
        return m.kind === 'replace' ? m.pStart + Math.min(off - m.oStart, m.pEnd - m.pStart) : m.pStart + (off - m.oStart);
      }
    }
    return previewLen - (state.text.length - off); // 末段空隙
  }

  // 把巡检候选投影到预览：已匿名处收敛为代号位置，其余按原长度投影，
  // 合并重叠/相邻的投影段并取最高严重级（leaking＞kept＞anonymized）
  function projectCandidatesToPreview(cands, map, previewLen) {
    var STATUS_RANK = { leaking: 0, kept: 1, anonymized: 2 };
    var segs = [];
    cands.forEach(function (c) {
      var ps = origOffsetToPreview(c.start, map, previewLen);
      var pe = origOffsetToPreview(c.end, map, previewLen);
      if (pe <= ps) pe = ps + 1; // 已被整体替换时退化为代号处的 1 字符标记
      segs.push({ start: ps, end: pe, status: c.status, cid: c.cid });
    });
    segs.sort(function (a, b) { return a.start - b.start || a.end - b.end; });
    var out = [];
    segs.forEach(function (g) {
      var last = out[out.length - 1];
      if (last && g.start <= last.end) {
        last.end = Math.max(last.end, g.end);
        if (STATUS_RANK[g.status] < STATUS_RANK[last.status]) last.status = g.status;
        if (last.cids.indexOf(g.cid) === -1) last.cids.push(g.cid);
      } else {
        out.push({ start: g.start, end: g.end, status: g.status, cids: [g.cid] });
      }
    });
    return out;
  }

  function computeInspect(map) {
    // 随原稿一次性扫描的候选在此判级；candidate 顺序在加载时确定，cid 即下标
    state.inspect = Anonymizer.classifyCandidates(state.candidates, map).map(function (c, i) {
      c.cid = i;
      return c;
    });
  }

  function render() {
    computeShared(); // 先重算共享称呼冲突并清理失效裁决，再进入匿名化
    var result = anonymize();
    state.currentPreview = result.preview;
    state.currentMap = result.map;
    computeInspect(result.map);

    // 当前仍在预览中生效的例外（未被显式框选完全覆盖）
    var activeExIds = {};
    result.map.forEach(function (m) { if (m.kind === 'keep') activeExIds[m.exId] = true; });

    // 原稿侧区间
    var oIntervals = result.map.map(function (m) {
      var p = personById(m.personId);
      return { id: m.id, start: m.oStart, end: m.oEnd, kind: m.kind, explicit: m.explicit, color: p ? p.color : '' };
    });
    // 预览侧区间（同一 id，实现双向对应）
    var pIntervals = result.map.map(function (m) {
      var p = personById(m.personId);
      return { id: m.id, start: m.pStart, end: m.pEnd, kind: m.kind, explicit: m.explicit, color: p ? p.color : '' };
    });

    // 巡检标记（原稿候选互不重叠；预览侧需合并投影）
    var oMarks = state.inspect.map(function (c) {
      return { start: c.start, end: c.end, status: c.status, cids: [c.cid] };
    });
    var pMarks = projectCandidatesToPreview(state.inspect, result.map, result.preview.length);

    renderView(originalView, state.text, oIntervals, oMarks);
    renderView(previewView, result.preview, pIntervals, pMarks);
    renderPersons();
    renderShared();
    renderInspect();
    renderExceptions(activeExIds);
    renderMapping(result.map);
    renderStats(result.map);
    renderCitations(result.map);

    $('btnUndo').disabled = state.history.length === 0;
    $('btnCopy').disabled = !state.text;
  }

  function renderPersons() {
    personList.innerHTML = '';
    state.persons.forEach(function (p) {
      var li = document.createElement('li');
      li.className = 'person-item';

      var head = document.createElement('div');
      head.className = 'person-head';
      var dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = p.color;
      var name = document.createElement('span');
      name.className = 'codename';
      name.textContent = p.codename;
      var merge = document.createElement('button');
      merge.className = 'merge';
      merge.title = '把另一人物合并进「' + p.codename + '」（可撤销）';
      merge.textContent = '合并';
      merge.addEventListener('click', function () { openMergeDialog(p.id); });
      var del = document.createElement('button');
      del.className = 'del';
      del.title = '删除该人物及其规则（可撤销）';
      del.textContent = '×';
      del.addEventListener('click', function () { removePerson(p.id); });
      head.appendChild(dot); head.appendChild(name); head.appendChild(merge); head.appendChild(del);
      li.appendChild(head);

      var tags = document.createElement('div');
      tags.className = 'alias-tags';
      if (p.aliases.length) {
        p.aliases.forEach(function (a) {
          var t = document.createElement('span');
          t.className = 'alias-tag';
          t.textContent = a;
          tags.appendChild(t);
        });
      } else {
        var em = document.createElement('span');
        em.className = 'alias-empty';
        em.textContent = '（未登记称呼，仅框选生效）';
        tags.appendChild(em);
      }
      li.appendChild(tags);
      personList.appendChild(li);
    });
  }

  // ---------- 共享称呼裁决 ----------
  // 同一称呼登记在多位人物名下即冲突：未裁决的冲突称呼不参与自动替换（不再由人物
  // 列表顺序暗中决定代号）；裁决后归属人物的命中按既有优先级（框选 ＞ 例外 ＞ 最长
  // 称呼）进入预览与映射。每次渲染重算冲突集合，并清除失效裁决：归属人物已不在候选
  // 集合中（人物删除/合并），或冲突已消失（仅剩一位候选，恢复唯一归属、自动参与替换）。
  function computeShared() {
    state.sharedAliases = Anonymizer.detectSharedAliases(state.text, state.persons);
    var ownerSets = Object.create(null);
    state.sharedAliases.forEach(function (c) { ownerSets[c.alias] = c.personIds; });
    Object.keys(state.resolutions).forEach(function (alias) {
      var owners = ownerSets[alias];
      if (!owners || owners.indexOf(state.resolutions[alias]) === -1) {
        delete state.resolutions[alias]; // 失效裁决：冲突消失或归属人物已退出候选集合
      }
    });
  }

  function resolutionOf(alias) {
    return Object.prototype.hasOwnProperty.call(state.resolutions, alias)
      ? state.resolutions[alias] : null;
  }

  // 为冲突称呼选定归属人物（personId 为 null 表示取消裁决、恢复不参与自动替换）
  function resolveAlias(alias, personId) {
    var conflict = state.sharedAliases.filter(function (c) { return c.alias === alias; })[0];
    if (!conflict) return;
    if (personId != null && conflict.personIds.indexOf(personId) === -1) return;
    var prev = resolutionOf(alias);
    if (prev === personId) return;
    if (personId == null) delete state.resolutions[alias];
    else state.resolutions[alias] = personId;
    // 裁决（含改选、取消）作为一条记录进入撤销栈
    state.history.push({ type: 'resolveAlias', alias: alias, prev: prev, next: personId });
    render();
    if (personId == null) {
      toast('已取消称呼「' + alias + '」的裁决，该称呼暂不参与自动替换，可撤销');
    } else {
      var p = personById(personId);
      toast('已将称呼「' + alias + '」裁决给「' + (p ? p.codename : '?') + '」，可撤销');
    }
  }

  function renderShared() {
    sharedList.innerHTML = '';
    if (!state.sharedAliases.length) {
      var empty = document.createElement('li');
      empty.className = 'shared-empty';
      empty.textContent = '（暂无共享称呼冲突）';
      sharedList.appendChild(empty);
      return;
    }
    state.sharedAliases.forEach(function (c) {
      var resolvedId = resolutionOf(c.alias);
      var li = document.createElement('li');
      li.className = 'shared-item ' + (resolvedId == null ? 'shared-pending' : 'shared-resolved');

      var row = document.createElement('div');
      row.className = 'shared-row';
      var aliasEl = document.createElement('span');
      aliasEl.className = 'shared-alias';
      aliasEl.textContent = c.alias;
      aliasEl.title = c.alias;
      var hits = document.createElement('span');
      hits.className = 'shared-hits';
      hits.textContent = '原稿命中 ' + c.hits + ' 处';
      row.appendChild(aliasEl);
      row.appendChild(hits);
      li.appendChild(row);

      // 候选人物下拉：占位项为「未裁决」，其余为各候选人物代号
      var select = document.createElement('select');
      select.className = 'shared-select';
      var o0 = document.createElement('option');
      o0.value = '';
      o0.textContent = '（未裁决：不参与自动替换）';
      select.appendChild(o0);
      c.personIds.forEach(function (pid) {
        var p = personById(pid);
        if (!p) return;
        var o = document.createElement('option');
        o.value = pid;
        o.textContent = '归属：' + p.codename;
        select.appendChild(o);
      });
      select.value = resolvedId == null ? '' : String(resolvedId);
      select.addEventListener('change', function () {
        resolveAlias(c.alias, select.value === '' ? null : Number(select.value));
      });
      li.appendChild(select);

      var meta = document.createElement('div');
      meta.className = 'shared-meta';
      if (resolvedId == null) {
        meta.textContent = '待裁决：该称呼的命中暂不替换，人物顺序不再暗中决定归属';
      } else {
        var rp = personById(resolvedId);
        meta.textContent = '已归属「' + (rp ? rp.codename : '?') +
          '」，命中按既有优先级进入预览与映射';
      }
      li.appendChild(meta);

      sharedList.appendChild(li);
    });
  }

  // ---------- 敏感信息巡检 ----------
  var activeCid = null; // 当前联动定位的候选 cid
  var INSPECT_TYPE_NAME = { idcard: '身份证', email: '邮箱', phone: '手机号' };
  var INSPECT_STATUS_NAME = { leaking: '仍泄漏', kept: '保留原文', anonymized: '已匿名' };
  var INSPECT_FILTERS = [
    { key: 'all', label: '全部' },
    { key: 'leaking', label: '仍泄漏' },
    { key: 'kept', label: '保留原文' },
    { key: 'anonymized', label: '已匿名' }
  ];

  function inspectCounts() {
    var n = { all: state.inspect.length, leaking: 0, kept: 0, anonymized: 0 };
    state.inspect.forEach(function (c) { n[c.status]++; });
    return n;
  }

  function renderInspect() {
    var counts = inspectCounts();
    inspectFilters.innerHTML = '';
    INSPECT_FILTERS.forEach(function (f) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'inspect-filter' + (state.inspectFilter === f.key ? ' on' : '');
      var label = document.createElement('span');
      label.textContent = f.label;
      var count = document.createElement('span');
      count.className = 'count' + (f.key !== 'all' ? ' badge-' + f.key : '');
      count.textContent = counts[f.key];
      btn.appendChild(label);
      btn.appendChild(count);
      btn.addEventListener('click', function () {
        state.inspectFilter = f.key;
        renderInspect();
      });
      inspectFilters.appendChild(btn);
    });

    inspectList.innerHTML = '';
    var rows = state.inspect.filter(function (c) {
      return state.inspectFilter === 'all' || c.status === state.inspectFilter;
    });
    if (!state.inspect.length) {
      var empty = document.createElement('li');
      empty.className = 'inspect-empty';
      empty.textContent = '（原稿中未发现手机号、邮箱或合法身份证号）';
      inspectList.appendChild(empty);
      return;
    }
    if (!rows.length) {
      var none = document.createElement('li');
      none.className = 'inspect-empty';
      none.textContent = '（当前筛选下暂无候选）';
      inspectList.appendChild(none);
      return;
    }
    rows.forEach(function (c) {
      var li = document.createElement('li');
      li.className = 'inspect-item st-' + c.status + (activeCid === c.cid ? ' inspect-active' : '');
      li.dataset.cid = c.cid;

      var row = document.createElement('div');
      row.className = 'inspect-row';
      var type = document.createElement('span');
      type.className = 'inspect-type';
      type.textContent = INSPECT_TYPE_NAME[c.type];
      var frag = document.createElement('span');
      frag.className = 'inspect-frag';
      frag.textContent = c.value;
      frag.title = c.value + '\n点击在原稿 / 预览中定位';
      var st = document.createElement('span');
      st.className = 'inspect-status';
      st.textContent = INSPECT_STATUS_NAME[c.status];
      row.appendChild(type); row.appendChild(frag); row.appendChild(st);
      li.appendChild(row);

      var meta = document.createElement('div');
      meta.className = 'inspect-meta';
      meta.textContent = '原稿区间 [' + c.start + ', ' + c.end + ')' +
        (c.status === 'leaking' ? ' ｜ 仍泄漏 ' + c.leakRanges.length + ' 段' : '');
      li.appendChild(meta);

      // 单个仍泄漏项：选择已有人物后，按泄漏子区间补显式框选（整次操作一条撤销记录）
      if (c.status === 'leaking') {
        var assign = document.createElement('div');
        assign.className = 'inspect-assign';
        var select = document.createElement('select');
        if (!state.persons.length) {
          var o0 = document.createElement('option');
          o0.textContent = '（请先在上方添加人物）';
          select.appendChild(o0);
          select.disabled = true;
        } else {
          state.persons.forEach(function (p) {
            var o = document.createElement('option');
            o.value = p.id;
            o.textContent = p.codename;
            select.appendChild(o);
          });
        }
        var btn = document.createElement('button');
        btn.className = 'btn btn-mini';
        btn.textContent = '指派给人物';
        btn.disabled = !state.persons.length;
        btn.title = '把仍泄漏的部分补为该人物的显式框选（已被框选覆盖的子区间不重复添加；可撤销）';
        btn.addEventListener('click', function () { assignLeak(c.cid, Number(select.value)); });
        assign.appendChild(select);
        assign.appendChild(btn);
        li.appendChild(assign);
      }

      li.addEventListener('click', function (e) {
        if (e.target.closest('.inspect-assign')) return; // 操作控件不触发定位
        activateCandidate(c.cid, true);
      });
      inspectList.appendChild(li);
    });
  }

  function assignLeak(cid, personId) {
    var c = state.inspect.filter(function (x) { return x.cid === cid; })[0];
    var p = personById(personId);
    if (!c || !p || c.status !== 'leaking' || !c.leakRanges.length) return;
    // 只新增不与既有框选重叠的泄漏子区间；其余按既有框选裁定
    var added = [];
    c.leakRanges.forEach(function (r) {
      var clash = state.selections.some(function (s) { return r[0] < s.end && r[1] > s.start; });
      if (clash) return;
      var sel = { id: selSeq++, start: r[0], end: r[1], personId: personId };
      state.selections.push(sel);
      added.push(sel);
    });
    if (!added.length) { toast('泄漏区间已被其他框选覆盖，刷新后再看'); render(); return; }
    state.history.push({ type: 'inspectAssign', selections: added });
    render();
    toast('已把「' + c.value + '」的 ' + added.length + ' 段泄漏内容指派给「' + p.codename + '」，可撤销');
  }

  // 巡检联动：原稿与预览中同步高亮该候选，并联动侧栏条目
  function clearActiveCandidate() {
    document.querySelectorAll('.mark.m-active').forEach(function (el) { el.classList.remove('m-active'); });
    document.querySelectorAll('.inspect-item.inspect-active').forEach(function (el) {
      el.classList.remove('inspect-active');
    });
  }

  function activateCandidate(cid, scroll) {
    clearActive();
    clearActiveCandidate();
    activeCid = cid;
    // 若候选因当前筛选被隐藏，切回「全部」并重渲染侧栏
    var row = inspectList.querySelector('.inspect-item[data-cid="' + cid + '"]');
    if (!row && state.inspectFilter !== 'all') {
      state.inspectFilter = 'all';
      renderInspect();
      row = inspectList.querySelector('.inspect-item[data-cid="' + cid + '"]');
    }
    var targets = document.querySelectorAll('.mark[data-cids~="' + cid + '"]');
    targets.forEach(function (el) { el.classList.add('m-active'); });
    if (row) {
      row.classList.add('inspect-active');
      if (scroll) row.scrollIntoView({ block: 'nearest' });
    }
    if (scroll && targets.length) {
      targets[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function renderExceptions(activeExIds) {
    exceptionList.innerHTML = '';
    if (!state.exceptions.length) {
      var empty = document.createElement('li');
      empty.className = 'exception-empty';
      empty.textContent = '（暂无例外，去映射表标记称呼命中吧）';
      exceptionList.appendChild(empty);
      return;
    }
    // 按原稿位置排序展示
    state.exceptions.slice().sort(function (a, b) { return a.start - b.start; }).forEach(function (x) {
      var p = personById(x.personId);
      var li = document.createElement('li');
      li.className = 'exception-item' + (activeExIds[x.id] ? '' : ' exception-covered');

      var row = document.createElement('div');
      row.className = 'exception-row';
      var frag = document.createElement('span');
      frag.className = 'exception-frag';
      frag.title = '点击定位原稿位置';
      frag.textContent = state.text.slice(x.start, x.end);
      frag.addEventListener('click', function () { locateException(x.id); });

      var restore = document.createElement('button');
      restore.className = 'exception-restore';
      restore.title = '删除该例外、恢复匿名（可撤销）';
      restore.textContent = '恢复匿名';
      restore.addEventListener('click', function () { restoreException(x.id); });
      row.appendChild(frag);
      row.appendChild(restore);
      li.appendChild(row);

      var meta = document.createElement('div');
      meta.className = 'exception-meta';
      var metaText = '来源人物：' + (p ? p.codename : '（已删除）') +
        ' ｜ 区间 [' + x.start + ', ' + x.end + ')';
      if (!activeExIds[x.id]) metaText += ' ｜ 已被显式框选完全覆盖';
      meta.textContent = metaText;
      li.appendChild(meta);

      exceptionList.appendChild(li);
    });
  }

  function renderMapping(map) {
    mappingBody.innerHTML = '';
    map.forEach(function (m, i) {
      var p = personById(m.personId);
      var tr = document.createElement('tr');
      tr.dataset.mid = m.id;
      if (m.kind === 'keep') tr.classList.add('row-keep');
      var cells = [
        String(i + 1),
        p ? p.codename : '（已删除）',
        null, // 来源
        '[' + m.oStart + ', ' + m.oEnd + ')',
        state.text.slice(m.oStart, m.oEnd),
        '[' + m.pStart + ', ' + m.pEnd + ')',
        state.currentPreview.slice(m.pStart, m.pEnd),
        null  // 操作
      ];
      cells.forEach(function (c, ci) {
        var td = document.createElement('td');
        if (ci === 2) {
          if (m.kind === 'keep') {
            td.textContent = '保留原文例外';
            td.className = 'src-keep';
          } else {
            td.textContent = m.explicit ? '显式框选' : '称呼命中';
            td.className = m.explicit ? 'src-explicit' : 'src-alias';
          }
        } else if (ci === 7) {
          // 操作列：自动称呼命中可标为例外；例外片段可恢复匿名
          var btn = document.createElement('button');
          btn.className = 'btn btn-mini';
          if (m.kind === 'keep') {
            btn.textContent = '恢复匿名';
            btn.addEventListener('click', function () { restoreException(m.exId); });
          } else if (!m.explicit) {
            btn.textContent = '保留原文';
            btn.title = '将此处称呼命中标为「保留原文」例外';
            btn.addEventListener('click', function () { markException(m); });
          } else {
            btn.textContent = '—';
            btn.disabled = true;
            btn.title = '显式框选不能标为例外';
          }
          td.appendChild(btn);
        } else {
          td.textContent = c;
        }
        tr.appendChild(td);
      });
      tr.addEventListener('click', function (e) {
        if (e.target.closest('button')) return; // 点操作按钮不触发行定位
        activate(m.id, true);
      });
      mappingBody.appendChild(tr);
    });
  }

  function renderStats(map) {
    var explicit = map.filter(function (m) { return m.explicit; }).length;
    var keeps = map.filter(function (m) { return m.kind === 'keep'; }).length;
    var aliases = map.length - explicit - keeps;
    var covered = state.exceptions.length -
      state.exceptions.filter(function (x) {
        return map.some(function (m) { return m.kind === 'keep' && m.exId === x.id; });
      }).length;
    var stats = '人物 ' + state.persons.length + ' 位 ｜ 共处理 ' + map.length +
      ' 处（框选 ' + explicit + ' · 称呼 ' + aliases + ' · 保留原文 ' + keeps + '）';
    if (state.sharedAliases.length) {
      var pendingShared = state.sharedAliases.filter(function (c) {
        return resolutionOf(c.alias) == null;
      }).length;
      stats += ' ｜ 共享称呼 ' + state.sharedAliases.length + ' 个（待裁决 ' + pendingShared + '）';
    }
    if (state.exceptions.length) {
      stats += ' ｜ 例外 ' + state.exceptions.length + ' 条';
      if (covered) stats += '（其中 ' + covered + ' 条被框选完全覆盖）';
    }
    if (state.inspect.length) {
      var leakN = state.inspect.filter(function (c) { return c.status === 'leaking'; }).length;
      var keptN = state.inspect.filter(function (c) { return c.status === 'kept'; }).length;
      stats += ' ｜ 敏感信息 ' + state.inspect.length + ' 处（仍泄漏 ' + leakN +
        ' · 保留原文 ' + keptN + ' · 已匿名 ' + (state.inspect.length - leakN - keptN) + '）';
    }
    statsEl.textContent = stats;
  }

  // ---------- 引文 ----------
  // 引文只保存原稿非空半开区间 [start,end)（UTF-16 计数，与框选一致），按添加顺序排列；
  // 引文正文由引擎 buildCitation 依据「当前最终映射」实时生成：
  // 未替换段 / 保留原文段只截取区间内字符；与替换段有交集就输出完整代号，
  // 边界落在替换段内部也不带入区间外原文。多条引文独立计算，允许重叠。
  function buildCurrentCitation(c, map) {
    return Anonymizer.buildCitation(state.text, c.start, c.end, state.persons, map);
  }

  function renderCitations(map) {
    citationList.innerHTML = '';
    if (!state.citations.length) {
      var empty = document.createElement('li');
      empty.className = 'citation-empty';
      empty.textContent = '（暂无引文：在原稿框选片段后，于弹窗点「加入引文」）';
      citationList.appendChild(empty);
    } else {
      state.citations.forEach(function (c, i) {
        var li = document.createElement('li');
        li.className = 'citation-item';

        var row = document.createElement('div');
        row.className = 'citation-row';
        var idx = document.createElement('span');
        idx.className = 'citation-idx';
        idx.textContent = String(i + 1);
        var body = document.createElement('span');
        body.className = 'citation-body';
        body.textContent = buildCurrentCitation(c, map);
        body.title = '点击在原稿 / 预览中定位该引文区间';
        var del = document.createElement('button');
        del.className = 'citation-del';
        del.title = '删除该引文（不影响人物规则、框选与例外）';
        del.textContent = '删除';
        del.addEventListener('click', function () { removeCitation(c.id); });
        row.appendChild(idx);
        row.appendChild(body);
        row.appendChild(del);
        li.appendChild(row);

        var meta = document.createElement('div');
        meta.className = 'citation-meta';
        meta.textContent = '原稿区间 [' + c.start + ', ' + c.end + ')';
        li.appendChild(meta);

        // 点击正文定位该引文区间（按区间中点所在映射段高亮）
        body.addEventListener('click', function () { locateOffsets(c.start, c.end); });

        citationList.appendChild(li);
      });
    }
    $('citationCount').textContent = '共 ' + state.citations.length + ' 条';
    $('btnDownloadCitations').disabled = !state.citations.length;
  }

  function addCitation(start, end) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start ||
      start < 0 || end > state.text.length) {
      toast('引文区间必须是非空且落在原稿内的半开区间');
      return false;
    }
    state.citations.push({ id: citSeq++, start: start, end: end });
    render();
    toast('已加入引文（第 ' + state.citations.length + ' 条），随规则变化实时重算');
    return true;
  }

  function removeCitation(id) {
    state.citations = state.citations.filter(function (c) { return c.id !== id; });
    render();
  }

  // 下载按列表顺序、空行分隔的 UTF-8 TXT，只含引文正文（不加序号与额外标记）
  function downloadCitations(map) {
    var content = state.citations.map(function (c) {
      return buildCurrentCitation(c, map);
    }).join('\n\n');
    var blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'citations.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 0);
  }

  // ---------- 双向高亮 ----------
  function clearActive() {
    document.querySelectorAll('.frag.active').forEach(function (el) { el.classList.remove('active'); });
  }

  function activate(mid, scroll) {
    clearActive();
    var targets = document.querySelectorAll('.frag[data-mid="' + mid + '"]');
    targets.forEach(function (el) { el.classList.add('active'); });
    if (scroll && targets.length) {
      targets.forEach(function (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    }
  }

  // 在两个视图中定位覆盖某原稿位置的片段
  function locateOffsets(start, end) {
    var hit = state.currentMap.find(function (m) {
      return m.oStart <= start && m.oEnd >= end;
    }) || state.currentMap.find(function (m) {
      return start < m.oEnd && end > m.oStart;
    });
    if (hit) activate(hit.id, true);
  }

  function locateException(exId) {
    var x = exceptionById(exId);
    if (!x) return;
    var m = state.currentMap.find(function (mm) { return mm.kind === 'keep' && mm.exId === exId; });
    if (m) { activate(m.id, true); return; }
    // 被框选完全覆盖时，定位覆盖它的框选片段
    locateOffsets(x.start, x.end);
  }

  [originalView, previewView].forEach(function (view) {
    view.addEventListener('click', function (e) {
      var mark = e.target.closest('.mark');
      if (mark) {
        // 优先联动巡检候选；预览侧合并标记取第一个 cid
        activateCandidate(Number(mark.dataset.cids.split(/\s+/)[0]), true);
        return;
      }
      var frag = e.target.closest('.frag');
      if (!frag) { clearActive(); return; }
      activate(frag.dataset.mid, true);
    });
    // 悬停时联动另一侧
    view.addEventListener('mouseover', function (e) {
      document.querySelectorAll('.frag.match').forEach(function (el) { el.classList.remove('match'); });
      document.querySelectorAll('.mark.m-match').forEach(function (el) { el.classList.remove('m-match'); });
      var mark = e.target.closest('.mark');
      if (mark) {
        var cids = mark.dataset.cids.split(/\s+/);
        cids.forEach(function (cid) {
          document.querySelectorAll('.mark[data-cids~="' + cid + '"]').forEach(function (el) {
            if (el !== mark) el.classList.add('m-match');
          });
        });
        return;
      }
      var frag = e.target.closest('.frag');
      if (!frag) return;
      document.querySelectorAll('.frag[data-mid="' + frag.dataset.mid + '"]').forEach(function (el) {
        if (el !== frag) el.classList.add('match');
      });
    });
    view.addEventListener('mouseleave', function () {
      document.querySelectorAll('.frag.match').forEach(function (el) { el.classList.remove('match'); });
      document.querySelectorAll('.mark.m-match').forEach(function (el) { el.classList.remove('m-match'); });
    });
  });

  // ---------- 规则操作 ----------
  function createPerson(codename, aliases) {
    var person = {
      id: personSeq++,
      codename: codename,
      aliases: aliases,
      color: PALETTE[(personSeq - 2) % PALETTE.length]
    };
    state.persons.push(person);
    return person;
  }

  function addPerson(codename, aliases, recordHistory) {
    var person = createPerson(codename, aliases);
    if (recordHistory !== false) state.history.push({ type: 'person', person: person });
    render();
    return person;
  }

  function addSelection(personId, start, end) {
    var clash = state.selections.some(function (s) { return start < s.end && end > s.start; });
    if (clash) { toast('所选区间与已有框选重叠'); return false; }
    var sel = { id: selSeq++, start: start, end: end, personId: personId };
    state.selections.push(sel);
    state.history.push({ type: 'selection', selection: sel });
    render();
    return true;
  }

  function removePerson(id) {
    var person = personById(id);
    if (!person) return;
    var removedSels = state.selections.filter(function (s) { return s.personId === id; });
    var removedExs = state.exceptions.filter(function (x) { return x.personId === id; });
    state.persons = state.persons.filter(function (p) { return p.id !== id; });
    state.selections = state.selections.filter(function (s) { return s.personId !== id; });
    state.exceptions = state.exceptions.filter(function (x) { return x.personId !== id; });
    // 人物删除进入撤销栈（连同其框选与例外一起恢复）
    state.history.push({
      type: 'removePerson',
      person: person,
      selections: removedSels,
      exceptions: removedExs
    });
    render();
    toast('已删除人物「' + person.codename + '」，可撤销');
  }

  // ---------- 合并人物 ----------
  // 目标人物保留；源人物的称呼（去重后）、框选与例外统一改绑到目标人物，源人物删除。
  // 重叠称呼仍由引擎按「最长称呼优先」处理，无需额外规则。
  var mergeTargetId = null; // 弹窗当前的目标人物 id

  function dedupAliases(target, source) {
    var merged = target.aliases.slice();
    source.aliases.forEach(function (a) {
      if (merged.indexOf(a) === -1) merged.push(a);
    });
    return merged;
  }

  function openMergeDialog(targetId) {
    var target = personById(targetId);
    if (!target) return;
    if (state.persons.length < 2) { toast('至少需要两位人物才能合并'); return; }
    mergeTargetId = targetId;
    mergeTargetEl.textContent = target.codename;
    // 源人物下拉：除目标外的所有人物
    mergeSource.innerHTML = '';
    state.persons.forEach(function (p) {
      if (p.id === targetId) return;
      var o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.codename;
      mergeSource.appendChild(o);
    });
    updateMergePreview();
    mergeDialog.classList.remove('hidden');
  }

  function closeMergeDialog() {
    mergeDialog.classList.add('hidden');
    mergeTargetId = null;
  }

  // 弹窗预览：双方代号、去重后的称呼、将迁移的框选与例外数量（随源人物选择实时刷新）
  function updateMergePreview() {
    var target = personById(mergeTargetId);
    var source = personById(Number(mergeSource.value));
    if (!target || !source) return;
    mergeCodenames.textContent = '「' + target.codename + '」（目标，保留）＋「' +
      source.codename + '」（源，合并后删除）';

    var merged = dedupAliases(target, source);
    mergeAliases.innerHTML = '';
    var label = document.createElement('span');
    label.className = 'merge-label';
    label.textContent = '合并后称呼（已去重）：';
    mergeAliases.appendChild(label);
    if (merged.length) {
      merged.forEach(function (a) {
        var t = document.createElement('span');
        t.className = 'alias-tag';
        t.textContent = a;
        mergeAliases.appendChild(t);
      });
    } else {
      var em = document.createElement('span');
      em.className = 'alias-empty';
      em.textContent = '（双方均未登记称呼，仅框选生效）';
      mergeAliases.appendChild(em);
    }

    var selCount = state.selections.filter(function (s) { return s.personId === source.id; }).length;
    var exCount = state.exceptions.filter(function (x) { return x.personId === source.id; }).length;
    mergeCounts.textContent = '将迁移到目标人物：框选 ' + selCount + ' 处 ｜ 保留原文例外 ' + exCount + ' 条';
  }

  function mergePerson(targetId, sourceId) {
    var target = personById(targetId);
    var source = personById(sourceId);
    if (!target || !source || target === source) return;
    var sourceIndex = state.persons.indexOf(source);
    var targetAliasesBefore = target.aliases.slice();
    // 保留对象引用：撤销时按引用把 personId 改回源人物
    var movedSels = state.selections.filter(function (s) { return s.personId === sourceId; });
    var movedExs = state.exceptions.filter(function (x) { return x.personId === sourceId; });

    target.aliases = dedupAliases(target, source);
    movedSels.forEach(function (s) { s.personId = targetId; });
    movedExs.forEach(function (x) { x.personId = targetId; });
    state.persons = state.persons.filter(function (p) { return p.id !== sourceId; });

    // 整次合并作为一条原子记录进入撤销栈
    state.history.push({
      type: 'mergePerson',
      targetId: targetId,
      targetAliasesBefore: targetAliasesBefore,
      source: source,
      sourceIndex: sourceIndex,
      selections: movedSels,
      exceptions: movedExs
    });
    render();
    toast('已将「' + source.codename + '」合并进「' + target.codename + '」，可撤销');
  }

  // ---------- 保留原文例外 ----------
  function markException(mapItem) {
    if (mapItem.kind !== 'replace' || mapItem.explicit) return;
    var start = mapItem.oStart, end = mapItem.oEnd, personId = mapItem.personId;
    var clash = state.exceptions.some(function (x) {
      return start < x.end && end > x.start && x.personId === personId;
    });
    if (clash) { toast('该片段已被同人物的其他例外覆盖'); return; }
    var ex = { id: excSeq++, start: start, end: end, personId: personId };
    state.exceptions.push(ex);
    state.history.push({ type: 'exception', exception: ex });
    render();
    toast('已标记保留原文：' + state.text.slice(start, end));
  }

  function restoreException(id) {
    var ex = exceptionById(id);
    if (!ex) return;
    state.exceptions = state.exceptions.filter(function (x) { return x.id !== id; });
    // 恢复匿名同样进入撤销栈（可再撤销以重新保留）
    state.history.push({ type: 'restore', exception: ex });
    render();
    toast('已恢复匿名：' + state.text.slice(ex.start, ex.end));
  }

  // ---------- 批量同文片段指派 ----------
  // 框选弹窗中点「批量指派全文相同片段…」后打开确认弹窗：
  // 匹配与冲突分类由引擎 Anonymizer.planBatchAssign 完成（左到右、互不重叠；
  // 框选冲突 > 例外冲突 > 可处理，互斥归类）。确认后只为「可处理」匹配新增显式框选，
  // 冲突匹配一律跳过、不覆盖原有区间；整批（含随批量新建的人物）作为一条撤销记录。
  var pendingBatch = null; // { personId|null, newPerson:{codename,aliases}|null, plan }

  function openBatchDialog() {
    if (!pendingSel) return;
    var personId = null, newPerson = null, targetName = '';
    if (popupPerson.value === '__new') {
      var codename = popupCodename.value.trim();
      if (!codename) { toast('请先填写新建人物的统一代号'); return; }
      newPerson = { codename: codename, aliases: parseAliases(popupAlias.value) };
      targetName = '新建人物「' + codename + '」';
    } else {
      var p = personById(Number(popupPerson.value));
      if (!p) { toast('请先选择目标人物'); return; }
      personId = p.id;
      targetName = '「' + p.codename + '」';
    }
    var frag = state.text.slice(pendingSel.start, pendingSel.end);
    var plan = Anonymizer.planBatchAssign(state.text, frag, state.selections, state.exceptions);
    pendingBatch = { personId: personId, newPerson: newPerson, plan: plan };

    batchFrag.textContent = frag;
    batchFrag.title = frag;
    batchTargetEl.textContent = '目标人物：' + targetName;
    batchTotal.textContent = '全文相同片段共 ' + plan.total + ' 处（从左到右、互不重叠匹配）';
    batchOk.textContent = '可处理：' + plan.ok.length + ' 处（将新增为显式框选）';
    batchClashSel.textContent = '与既有显式框选冲突：' + plan.clashSelections + ' 处（跳过）';
    batchClashEx.textContent = '与保留原文例外冲突：' + plan.clashExceptions + ' 处（跳过）';
    $('batchConfirm').disabled = plan.ok.length === 0;
    batchDialog.classList.remove('hidden');
  }

  function closeBatchDialog() {
    batchDialog.classList.add('hidden');
    pendingBatch = null;
  }

  function confirmBatch() {
    var batch = pendingBatch;
    if (!batch || !batch.plan.ok.length) return;
    // 目标人物：随批量新建的人物不单独入栈，并入整批记录
    var person = null;
    var personId = batch.personId;
    if (batch.newPerson) {
      person = createPerson(batch.newPerson.codename, batch.newPerson.aliases);
      personId = person.id;
    }
    // 只新增「可处理」匹配，与框选 / 例外冲突的一律跳过，不覆盖原有区间
    var added = batch.plan.ok.map(function (r) {
      var sel = { id: selSeq++, start: r[0], end: r[1], personId: personId };
      state.selections.push(sel);
      return sel;
    });
    // 整批变更作为一条撤销记录
    state.history.push({ type: 'batchAssign', person: person, selections: added });
    closeBatchDialog();
    window.getSelection().removeAllRanges();
    closePopup();
    render();
    var skipped = batch.plan.clashSelections + batch.plan.clashExceptions;
    toast('已批量新增 ' + added.length + ' 处框选' +
      (skipped ? '，跳过冲突 ' + skipped + ' 处' : '') + '，可撤销');
  }

  function undo() {
    var action = state.history.pop();
    if (!action) return;
    switch (action.type) {
      case 'person':
        state.persons = state.persons.filter(function (p) { return p.id !== action.person.id; });
        state.selections = state.selections.filter(function (s) { return s.personId !== action.person.id; });
        state.exceptions = state.exceptions.filter(function (x) { return x.personId !== action.person.id; });
        toast('已撤销人物「' + action.person.codename + '」');
        break;
      case 'selection':
        state.selections = state.selections.filter(function (s) { return s.id !== action.selection.id; });
        toast('已撤销一次框选');
        break;
      case 'exception':
        state.exceptions = state.exceptions.filter(function (x) { return x.id !== action.exception.id; });
        toast('已撤销保留原文标记');
        break;
      case 'restore':
        if (personById(action.exception.personId)) state.exceptions.push(action.exception);
        toast('已撤销恢复匿名');
        break;
      case 'removePerson':
        state.persons.push(action.person);
        state.selections = state.selections.concat(action.selections);
        state.exceptions = state.exceptions.concat(action.exceptions);
        toast('已恢复人物「' + action.person.codename + '」及其规则');
        break;
      case 'mergePerson':
        // 精确恢复：目标称呼还原、关联区间改回源人物、源人物按原 ID 与原列表位置放回
        var mTarget = personById(action.targetId);
        if (mTarget) mTarget.aliases = action.targetAliasesBefore.slice();
        action.selections.forEach(function (s) { s.personId = action.source.id; });
        action.exceptions.forEach(function (x) { x.personId = action.source.id; });
        state.persons.splice(Math.min(action.sourceIndex, state.persons.length), 0, action.source);
        toast('已撤销合并，恢复人物「' + action.source.codename + '」');
        break;
      case 'batchAssign':
        // 整批撤销：移除本批新增的框选，恢复操作前的区间集合与匿名预览；
        // 若目标人物随批量新建，一并移除（连同其后续区间，与撤销添加人物语义一致）
        var batchIds = {};
        action.selections.forEach(function (s) { batchIds[s.id] = true; });
        state.selections = state.selections.filter(function (s) { return !batchIds[s.id]; });
        if (action.person) {
          state.persons = state.persons.filter(function (p) { return p.id !== action.person.id; });
          state.selections = state.selections.filter(function (s) { return s.personId !== action.person.id; });
          state.exceptions = state.exceptions.filter(function (x) { return x.personId !== action.person.id; });
        }
        toast('已撤销批量同文指派（' + action.selections.length + ' 处）');
        break;
      case 'inspectAssign':
        // 巡检指派的撤销：移除本次新增的所有补漏框选，候选恢复「仍泄漏」
        var iaIds = {};
        action.selections.forEach(function (s) { iaIds[s.id] = true; });
        state.selections = state.selections.filter(function (s) { return !iaIds[s.id]; });
        toast('已撤销敏感信息指派（' + action.selections.length + ' 段）');
        break;
      case 'resolveAlias':
        // 共享称呼裁决的撤销：恢复裁决前的归属（原先未裁决则删除该裁决）
        if (action.prev == null) delete state.resolutions[action.alias];
        else state.resolutions[action.alias] = action.prev;
        toast('已撤销称呼「' + action.alias + '」的裁决');
        break;
    }
    render();
  }

  // ---------- 框选 ----------
  var pendingSel = null; // { start, end }

  function selectionOffsets() {
    var sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return null;
    var range = sel.getRangeAt(0);
    if (!originalView.contains(range.startContainer) || !originalView.contains(range.endContainer)) return null;
    var pre = document.createRange();
    pre.selectNodeContents(originalView);
    pre.setEnd(range.startContainer, range.startOffset);
    var start = pre.toString().length;
    var end = start + range.toString().length;
    if (end <= start) return null;
    return { start: start, end: end, rect: range.getBoundingClientRect() };
  }

  function openPopup(info) {
    pendingSel = info;
    // 填充人物下拉
    popupPerson.innerHTML = '';
    var optNew = document.createElement('option');
    optNew.value = '__new';
    optNew.textContent = '＋ 新建人物…';
    popupPerson.appendChild(optNew);
    state.persons.forEach(function (p) {
      var o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.codename;
      popupPerson.appendChild(o);
    });
    popupNewFields.classList.remove('hidden');
    popupCodename.value = '';
    popupAlias.value = state.text.slice(info.start, info.end);

    var x = Math.min(info.rect.left, window.innerWidth - 270);
    var y = info.rect.bottom + 8;
    if (y + 200 > window.innerHeight) y = info.rect.top - 210;
    selPopup.style.left = Math.max(8, x) + 'px';
    selPopup.style.top = Math.max(8, y) + 'px';
    selPopup.classList.remove('hidden');
  }

  function closePopup() {
    selPopup.classList.add('hidden');
    pendingSel = null;
  }

  originalView.addEventListener('mouseup', function () {
    setTimeout(function () {
      var info = selectionOffsets();
      if (info) openPopup(info);
    }, 10);
  });

  popupPerson.addEventListener('change', function () {
    popupNewFields.classList.toggle('hidden', popupPerson.value !== '__new');
  });

  $('popupOk').addEventListener('click', function () {
    if (!pendingSel) return;
    var personId;
    if (popupPerson.value === '__new') {
      var codename = popupCodename.value.trim();
      if (!codename) { toast('请填写统一代号'); return; }
      var aliases = parseAliases(popupAlias.value);
      var person = addPerson(codename, aliases); // 人物规则入历史
      personId = person.id;
    } else {
      personId = Number(popupPerson.value);
    }
    if (addSelection(personId, pendingSel.start, pendingSel.end)) {
      window.getSelection().removeAllRanges();
      closePopup();
    }
  });

  $('popupCancel').addEventListener('click', function () {
    window.getSelection().removeAllRanges();
    closePopup();
  });

  // ---------- 批量同文指派弹窗 ----------
  $('popupBatch').addEventListener('click', openBatchDialog);

  // ---------- 加入引文 ----------
  // 引文与人物指派无关：直接把当前框选的非空半开区间存入引文列表，
  // 正文随最终映射实时重算（框选弹窗随后关闭）
  $('popupCitation').addEventListener('click', function () {
    if (!pendingSel) return;
    if (addCitation(pendingSel.start, pendingSel.end)) {
      window.getSelection().removeAllRanges();
      closePopup();
    }
  });

  $('btnDownloadCitations').addEventListener('click', function () {
    if (!state.citations.length) return;
    downloadCitations(state.currentMap);
  });

  $('batchConfirm').addEventListener('click', confirmBatch);

  $('batchCancel').addEventListener('click', closeBatchDialog);

  batchDialog.addEventListener('mousedown', function (e) {
    if (e.target === batchDialog) {
      closeBatchDialog();     // 点击遮罩关闭（框选弹窗保留，可继续调整）
      e.stopPropagation();    // 阻止 document 的联动关闭逻辑
    }
  });

  document.addEventListener('mousedown', function (e) {
    if (!batchDialog.classList.contains('hidden')) return; // 批量弹窗打开时不联动关闭框选弹窗
    if (!selPopup.classList.contains('hidden') && !selPopup.contains(e.target) && e.target !== originalView) {
      // 点击弹窗以外区域时关闭（在原稿上重新框选会由 mouseup 重新打开）
      if (!originalView.contains(e.target)) closePopup();
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closePopup(); closeMergeDialog(); closeBatchDialog(); }
  });

  // ---------- 合并人物弹窗 ----------
  mergeSource.addEventListener('change', updateMergePreview);

  $('mergeConfirm').addEventListener('click', function () {
    var sourceId = Number(mergeSource.value);
    var targetId = mergeTargetId;
    if (!personById(targetId) || !personById(sourceId)) { closeMergeDialog(); return; }
    closeMergeDialog();
    mergePerson(targetId, sourceId);
  });

  $('mergeCancel').addEventListener('click', closeMergeDialog);

  mergeDialog.addEventListener('mousedown', function (e) {
    if (e.target === mergeDialog) closeMergeDialog(); // 点击遮罩关闭
  });

  // ---------- 顶部操作 ----------
  $('btnLoadText').addEventListener('click', function () {
    var text = textInput.value;
    if (!text.trim()) { toast('请先粘贴访谈原稿'); return; }
    loadText(text);
  });

  function loadText(text) {
    state.text = text;
    state.persons = [];
    state.selections = [];
    state.exceptions = [];
    state.history = [];
    state.citations = []; // 重新加载原稿时清空引文
    state.sharedAliases = [];
    state.resolutions = Object.create(null); // 重新加载原稿时清空共享称呼裁决
    state.candidates = Anonymizer.detectSensitive(text); // 离线一次性扫描，随规则变化只重判级
    state.inspect = [];
    state.inspectFilter = 'all';
    activeCid = null;
    closeMergeDialog();
    closeBatchDialog();
    inputSection.classList.add('hidden');
    editorSection.classList.remove('hidden');
    $('btnResetText').classList.remove('hidden');
    render();
    if (state.candidates.length) {
      toast('巡检发现 ' + state.candidates.length + ' 处疑似敏感信息（手机号 / 邮箱 / 身份证）');
    }
  }

  $('btnResetText').addEventListener('click', function () {
    if ((state.persons.length || state.selections.length || state.exceptions.length || state.citations.length) &&
        !window.confirm('重新粘贴将清空当前所有人物规则、框选、例外与引文，确定继续？')) return;
    textInput.value = state.text;
    editorSection.classList.add('hidden');
    inputSection.classList.remove('hidden');
    $('btnResetText').classList.add('hidden');
    closeMergeDialog();
    closeBatchDialog();
    state.text = '';
    state.persons = [];
    state.selections = [];
    state.exceptions = [];
    state.history = [];
    state.citations = []; // 重新加载原稿时清空引文
    state.sharedAliases = [];
    state.resolutions = Object.create(null);
    state.candidates = [];
    state.inspect = [];
    state.inspectFilter = 'all';
    activeCid = null;
  });

  $('btnExample').addEventListener('click', function () {
    fetch('/api/example')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        loadText(data.text);
        data.persons.forEach(function (p) { addPerson(p.codename, p.aliases, false); });
        state.history = []; // 示例预置规则不计入可撤销历史
        render();
        toast('已加载内置示例');
      })
      .catch(function () { toast('示例加载失败'); });
  });

  $('btnUndo').addEventListener('click', undo);

  $('btnCopy').addEventListener('click', function () {
    var done = function () { toast('匿名预览已复制到剪贴板'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(state.currentPreview).then(done, function () { toast('复制失败'); });
    } else {
      var ta = document.createElement('textarea');
      ta.value = state.currentPreview;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { toast('复制失败'); }
      document.body.removeChild(ta);
    }
  });

  // ---------- 人物表单 ----------
  personForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var codename = codenameInput.value.trim();
    if (!codename) { toast('请填写统一代号'); return; }
    var aliases = parseAliases(aliasesInput.value);
    addPerson(codename, aliases);
    codenameInput.value = '';
    aliasesInput.value = '';
    toast('已添加人物「' + codename + '」');
  });
})();
