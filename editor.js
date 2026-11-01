/* =============================================================================
 * editor.js — 户型 3D 编辑器 · 交互与编辑核心
 * -----------------------------------------------------------------------------
 * 职责：
 *   1. 选中 / 高亮（射线拾取）
 *   2. 拖拽移动构件、拖拽顶点修改墙体轮廓
 *   3. 右侧属性面板（名称 / 长度 / 高度 / 厚度 / 颜色 / 开启角 …）
 *   4. 工具栏：新增墙体 / 新增门 / 新增窗 / 删除 / 2D·3D / 线框 / 降墙 / 标签 /
 *      重置视图 / 导出 JSON / 导入 JSON / 保存方案 / 历史方案
 *   5. 持久化：localStorage 自动保存 + 预留 Hermes 后端接口
 *   6. DSH 侧边拾取桥接：选中构件时通过 postMessage 上报构件 id 与源码行号，
 *      接收父窗口下发的选中 / 修改指令
 *
 * 所有编辑操作都会调用 logEdit()，控制台可见 [editor] 前缀的日志，
 * 方便后续迭代时定位「哪一步改了哪个数据」。
 * ========================================================================== */
(function (global) {
  'use strict';

  var T = global.THREE;
  var H3 = global.House3D;

  /* ---------------------------------------------------------------------------
   * 0. 配置
   * ------------------------------------------------------------------------ */
  var STORAGE_KEY = 'dsh-3d-house-editor:plan';
  var HISTORY_KEY = 'dsh-3d-house-editor:history';

  // Hermes 后端接口（预留）。默认走相对路径，部署在 8090 后台时可直接命中。
  // 若后端未就绪，saveToBackend 会自动降级为 localStorage 并给出提示。
  var BACKEND = {
    enabled: true,
    save: '/api/house/plan/save',
    list: '/api/house/plan/list',
    load: '/api/house/plan/load',
    remove: '/api/house/plan/delete'
  };

  /* ---------------------------------------------------------------------------
   * 1. 运行时状态
   * ------------------------------------------------------------------------ */
  var app, canvas, camera, controls, scene, raycaster, pointer;

  var selectedId = null;
  var drag = null;          // 拖拽上下文
  var hoverId = null;
  var handles = [];         // 顶点手柄（球）
  var handleGroup = null;
  var hlGroup = null;       // 选中描边
  var sourceMap = {};       // 构件 id → main.js 行号（运行时抓取，用于 DSH 拾取）

  // 家具类型中文名（面板标签用）
  var FURN_LABEL = {
    bed: '床', nightstand: '床头柜', wardrobe: '衣柜', tv_cabinet: '电视柜',
    sofa: '沙发', armchair: '单椅', coffee_table: '茶几', rug: '地毯',
    side_table: '边几', dining_table: '餐桌', chair: '椅子', desk: '书桌',
    bookshelf: '书柜', toilet: '马桶', bathtub: '浴缸', basin: '洗手台',
    counter: '橱柜', sink: '水槽', stove: '灶台', fridge: '冰箱',
    washer: '洗衣机', plant: '绿植', round_table: '圆桌', balcony_chair: '休闲椅'
  };

  /* ---------------------------------------------------------------------------
   * 2. 小工具
   * ------------------------------------------------------------------------ */
  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function fmt(n, d) { return Number(Number(n).toFixed(d == null ? 3 : d)); }
  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function snap(v) { return Math.round(v / H3.CFG.snap) * H3.CFG.snap; }

  /** 统一的操作日志：所有编辑都从这里输出，便于回溯 */
  function logEdit(action, detail) {
    var msg = '[editor] ' + action + (detail ? ' ' + JSON.stringify(detail) : '');
    if (global.console) console.info(msg);
    return msg;
  }

  var toastTimer = null;
  function toast(text, kind) {
    var el = $('#toast');
    if (!el) return;
    el.textContent = text;
    el.hidden = false;
    el.classList.add('is-show');
    if (kind === 'error') el.style.borderColor = '#e5484d';
    else el.style.borderColor = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.classList.remove('is-show');
      el.style.borderColor = '';
      setTimeout(function () { el.hidden = true; }, 220);
    }, 2200);
  }

  /* ---------------------------------------------------------------------------
   * 3. 构件查找 / 类型判断
   * ------------------------------------------------------------------------ */
  function getPlan() { return H3.world.plan; }

  function findComponent(id) {
    var p = getPlan();
    if (!p) return null;
    var x;
    x = p.walls.filter(function (a) { return a.id === id; })[0];
    if (x) return { kind: 'wall', data: x };
    x = p.doors.filter(function (a) { return a.id === id; })[0];
    if (x) return { kind: 'door', data: x };
    x = p.windows.filter(function (a) { return a.id === id; })[0];
    if (x) return { kind: 'window', data: x };
    x = (p.rails || []).filter(function (a) { return a.id === id; })[0];
    if (x) return { kind: 'rail', data: x };
    x = p.rooms.filter(function (a) { return a.id === id; })[0];
    if (x) return { kind: 'room', data: x };
    x = (p.furniture || []).filter(function (a) { return a.id === id; })[0];
    if (x) return { kind: 'furniture', data: x };
    if (p.stairs && p.stairs.id === id) return { kind: 'stair', data: p.stairs };
    return null;
  }

  function getObject(id) {
    var found = null;
    H3.world.root.children.forEach(function (c) { if (c.name === id) found = c; });
    if (found) return found;
    H3.world.root.children.forEach(function (c) {
      if (!found && c.userData && c.userData.componentId === id) found = c;
    });
    return found;
  }

  /* ---------------------------------------------------------------------------
   * 4. 选中与高亮
   * ------------------------------------------------------------------------ */
  function selectById(id) {
    if (!id) return clearSelection();
    var comp = findComponent(id);
    if (!comp) return;
    selectedId = id;

    var obj = getObject(id);
    if (obj) refreshSelectionVisual();

    renderInspector();
    updatePanelButtons();
    logEdit('select', { id: id, kind: comp.kind, name: comp.data.name });
    notifyParent('select', buildPickPayload(id));
    updateHint();
  }

  function clearSelection() {
    selectedId = null;
    refreshSelectionVisual();
    renderInspector();
    updatePanelButtons();
    updateHint();
  }

  function clearHL() {
    if (!hlGroup) return;
    while (hlGroup.children.length) {
      var c = hlGroup.children.pop();
      if (c.geometry) c.geometry.dispose();
      if (c.material) c.material.dispose();
    }
    if (handleGroup) {
      handleGroup.children.slice().forEach(function (h) {
        if (h.geometry) h.geometry.dispose();
      });
      handleGroup.clear();
    }
    handles.length = 0;
  }

  /** 重建选中描边 + 顶点手柄 */
  function refreshSelectionVisual() {
    if (!hlGroup) {
      hlGroup = new T.Group();
      hlGroup.name = '__highlight';
      scene.add(hlGroup);
      // 手柄单独挂在场景上，避免被 clearHL() 连带清掉
      handleGroup = new T.Group();
      handleGroup.name = '__handles';
      scene.add(handleGroup);
    }
    clearHL();
    if (!selectedId) return;
    var obj = getObject(selectedId);
    if (!obj) return;

    var edgeMat = new T.LineBasicMaterial({ color: 0x2f6bff, transparent: true, opacity: 0.95 });
    var meshes = [];
    obj.traverse(function (o) { if (o.isMesh && !o.userData.isLabel) meshes.push(o); });
    meshes.forEach(function (m) {
      if (!m.geometry) return;
      var eg = new T.EdgesGeometry(m.geometry, 30);
      var line = new T.LineSegments(eg, edgeMat);
      m.updateWorldMatrix(true, false);
      line.matrixAutoUpdate = false;
      line.matrix.copy(m.matrixWorld);
      hlGroup.add(line);
    });

    // —— 顶点手柄 ——
    // 手柄放在构件顶部之上，避免被墙体本身挡住而无法拾取
    var comp = findComponent(selectedId);
    if (!comp) return;
    var d = comp.data;
    var pts = [];
    var hy = 0.95;
    if (comp.kind === 'wall') {
      hy = (H3.state.wallHeight || d.height || H3.CFG.defaultWallHeight) + 0.14;
      pts = [[d.x1, d.z1], [d.x2, d.z2]];
    } else if (comp.kind === 'rail') {
      hy = (d.height || 1.05) + 0.14;
      pts = [[d.x1, d.z1], [d.x2, d.z2]];
    } else if (comp.kind === 'door') {
      hy = (d.height || 2.1) + 0.14;
      pts = [[d.x1, d.z1], [d.x2, d.z2]];
    } else if (comp.kind === 'window') {
      hy = (d.top != null ? d.top : (d.sill || 0.45) + (d.height || 1.75)) + 0.14;
      pts = [[d.x1, d.z1], [d.x2, d.z2]];
    } else if (comp.kind === 'stair') {
      hy = 0.45;
      pts = [[d.x1, d.z1], [d.x2, d.z2]];
    }

    var hMat = new T.MeshBasicMaterial({ color: 0xff7a30 });
    pts.forEach(function (p, i) {
      var s = new T.Mesh(new T.SphereGeometry(0.13, 16, 12), hMat);
      s.position.set(p[0], hy, p[1]);
      s.userData.handleIndex = i;
      s.userData.componentId = selectedId;
      s.renderOrder = 5;
      handleGroup.add(s);
      handles.push(s);
    });
  }

  /* ---------------------------------------------------------------------------
   * 5. 属性面板
   * ------------------------------------------------------------------------ */
  function fieldNum(label, key, val, opts) {
    opts = opts || {};
    return '<div class="field">' +
      '<label class="field-label">' + label + '</label>' +
      '<input class="field-input" data-key="' + key + '" type="number" step="' + (opts.step || 0.05) +
      '" min="' + (opts.min != null ? opts.min : 0) + '" value="' + fmt(val) + '"' +
      (opts.readonly ? ' readonly' : '') + '>' +
      '</div>';
  }
  function fieldText(label, key, val) {
    return '<div class="field">' +
      '<label class="field-label">' + label + '</label>' +
      '<input class="field-input" data-key="' + key + '" type="text" value="' + (val || '') + '">' +
      '</div>';
  }
  function fieldColor(label, key, val) {
    return '<div class="field">' +
      '<label class="field-label">' + label + '</label>' +
      '<div class="color-row"><input class="field-input swatch" data-key="' + key + '" type="color" value="' +
      (val || '#cccccc') + '"><span class="field-note">' + (val || '') + '</span></div>' +
      '</div>';
  }
  function fieldSeg(label, key, val, options) {
    var html = '<div class="field"><label class="field-label">' + label + '</label>' +
      '<div class="seg" data-seg="' + key + '">';
    options.forEach(function (o) {
      html += '<button class="seg-btn' + (String(o.v) === String(val) ? ' is-active' : '') +
        '" data-key="' + key + '" data-val="' + o.v + '">' + o.t + '</button>';
    });
    return html + '</div></div>';
  }

  function renderInspector() {
    var body = $('#inspector-body');
    var empty = $('#inspector-empty');
    var comp = selectedId ? findComponent(selectedId) : null;
    if (!comp) {
      body.hidden = true;
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    body.hidden = false;

    var d = comp.data;
    var html = '';
    var typeName = { wall: '墙体', door: '门', window: '窗', rail: '栏板', room: '房间', stair: '楼梯', furniture: '家具' }[comp.kind];

    html += '<div class="comp-head"><span class="comp-type">' + typeName + '</span>' +
      '<h3 class="comp-name">' + (d.name || d.id) + '</h3></div>';

    // —— 标签区 ——
    var tags = [];
    if (comp.kind === 'wall') {
      tags.push(d.structural ? '<span class="tag tag-dark">承重墙</span>' : '<span class="tag">非承重墙</span>');
      tags.push('<span class="tag tag-ghost">长 ' + lenOf(d).toFixed(2) + ' m</span>');
      tags.push('<span class="tag tag-ghost">厚 ' + fmt(d.thickness, 2) + ' m</span>');
    } else if (comp.kind === 'window') {
      tags.push('<span class="tag">' + ({ bay: '飘窗', opening: '通口', window: '普通窗' }[d.kind] || '窗') + '</span>');
      tags.push('<span class="tag tag-ghost">宽 ' + lenOf(d).toFixed(2) + ' m</span>');
    } else if (comp.kind === 'door') {
      tags.push('<span class="tag tag-ghost">宽 ' + lenOf(d).toFixed(2) + ' m</span>');
    } else if (comp.kind === 'room') {
      tags.push('<span class="tag tag-ghost">' + H3.calcArea(d.poly).toFixed(1) + ' ㎡</span>');
    } else if (comp.kind === 'furniture') {
      tags.push('<span class="tag">' + (FURN_LABEL[d.type] || '家具') + '</span>');
      tags.push('<span class="tag tag-ghost">' + fmt(d.w, 2) + ' × ' + fmt(d.d, 2) + ' m</span>');
    }
    if (tags.length) html += '<div class="comp-tags">' + tags.join('') + '</div>';

    // —— 各类型的字段 ——
    html += fieldText('名称', 'name', d.name);

    if (comp.kind === 'wall' || comp.kind === 'rail') {
      html += fieldNum('长度 (m)', 'length', lenOf(d), { min: 0.2, step: 0.05 });
      if (comp.kind === 'wall') {
        html += '<div class="field-row">' +
          fieldNum('厚度 (m)', 'thickness', d.thickness, { min: 0.04, step: 0.01 }) +
          fieldNum('高度 (m)', 'height', d.height || H3.CFG.defaultWallHeight, { min: 0.3, step: 0.1 }) +
          '</div>';
        html += fieldSeg('墙体性质', 'structural', d.structural ? '1' : '0',
          [{ v: '1', t: '承重墙' }, { v: '0', t: '非承重墙' }]);
      } else {
        html += fieldNum('高度 (m)', 'height', d.height, { min: 0.3, step: 0.05 });
        html += fieldSeg('栏板类型', 'railkind', d.kind, [{ v: 'glass', t: '玻璃' }, { v: 'solid', t: '实体' }]);
      }
    }

    if (comp.kind === 'door') {
      html += '<div class="field-row">' +
        fieldNum('宽度 (m)', 'length', lenOf(d), { min: 0.5, step: 0.05 }) +
        fieldNum('高度 (m)', 'height', d.height, { min: 1.6, step: 0.05 }) +
        '</div>';
      html += fieldNum('开启角度 (°)', 'open', d.open != null ? d.open : 34, { min: 0, step: 5 });
      html += fieldSeg('铰链端', 'hinge', d.hinge, [{ v: 'start', t: '起点' }, { v: 'end', t: '终点' }]);
      html += fieldSeg('开启方向', 'swing', d.swing, [{ v: '1', t: '正向' }, { v: '-1', t: '反向' }]);
    }

    if (comp.kind === 'window') {
      html += '<div class="field-row">' +
        fieldNum('洞口宽 (m)', 'length', lenOf(d), { min: 0.3, step: 0.05 }) +
        fieldNum('窗台高 (m)', 'sill', d.sill != null ? d.sill : 0.45, { min: 0, step: 0.05 }) +
        '</div>';
      if (d.kind === 'opening') {
        html += fieldNum('洞口高 (m)', 'top', d.top != null ? d.top : 2.45, { min: 0.5, step: 0.05 });
      } else {
        html += fieldNum('窗高 (m)', 'height', d.height || 1.75, { min: 0.3, step: 0.05 });
        html += fieldSeg('窗型', 'winkind', d.kind, [
          { v: 'window', t: '普通窗' }, { v: 'bay', t: '飘窗' }, { v: 'opening', t: '通口' }
        ]);
        if (d.kind === 'bay') {
          html += fieldNum('外挑进深 (m)', 'bayDepth', d.bayDepth || 0.55, { min: 0.2, step: 0.05 });
        }
      }
    }

    if (comp.kind === 'stair') {
      html += '<div class="field-row">' +
        fieldNum('宽度 (m)', 'stairW', (d.x2 - d.x1), { min: 0.6, step: 0.05 }) +
        fieldNum('步数', 'steps', d.steps, { min: 3, step: 1 }) +
        '</div>';
      html += fieldNum('单步高 (m)', 'rise', d.rise, { min: 0.1, step: 0.01 });
    }

    if (comp.kind === 'furniture') {
      html += '<div class="field-row">' +
        fieldNum('宽 (m)', 'w', d.w, { min: 0.1, step: 0.05 }) +
        fieldNum('深 (m)', 'd', d.d, { min: 0.1, step: 0.05 }) +
        '</div>';
      html += '<div class="field-row">' +
        fieldNum('高 (m)', 'h', d.h != null ? d.h : 0.6, { min: 0.08, step: 0.05 }) +
        fieldNum('旋转 (°)', 'rot', d.rot || 0, { min: -180, max: 180, step: 15 }) +
        '</div>';
    }

    // —— 坐标 ——
    if (comp.kind === 'room') {
      html += '<div class="field-note">房间轮廓由户型数据定义，面积 ' + H3.calcArea(d.poly).toFixed(1) + ' ㎡</div>';
    } else if (comp.kind === 'stair') {
      html += '<div class="field-row">' +
        fieldNum('起点 X', 'x1', d.x1, { step: 0.05 }) + fieldNum('起点 Z', 'z1', d.z1, { step: 0.05 }) +
        '</div>';
    } else if (comp.kind === 'furniture') {
      html += '<div class="field-row">' +
        fieldNum('中心 X', 'fx', d.x, { step: 0.05 }) + fieldNum('中心 Z', 'fz', d.z, { step: 0.05 }) +
        '</div>';
    } else {
      html += '<div class="field-row">' +
        fieldNum('起点 X', 'x1', d.x1, { step: 0.05 }) + fieldNum('起点 Z', 'z1', d.z1, { step: 0.05 }) +
        '</div>';
      html += '<div class="field-row">' +
        fieldNum('终点 X', 'x2', d.x2, { step: 0.05 }) + fieldNum('终点 Z', 'z2', d.z2, { step: 0.05 }) +
        '</div>';
    }

    // —— 颜色 ——
    var curColor = d.color || defaultColorOf(comp);
    html += fieldColor('材质颜色', 'color', curColor);

    if (comp.kind === 'wall') {
      html += fieldSeg('所属', 'structuralRef', d.structural ? '1' : '0',
        [{ v: '1', t: '承重' }, { v: '0', t: '非承重' }]);
    }

    html += '<div class="src-hint">源码锚点：main.js · HOUSE_PLAN · id: "' + d.id + '"' +
      (sourceMap[d.id] ? ' · L' + sourceMap[d.id] : '') + '</div>';

    body.innerHTML = html;
    bindInspectorEvents();
  }

  function defaultColorOf(comp) {
    var C = H3.COLORS;
    switch (comp.kind) {
      case 'wall': return comp.data.structural ? C.wallStructural : C.wallPartition;
      case 'door': return C.doorLeaf;
      case 'window': return comp.data.kind === 'opening' ? '#cfd6dd' : C.glass;
      case 'rail': return comp.data.kind === 'glass' ? C.railGlass : C.railSolid;
      case 'room': return ({ wood: C.floorWood, 'wood-light': C.floorWoodLight, tile: C.floorTile, outdoor: C.floorOutdoor, stone: C.floorStone })[comp.data.kind];
      case 'furniture': return C.furnWood || '#e7dcc7';
      default: return '#cccccc';
    }
  }

  function lenOf(d) {
    return Math.hypot((d.x2 - d.x1), (d.z2 - d.z1));
  }

  /** 修改长度：以「起点/铰链端」为锚点，沿原方向伸缩 */
  function setLength(d, targetLen, anchor) {
    var dx = d.x2 - d.x1;
    var dz = d.z2 - d.z1;
    var L = Math.hypot(dx, dz);
    if (L < 1e-4) return;
    var ux = dx / L, uz = dz / L;
    if (anchor === 'end') {
      d.x1 = d.x2 - ux * targetLen;
      d.z1 = d.z2 - uz * targetLen;
    } else {
      d.x2 = d.x1 + ux * targetLen;
      d.z2 = d.z1 + uz * targetLen;
    }
  }

  function bindInspectorEvents() {
    var body = $('#inspector-body');
    if (!body || body.dataset.bound === '1') return;
    body.dataset.bound = '1';

    // 数值 / 文本 / 颜色
    body.addEventListener('input', function (e) {
      var el = e.target;
      var key = el.getAttribute('data-key');
      if (!key) return;
      var val = el.type === 'color' ? el.value : (el.type === 'number' ? parseFloat(el.value) : el.value);
      if (el.type === 'number' && (isNaN(val) || !isFinite(val))) return;
      applyProp(key, val);
    });

    // 分段按钮
    body.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.seg-btn') : null;
      if (!btn) return;
      var key = btn.getAttribute('data-key');
      var val = btn.getAttribute('data-val');
      $$('#inspector-body .seg[data-seg="' + key + '"] .seg-btn').forEach(function (b) {
        b.classList.toggle('is-active', b === btn);
      });
      applyProp(key, val);
    });
  }

  /** 应用属性修改：改数据 → 重建该构件 → 刷新面板 */
  function applyProp(key, val) {
    var comp = selectedId ? findComponent(selectedId) : null;
    if (!comp) return;
    var d = comp.data;
    var needRebuild = true;

    switch (key) {
      case 'name':
        d.name = val;
        logEdit('rename', { id: d.id, name: val });
        break;
      case 'length':
        if (comp.kind === 'wall' || comp.kind === 'rail') {
          setLength(d, clamp(val, 0.2, 30), 'start');
        } else if (comp.kind === 'door' || comp.kind === 'window') {
          // 门/窗以“洞口起点”为锚点，保持贴墙
          setLength(d, clamp(val, 0.3, 6), 'start');
        }
        logEdit('length', { id: d.id, len: val });
        break;
      case 'thickness':
        d.thickness = clamp(val, 0.04, 1.2);
        break;
      case 'height':
        d.height = clamp(val, 0.3, 6);
        break;
      case 'open':
        d.open = clamp(val, 0, 120);
        break;
      case 'hinge':
        d.hinge = val;
        break;
      case 'swing':
        d.swing = Number(val);
        break;
      case 'structural':
        d.structural = String(val) === '1';
        // 切换承重后若用户没自定义过颜色，则刷新为对应默认色
        if (!d.customColor) d.color = null;
        break;
      case 'railkind':
        d.kind = val;
        break;
      case 'winkind':
        d.kind = val;
        if (val === 'opening' && !d.top) d.top = 2.45;
        if (val !== 'bay') delete d.normal;
        else if (!d.normal) d.normal = { x: 0, z: -1 };
        break;
      case 'bayDepth':
        d.bayDepth = clamp(val, 0.2, 1.5);
        break;
      case 'sill':
        d.sill = clamp(val, 0, 3);
        break;
      case 'top':
        d.top = clamp(val, 0.5, 4);
        break;
      case 'steps':
        d.steps = Math.round(clamp(val, 3, 30));
        break;
      case 'rise':
        d.rise = clamp(val, 0.1, 0.25);
        break;
      case 'stairW': {
        var cz = (d.z1 + d.z2) / 2;
        d.x1 = fmt((d.x1 + d.x2) / 2 - val / 2);
        d.x2 = fmt((d.x1) + val);
        break;
      }
      case 'color':
        d.color = val;
        d.customColor = true;
        break;
      // —— 家具：尺寸 / 旋转 / 中心位置（直接改数据后重建） ——
      case 'w': d.w = clamp(val, 0.1, 6); break;
      case 'd': d.d = clamp(val, 0.1, 6); break;
      case 'h': d.h = clamp(val, 0.05, 3); break;
      case 'rot': d.rot = ((Math.round(val) % 360) + 540) % 360 - 180; break;
      case 'fx': d.x = snap(val); break;
      case 'fz': d.z = snap(val); break;
      case 'x1': d.x1 = val; break;
      case 'z1': d.z1 = val; break;
      case 'x2': d.x2 = val; break;
      case 'z2': d.z2 = val; break;
      case 'structuralRef':
        // 兼容：面板里可能同时出现两个同类分段组，统一按 structural 处理
        d.structural = String(val) === '1';
        if (!d.customColor) d.color = null;
        break;
      default:
        needRebuild = false;
    }

    if (key === 'name' || key === 'color') {
      // 名称/颜色刷新面板即可（颜色会触发重建以应用材质）
      needRebuild = key === 'color';
    }

    if (needRebuild) {
      H3.rebuildOne(d.id);
      refreshSelectionVisual();
      if (comp.kind === 'room') H3.rebuildAll();
    }
    renderInspector();
    autosave();
  }

  /* ---------------------------------------------------------------------------
   * 6. 射线拾取与拖拽
   * ------------------------------------------------------------------------ */
  function setPointerFromEvent(e) {
    var r = canvas.getBoundingClientRect();
    pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  }

  function collectPickables() {
    var arr = [];
    H3.world.root.traverse(function (o) {
      if (o.isMesh && !o.userData.isLabel && !o.userData.noPick && o.visible) arr.push(o);
    });
    handles.forEach(function (h) { arr.push(h); });
    return arr;
  }

  function pickAtPointer() {
    raycaster.setFromCamera(pointer, H3.world.camera);
    var hits = raycaster.intersectObjects(collectPickables(), false);
    return hits.length ? hits[0] : null;
  }

  function groundPoint(y) {
    raycaster.setFromCamera(pointer, H3.world.camera);
    var plane = new T.Plane(new T.Vector3(0, 1, 0), -y);
    var p = new T.Vector3();
    return raycaster.ray.intersectPlane(plane, p) ? p : null;
  }

  function onPointerDown(e) {
    if (walk.active) return;                       // 漫游时交给漫游控制器
    if (e.target !== canvas || e.button !== 0) return;
    setPointerFromEvent(e);

    // 1) 顶点手柄优先
    var hit = pickAtPointer();
    if (hit && hit.object.userData.handleIndex != null) {
      var comp0 = findComponent(hit.object.userData.componentId);
      if (comp0) {
        drag = {
          mode: 'vertex',
          id: comp0.data.id,
          index: hit.object.userData.handleIndex,
          base: JSON.parse(JSON.stringify(comp0.data)),
          grabY: hit.object.position.y
        };
        controls.enabled = false;
        e.preventDefault();
        e.stopPropagation();
        logEdit('drag-vertex-begin', { id: comp0.data.id, index: drag.index });
        return;
      }
    }

    // 2) 命中构件 → 选中；已选中则进入拖拽
    if (hit && hit.object.userData.componentId) {
      var id = hit.object.userData.componentId;
      var already = id === selectedId;
      if (!already) selectById(id);
      var comp = findComponent(id);
      if (comp) {
        var anchorY = 0.9;
        drag = {
          mode: 'move',
          id: id,
          base: JSON.parse(JSON.stringify(comp.data)),
          grabY: anchorY,
          start: groundPoint(anchorY),
          moved: false
        };
        controls.enabled = false;
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }

    // 3) 点空白 → 取消选中，交回 OrbitControls
    if (selectedId) clearSelection();
  }

  function onPointerMove(e) {
    if (walk.active) return;                       // 漫游时不做拾取 / 拖拽
    setPointerFromEvent(e);

    if (drag) {
      var comp = findComponent(drag.id);
      if (!comp) return;
      var d = comp.data;

      if (drag.mode === 'vertex') {
        var p = groundPoint(drag.grabY);
        if (!p) return;
        var x = clamp(snap(p.x), -20, 40);
        var z = clamp(snap(p.z), -20, 40);
        if (drag.index === 0) { d.x1 = x; d.z1 = z; }
        else { d.x2 = x; d.z2 = z; }
      } else {
        var p2 = groundPoint(drag.grabY);
        if (!p2 || !drag.start) return;
        var dx = snap(p2.x - drag.start.x);
        var dz = snap(p2.z - drag.start.z);
        if (Math.abs(dx) > 1e-6 || Math.abs(dz) > 1e-6) drag.moved = true;
        translateComponent(comp, drag.base, dx, dz);
      }

      H3.rebuildOne(d.id);
      refreshSelectionVisual();
      renderInspector();
      return;
    }

    // hover 状态
    var hit = pickAtPointer();
    var hovered = hit && hit.object.userData.componentId;
    if (hovered !== hoverId) {
      hoverId = hovered;
      canvas.style.cursor = hovered ? 'pointer' : 'default';
    }
  }

  function translateComponent(comp, base, dx, dz) {
    var d = comp.data;
    if (comp.kind === 'room') {
      d.poly = base.poly.map(function (p) { return [fmt(p[0] + dx), fmt(p[1] + dz)]; });
    } else if (comp.kind === 'furniture') {
      d.x = fmt(base.x + dx);
      d.z = fmt(base.z + dz);
    } else {
      d.x1 = fmt(base.x1 + dx); d.z1 = fmt(base.z1 + dz);
      d.x2 = fmt(base.x2 + dx); d.z2 = fmt(base.z2 + dz);
    }
  }

  function onPointerUp() {
    if (!drag) return;
    var comp = findComponent(drag.id);
    if (comp) {
      if (drag.mode === 'vertex') {
        logEdit('drag-vertex-end', { id: drag.id, x1: comp.data.x1, z1: comp.data.z1, x2: comp.data.x2, z2: comp.data.z2 });
      } else if (drag.moved) {
        logEdit('drag-move', { id: drag.id });
      }
      autosave();
    }
    drag = null;
    controls.enabled = true;
    updateHint();
  }

  /* ---------------------------------------------------------------------------
   * 7. 增删构件
   * ------------------------------------------------------------------------ */
  function uid(prefix) {
    return prefix + '-' + Math.random().toString(36).slice(2, 6);
  }

  function addWall() {
    var p = getPlan();
    var tgt = controls.target;
    var x = snap(tgt.x), z = snap(tgt.z);
    var wall = {
      id: uid('wall'),
      name: '新建墙体',
      x1: x - 1.0, z1: z, x2: x + 1.0, z2: z,
      thickness: 0.12, structural: false
    };
    p.walls.push(wall);
    H3.rebuildAll();
    selectById(wall.id);
    toast('已新增墙体，可拖拽顶点调整');
    logEdit('add-wall', { id: wall.id });
    autosave();
  }

  function addDoor() {
    var p = getPlan();
    var comp = selectedId ? findComponent(selectedId) : null;
    var wall = comp && comp.kind === 'wall' ? comp.data : null;
    if (!wall) { toast('请先选中一面墙，再新增门', 'error'); return; }
    var L = lenOf(wall);
    if (L < 1.0) { toast('墙体太短，无法开门', 'error'); return; }
    var ux = (wall.x2 - wall.x1) / L, uz = (wall.z2 - wall.z1) / L;
    var w = 0.9;
    var mid = L / 2;
    var door = {
      id: uid('door'), name: '新建门', wallId: wall.id,
      x1: fmt(wall.x1 + ux * (mid - w / 2)), z1: fmt(wall.z1 + uz * (mid - w / 2)),
      x2: fmt(wall.x1 + ux * (mid + w / 2)), z2: fmt(wall.z1 + uz * (mid + w / 2)),
      height: H3.CFG.doorHeight, hinge: 'end', swing: 1, open: 34
    };
    p.doors.push(door);
    H3.rebuildAll();
    selectById(door.id);
    toast('已新增门（挂在当前墙体上）');
    logEdit('add-door', { id: door.id, wallId: wall.id });
    autosave();
  }

  function addWindow() {
    var p = getPlan();
    var comp = selectedId ? findComponent(selectedId) : null;
    var wall = comp && comp.kind === 'wall' ? comp.data : null;
    if (!wall) { toast('请先选中一面墙，再新增窗', 'error'); return; }
    var L = lenOf(wall);
    if (L < 1.0) { toast('墙体太短，无法开窗', 'error'); return; }
    var ux = (wall.x2 - wall.x1) / L, uz = (wall.z2 - wall.z1) / L;
    var w = Math.min(1.6, L * 0.6);
    var mid = L / 2;
    // 外法线：默认取墙体右手侧（可后续在面板里改窗型/颜色）
    var win = {
      id: uid('win'), name: '新建窗', wallId: wall.id, kind: 'window',
      x1: fmt(wall.x1 + ux * (mid - w / 2)), z1: fmt(wall.z1 + uz * (mid - w / 2)),
      x2: fmt(wall.x1 + ux * (mid + w / 2)), z2: fmt(wall.z1 + uz * (mid + w / 2)),
      sill: H3.CFG.defaultSill, height: 1.6
    };
    p.windows.push(win);
    H3.rebuildAll();
    selectById(win.id);
    toast('已新增窗（挂在当前墙体上）');
    logEdit('add-window', { id: win.id, wallId: wall.id });
    autosave();
  }

  function deleteSelected() {
    if (!selectedId) { toast('请先选中要删除的构件', 'error'); return; }
    var p = getPlan();
    var id = selectedId;
    var done = false;
    ['walls', 'doors', 'windows', 'rails', 'rooms', 'furniture'].forEach(function (k) {
      var arr = p[k];
      if (!arr) return;
      var idx = arr.map(function (a) { return a.id; }).indexOf(id);
      if (idx >= 0) { arr.splice(idx, 1); done = true; }
    });
    if (!done && p.stairs && p.stairs.id === id) { p.stairs = null; done = true; }
    if (!done) return;
    clearSelection();
    H3.rebuildAll();
    toast('已删除选中构件');
    logEdit('delete', { id: id });
    autosave();
  }

  function duplicateSelected() {
    if (!selectedId) return;
    var comp = findComponent(selectedId);
    if (!comp || comp.kind === 'stair') { toast('该构件暂不支持复制', 'error'); return; }
    var p = getPlan();
    var copy = JSON.parse(JSON.stringify(comp.data));
    copy.id = uid(comp.kind === 'wall' ? 'wall' : comp.kind);
    copy.name = (comp.data.name || '构件') + ' 副本';
    if (comp.kind === 'room') {
      copy.poly = copy.poly.map(function (q) { return [q[0] + 0.3, q[1] + 0.3]; });
      p.rooms.push(copy);
    } else if (comp.kind === 'furniture') {
      copy.x = fmt(copy.x + 0.35);
      copy.z = fmt(copy.z + 0.35);
      p.furniture.push(copy);
    } else {
      copy.x1 += 0.3; copy.x2 += 0.3;
      if (comp.kind === 'wall') p.walls.push(copy);
      else if (comp.kind === 'door') p.doors.push(copy);
      else if (comp.kind === 'window') p.windows.push(copy);
      else if (comp.kind === 'rail') p.rails.push(copy);
    }
    H3.rebuildAll();
    selectById(copy.id);
    logEdit('duplicate', { from: comp.data.id, to: copy.id });
    autosave();
  }

  /* ---------------------------------------------------------------------------
   * 8. 视图与工具
   * ------------------------------------------------------------------------ */
  function setViewMode(mode) {
    H3.setView(mode);
    H3.state.view = mode;
    // 相机在 3D 透视 / 2D 正投之间切换，这里同步本地引用（拾取要用最新相机）
    camera = H3.world.camera;
    $('#btn-view-2d').classList.toggle('is-active', mode === '2d');
    $('#btn-view-3d').classList.toggle('is-active', mode === '3d');
    var badge = $('#mode-badge');
    if (badge) badge.textContent = mode === '2d' ? '2D 顶视' : '3D 透视';
    logEdit('view', { mode: mode });
    updateHint();
  }

  function toggleWireframe() {
    var on = !H3.state.wireframe;
    H3.applyWireframe(on);
    H3.state.wireframe = on;
    $('#btn-wireframe').classList.toggle('is-active', on);
    logEdit('wireframe', { on: on });
  }

  function toggleWallHeight() {
    var low = H3.state.wallHeight == null;
    H3.setWallHeight(low ? H3.CFG.lowWallHeight : null);
    H3.state.wallHeight = low ? H3.CFG.lowWallHeight : null;
    $('#btn-wall-height').classList.toggle('is-active', low);
    refreshSelectionVisual();
    toast(low ? '墙体降高预览：1.2 m' : '墙体恢复实际层高');
    logEdit('wall-height', { low: low });
  }

  function toggleLabels() {
    var on = !H3.state.labels;
    H3.setLabels(on);
    $('#btn-labels').classList.toggle('is-active', on);
    logEdit('labels', { on: on });
  }

  /* ---------------------------------------------------------------------------
   * 9. 序列化 / 持久化
   * ------------------------------------------------------------------------ */
  function exportJSON() {
    var p = getPlan();
    var data = JSON.stringify(p, null, 2);
    var blob = new Blob([data], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (p.meta.name || 'house-plan') + '.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 800);
    toast('已导出户型 JSON');
    logEdit('export', { walls: p.walls.length, doors: p.doors.length, windows: p.windows.length });
    notifyParent('export', p);
  }

  function importJSON(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var obj = JSON.parse(reader.result);
        if (!obj || !Array.isArray(obj.walls)) throw new Error('JSON 结构不合法：缺少 walls 数组');
        migratePlan(obj);   // 兼容 v1 导出的旧方案（无 furniture 字段）
        getPlan() && Object.keys(getPlan()).forEach(function (k) { delete getPlan()[k]; });
        Object.keys(obj).forEach(function (k) { getPlan()[k] = obj[k]; });
        // 关键字段兜底
        var p = getPlan();
        p.rooms = p.rooms || [];
        p.rails = p.rails || [];
        p.windows = p.windows || [];
        p.doors = p.doors || [];
        p.furniture = p.furniture || [];
        p.footprint = p.footprint || [[0, 0], [1, 0], [1, 1], [0, 1]];
        p.meta = p.meta || { name: '导入户型' };
        clearSelection();
        H3.rebuildAll();
        setPlanName(p.meta.name);
        toast('已导入户型 JSON');
        logEdit('import', { walls: p.walls.length });
        autosave();
      } catch (err) {
        console.error(err);
        toast('导入失败：' + err.message, 'error');
      }
    };
    reader.readAsText(file, 'utf-8');
  }

  function autosave() {
    try {
      global.localStorage.setItem(STORAGE_KEY, JSON.stringify(getPlan()));
    } catch (e) { /* 隐私模式 / 容量超限：忽略 */ }
  }

  function restoreFromCache() {
    try {
      var raw = global.localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      var obj = JSON.parse(raw);
      if (!obj || !Array.isArray(obj.walls)) return false;
      migratePlan(obj);
      var p = getPlan();
      Object.keys(p).forEach(function (k) { delete p[k]; });
      Object.keys(obj).forEach(function (k) { p[k] = obj[k]; });
      return true;
    } catch (e) { return false; }
  }

  /**
   * 旧方案迁移：v1 没有 furniture 字段，直接加载会「家具全丢」。
   * 缺失时按当前默认户型补一份家具；已有数组（哪怕是空数组，表示用户删光了）则不动。
   */
  function migratePlan(obj) {
    if (!obj) return obj;
    if (!Array.isArray(obj.furniture)) {
      var base = H3.createDefaultPlan();
      obj.furniture = base.furniture;
      if (obj.meta) obj.meta.schemaVersion = 2;
      logEdit('migrate-plan', { furniture: obj.furniture.length });
    }
    return obj;
  }

  function readHistory() {
    try {
      var raw = global.localStorage.getItem(HISTORY_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  }

  function pushHistory(name, planObj) {
    var list = readHistory();
    list.unshift({ name: name || ('方案 ' + new Date().toLocaleString('zh-CN')), at: Date.now(), plan: planObj });
    list = list.slice(0, 12);
    try { global.localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); } catch (e) { }
    return list;
  }

  /* ---- Hermes 后端接口（预留，失败自动降级） ---- */
  function saveToBackend() {
    var p = getPlan();
    var payload = { name: p.meta.name, plan: p };
    var done = function (ok, msg) {
      toast(msg, ok ? undefined : 'error');
      if (ok) logEdit('save-backend', { ok: true });
    };
    if (!BACKEND.enabled) { pushHistory(p.meta.name, p); return done(true, '已保存到本地历史方案'); }
    fetch(BACKEND.save, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json().catch(function () { return {}; });
    }).then(function () {
      done(true, '已保存到 Hermes 后端');
    }).catch(function (err) {
      // 后端未就绪：降级到本地历史方案，保证不丢数据
      pushHistory(p.meta.name, p);
      console.warn('[editor] 后端保存失败，已降级为本地历史方案：', err && err.message);
      done(true, '后端未就绪，已保存到本地历史方案');
    });
  }

  function openHistory() {
    var modal = $('#modal');
    var body = $('#modal-body');
    if (!modal) return;
    modal.hidden = false;
    body.innerHTML = '<p class="field-note">正在读取历史方案…</p>';

    fetch(BACKEND.list).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (data) {
      renderHistoryList(data && data.items ? data.items : []);
    }).catch(function () {
      renderHistoryList(readHistory());
    });
  }

  function renderHistoryList(items) {
    var body = $('#modal-body');
    if (!items || !items.length) {
      body.innerHTML = '<p class="field-note">暂无历史方案。点击「保存方案」即可写入一条记录。</p>';
      return;
    }
    var html = '';
    items.forEach(function (it, i) {
      var t = it.at ? new Date(it.at).toLocaleString('zh-CN') : '';
      html += '<div class="history-item">' +
        '<div class="history-main"><b>' + (it.name || '未命名') + '</b><span class="field-note">' + t + '</span></div>' +
        '<div class="history-actions">' +
        '<button class="ghost" data-load="' + i + '">载入</button>' +
        '</div></div>';
    });
    body.innerHTML = html;
    $$('#modal-body [data-load]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var idx = Number(btn.getAttribute('data-load'));
        var item = items[idx];
        var planObj = item.plan || item.data;
        if (!planObj) { toast('该记录没有可用的方案数据', 'error'); return; }
        var p = getPlan();
        Object.keys(p).forEach(function (k) { delete p[k]; });
        Object.keys(planObj).forEach(function (k) { p[k] = planObj[k]; });
        clearSelection();
        H3.rebuildAll();
        setPlanName(p.meta && p.meta.name);
        $('#modal').hidden = true;
        toast('已载入历史方案');
        logEdit('load-history', { name: item.name });
      });
    });
  }

  /* ---------------------------------------------------------------------------
   * 10. DSH 侧边拾取桥接
   * ------------------------------------------------------------------------ */
  function buildPickPayload(id) {
    var comp = findComponent(id);
    if (!comp) return null;
    var d = comp.data;
    var props = { name: d.name };
    if (comp.kind === 'wall') {
      props.thickness = d.thickness; props.length = lenOf(d); props.structural = !!d.structural;
    } else if (comp.kind === 'door' || comp.kind === 'window') {
      props.width = lenOf(d); props.height = d.height; props.wallId = d.wallId;
    }
    return {
      id: id,
      kind: comp.kind,
      name: d.name,
      props: props,
      // 源码定位：main.js 中 createDefaultPlan() 里的同 id 条目
      source: {
        file: 'src/3d-house-editor/main.js',
        anchor: 'id: "' + id + '"',
        line: sourceMap[id] || null
      }
    };
  }

  function notifyParent(type, payload) {
    if (global.parent === global) return;
    try {
      global.parent.postMessage({ source: 'dsh-3d-house-editor', type: type, payload: payload }, '*');
    } catch (e) { /* 跨域限制时忽略 */ }
  }

  function bindParentMessages() {
    global.addEventListener('message', function (e) {
      var data = e.data;
      if (!data || data.source !== 'dsh-host') return;
      if (data.type === 'select' && data.id) selectById(data.id);
      if (data.type === 'command' && data.action === 'delete') deleteSelected();
      if (data.type === 'command' && data.action === 'export') exportJSON();
    });
  }

  /** 运行时解析 main.js，建立 id → 行号 映射（Hermes / http 环境下可用） */
  function buildSourceMap() {
    if (typeof fetch !== 'function') return;
    fetch('./main.js').then(function (r) { return r.ok ? r.text() : null; }).then(function (txt) {
      if (!txt) return;
      var lines = txt.split('\n');
      var re = /id: '([a-z0-9\-]+)'/;
      lines.forEach(function (ln, i) {
        var m = re.exec(ln);
        if (m) sourceMap[m[1]] = i + 1;
      });
    }).catch(function () { /* file:// 直接打开时读取失败，退化为锚点定位 */ });
  }

  /* ---------------------------------------------------------------------------
   * 11. UI 绑定
   * ------------------------------------------------------------------------ */
  function updatePanelButtons() {
    var dis = !selectedId;
    ['#btn-delete', '#btn-focus', '#btn-dup'].forEach(function (s) {
      var el = $(s);
      if (el) el.disabled = dis;
    });
  }

  function updateHint() {
    var t = $('#hint-text');
    if (!t) return;
    if (drag) t.textContent = '拖拽中… 松开鼠标完成';
    else if (selectedId) t.textContent = '拖动橙点改轮廓 · 拖动构件整体移动 · Del 删除 · Esc 取消选中';
    else t.textContent = '左键旋转 · 滚轮缩放 · 右键平移 · 点击构件选中';
  }

  function setPlanName(name) {
    var el = $('#plan-name');
    if (el && name) el.textContent = name;
  }

  function bindUI() {
    var map = {
      'btn-add-wall': addWall,
      'btn-add-door': addDoor,
      'btn-add-window': addWindow,
      'btn-delete': deleteSelected,
      'btn-view-3d': function () { setViewMode('3d'); },
      'btn-view-2d': function () { setViewMode('2d'); },
      'btn-wireframe': toggleWireframe,
      'btn-wall-height': toggleWallHeight,
      'btn-labels': toggleLabels,
      'btn-reset-view': function () {
        if (H3.state.view === '2d') setViewMode('3d');
        else H3.setCameraHome(false);
        logEdit('reset-view');
      },
      'btn-export': exportJSON,
      'btn-import': function () { $('#file-input').click(); },
      'btn-save': saveToBackend,
      'btn-history': openHistory,
      'btn-focus': function () { if (selectedId) H3.focusOn(selectedId); },
      'btn-dup': duplicateSelected,
      'btn-close-panel': function () {
        var p = $('#inspector');
        p.classList.toggle('is-hidden');
        $('#app').classList.toggle('panel-collapsed', p.classList.contains('is-hidden'));
        // 面板显隐会改变可用画布宽度，2D 顶视需要重新对位
        if (H3.state.view === '2d') setTimeout(function () { H3.setView('2d'); }, 60);
      },
      'btn-modal-close': function () { $('#modal').hidden = true; }
    };
    Object.keys(map).forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('click', map[id]);
      else console.warn('[editor] 缺少按钮 #' + id);
    });

    var fileInput = $('#file-input');
    if (fileInput) {
      fileInput.addEventListener('change', function () {
        if (fileInput.files && fileInput.files[0]) importJSON(fileInput.files[0]);
        fileInput.value = '';
      });
    }

    // 快捷键
    global.addEventListener('keydown', function (e) {
      if (walk.active) return;                     // 漫游中快捷键交给漫游控制器
      if (/input|textarea|select/i.test((e.target.tagName || ''))) return;
      switch (e.key) {
        case 'Escape': clearSelection(); break;
        case 'Delete':
        case 'Backspace': deleteSelected(); break;
        case 'w': case 'W': addWall(); break;
        case 'd': case 'D': addDoor(); break;
        case 'n': case 'N': addWindow(); break;
        case 'r': case 'R': H3.setCameraHome(false); break;
        case 'f': case 'F': if (selectedId) H3.focusOn(selectedId); break;
        default: break;
      }
    });

    global.addEventListener('resize', function () {
      H3.resize();
    });
  }

  /* ---------------------------------------------------------------------------
   * 11.5 第一人称漫游（带碰撞，人物不穿模）
   * ------------------------------------------------------------------------
   * 原理：把当前户型几何换算成一组「XZ 平面 OBB」碰撞盒（main.js → buildColliders），
   *      漫游时把相机水平位置视为半径 0.30m 的圆，与碰撞盒做圆-矩形推挤，
   *      3 次迭代收敛。墙体只在「实心段」生成碰撞盒，门洞/通口天然可通行，
   *      窗洞下方窗台仍是实心，所以不会出现穿窗、穿墙。
   * ------------------------------------------------------------------------ */
  var walk = {
    active: false,
    eye: 1.62,         // 视高
    radius: 0.30,      // 人体半径（碰撞用）
    speed: 3.0,        // m/s
    sprint: 1.9,       // Shift 加速倍率
    pos: new T.Vector3(),
    yaw: 0,
    pitch: 0,
    keys: {},
    colliders: [],
    dragLook: false,
    lastPt: { x: 0, y: 0 },
    savedCam: null,
    lastT: 0
  };

  /** 圆 vs OBB 推挤：把人推出墙体/家具，保证不穿模 */
  function walkResolve(p) {
    var r = walk.radius;
    for (var pass = 0; pass < 3; pass++) {
      var hit = false;
      for (var i = 0; i < walk.colliders.length; i++) {
        var c = walk.colliders[i];
        var dx = p.x - c.x;
        var dz = p.z - c.z;
        // 世界 → OBB 局部（局部 X 沿构件方向）
        var lx = c.cos * dx - c.sin * dz;
        var lz = c.sin * dx + c.cos * dz;
        var ox = lx - clamp(lx, -c.hx, c.hx);
        var oz = lz - clamp(lz, -c.hz, c.hz);
        var d2 = ox * ox + oz * oz;
        if (d2 >= r * r) continue;
        hit = true;
        if (d2 > 1e-8) {
          var dist = Math.sqrt(d2);
          var k = (r - dist) / dist;
          lx += ox * k;
          lz += oz * k;
        } else {
          // 圆心已在盒内：沿最浅的一条边推出去
          var penX = c.hx + r - Math.abs(lx);
          var penZ = c.hz + r - Math.abs(lz);
          if (penX < penZ) lx += (lx >= 0 ? 1 : -1) * penX;
          else lz += (lz >= 0 ? 1 : -1) * penZ;
        }
        // 局部 → 世界
        p.x = c.x + c.cos * lx + c.sin * lz;
        p.z = c.z - c.sin * lx + c.cos * lz;
      }
      if (!hit) break;
    }
    return p;
  }

  function enterWalk() {
    if (walk.active) return;
    if (H3.state.wireframe) toggleWireframe();          // 线框模式不适合漫游
    if (H3.state.wallHeight != null) toggleWallHeight(); // 恢复真实层高
    if (H3.state.view === '2d') setViewMode('3d');

    walk.colliders = H3.buildColliders(getPlan());
    walk.pos.set(8.95, 0, 5.15);   // 从门厅进入，正对过道
    walk.yaw = T.MathUtils.degToRad(22);   // 略微偏向过道 / 餐厅
    walk.pitch = 0;
    walk.keys = {};
    walk.lastT = 0;
    walkResolve(walk.pos);

    walk.savedCam = {
      pos: H3.world.camera.position.clone(),
      target: H3.world.controls.target.clone(),
      fov: H3.world.camera.fov
    };

    walk.active = true;
    H3.world.controls.enabled = false;
    H3.setCeiling(true);          // 漫游时补上顶棚，室内才有空间感
    camera = H3.world.camera;
    camera.rotation.order = 'YXZ';
    camera.fov = 68;
    camera.updateProjectionMatrix();

    document.body.classList.add('is-walking');
    var hud = $('#walk-hud');
    if (hud) hud.hidden = false;
    var btn = $('#btn-walk');
    if (btn) btn.classList.add('is-active');
    clearSelection();

    // iframe 未授权 pointer-lock 时会抛异常 → 自动降级为「按住左键转视角」
    try {
      if (canvas.requestPointerLock) canvas.requestPointerLock();
    } catch (err) { /* 降级 */ }

    logEdit('walk-enter', { colliders: walk.colliders.length });
    toast('漫游中：WASD / 方向键移动 · 鼠标转视角 · Shift 加速 · Esc 退出');
  }

  function exitWalk(silent) {
    if (!walk.active) return;
    walk.active = false;
    walk.dragLook = false;
    H3.setCeiling(false);
    document.body.classList.remove('is-walking');
    var hud = $('#walk-hud');
    if (hud) hud.hidden = true;
    var btn = $('#btn-walk');
    if (btn) btn.classList.remove('is-active');
    if (document.pointerLockElement && document.exitPointerLock) {
      try { document.exitPointerLock(); } catch (err) { /* ignore */ }
    }
    var cam = H3.world.camera;
    if (walk.savedCam) {
      cam.fov = walk.savedCam.fov;
      cam.updateProjectionMatrix();
      cam.position.copy(walk.savedCam.pos);
      cam.rotation.set(0, 0, 0);
      H3.world.controls.target.copy(walk.savedCam.target);
    }
    H3.world.controls.enabled = true;
    if (H3.world.controls) H3.world.controls.update();
    if (!silent) toast('已退出漫游');
    logEdit('walk-exit', {});
  }

  function walkStep(now) {
    if (!walk.active) return;
    var dt = walk.lastT ? Math.min(0.05, (now - walk.lastT) / 1000) : 0.016;
    walk.lastT = now;

    var k = walk.keys;
    var fwd = (k.KeyW || k.ArrowUp ? 1 : 0) - (k.KeyS || k.ArrowDown ? 1 : 0);
    var str = (k.KeyD || k.ArrowRight ? 1 : 0) - (k.KeyA || k.ArrowLeft ? 1 : 0);

    if (fwd || str) {
      var sy = Math.sin(walk.yaw), cy = Math.cos(walk.yaw);
      var fx = -sy, fz = -cy;   // 水平朝向
      var rx = cy, rz = -sy;    // 右手方向
      var mx = fx * fwd + rx * str;
      var mz = fz * fwd + rz * str;
      var len = Math.sqrt(mx * mx + mz * mz) || 1;
      mx /= len; mz /= len;
      var sp = walk.speed * (k.ShiftLeft || k.ShiftRight ? walk.sprint : 1);
      walk.pos.x += mx * sp * dt;
      walk.pos.z += mz * sp * dt;
      walkResolve(walk.pos);     // 碰撞推挤 → 不穿模
    }

    camera.position.set(walk.pos.x, walk.eye, walk.pos.z);
    camera.rotation.set(walk.pitch, walk.yaw, 0, 'YXZ');
  }

  /** 漫游中瞬移到指定位置（供 DSH / Hermes 侧边拾取「跳到该房间」用） */
  function walkTeleport(x, z, yawDeg) {
    if (!walk.active) return false;
    walk.pos.set(x, 0, z);
    if (yawDeg != null) walk.yaw = T.MathUtils.degToRad(yawDeg);  // 0 = 朝北，90 = 朝西
    walk.pitch = 0;
    walkResolve(walk.pos);
    camera.position.set(walk.pos.x, walk.eye, walk.pos.z);
    camera.rotation.set(walk.pitch, walk.yaw, 0, 'YXZ');
    logEdit('walk-teleport', { x: +walk.pos.x.toFixed(2), z: +walk.pos.z.toFixed(2), yaw: yawDeg });
    return true;
  }

  function bindWalkUI() {
    var btnWalk = $('#btn-walk');
    if (btnWalk) btnWalk.addEventListener('click', function () {
      if (walk.active) exitWalk(); else enterWalk();
    });
    var btnExit = $('#btn-walk-exit');
    if (btnExit) btnExit.addEventListener('click', function () { exitWalk(); });

    global.addEventListener('keydown', function (e) {
      if (!walk.active) return;
      if (e.key === 'Escape') { exitWalk(); return; }
      if (!/^(input|textarea|select)$/i.test((e.target.tagName || '').toLowerCase())) {
        walk.keys[e.code] = true;
        if (/^(Arrow|Key[WASD])/.test(e.code)) e.preventDefault();
      }
    }, true);

    global.addEventListener('keyup', function (e) {
      if (!walk.active) return;
      walk.keys[e.code] = false;
    }, true);

    // 鼠标转视角：pointer-lock 优先，失败则按住左键拖拽
    canvas.addEventListener('pointerdown', function (e) {
      if (!walk.active) return;
      if (document.pointerLockElement !== canvas && e.button === 0) {
        walk.dragLook = true;
        walk.lastPt = { x: e.clientX, y: e.clientY };
      }
    });

    global.addEventListener('pointerup', function () {
      walk.dragLook = false;
    });

    global.addEventListener('pointermove', function (e) {
      if (!walk.active) return;
      if (document.pointerLockElement === canvas) {
        walk.yaw -= (e.movementX || 0) * 0.0026;
        walk.pitch = clamp(walk.pitch - (e.movementY || 0) * 0.0022, -1.15, 1.15);
      } else if (walk.dragLook) {
        var mx = e.clientX - walk.lastPt.x;
        var my = e.clientY - walk.lastPt.y;
        walk.lastPt = { x: e.clientX, y: e.clientY };
        walk.yaw -= mx * 0.0042;
        walk.pitch = clamp(walk.pitch - my * 0.0036, -1.15, 1.15);
      }
    });

    // 用户按 Esc 解除指针锁定时，同步退出漫游
    document.addEventListener('pointerlockchange', function () {
      if (walk.active && document.pointerLockElement !== canvas) {
        // 仍在漫游：允许继续用拖拽视角，不强制退出
      }
    });
  }

  /* ---------------------------------------------------------------------------
   * 12. 主循环
   * ------------------------------------------------------------------------ */
  function animate(now) {
    requestAnimationFrame(animate);
    if (walk.active) {
      walkStep(now || performance.now());
    } else {
      H3.updateFly(now || performance.now());
      if (controls) controls.update();
    }
    if (H3.world.renderer && H3.world.scene && camera) {
      H3.world.renderer.render(H3.world.scene, camera);
    }
  }

  /* ---------------------------------------------------------------------------
   * 13. 启动
   * ------------------------------------------------------------------------ */
  function boot() {
    app = $('#app');
    canvas = $('#viewport');
    if (!canvas) { console.error('[editor] 找不到 #viewport'); return; }

    // 嵌入判断：iframe 内运行时收起部分装饰元素
    if (global.parent !== global) document.body.classList.add('is-embedded');

    H3.boot(canvas);
    scene = H3.world.scene;
    camera = H3.world.camera;
    controls = H3.world.controls;
    raycaster = new T.Raycaster();
    pointer = new T.Vector2();

    camera.aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
    camera.updateProjectionMatrix();

    // 恢复上一次的方案（localStorage）
    if (restoreFromCache()) {
      H3.rebuildAll();
      toast('已恢复上次编辑的户型');
    }
    setPlanName(getPlan().meta && getPlan().meta.name);

    bindUI();
    bindWalkUI();
    bindParentMessages();
    buildSourceMap();

    // 指针事件挂在 #app 的捕获阶段：命中构件时截断，避免和 OrbitControls 抢事件
    app.addEventListener('pointerdown', onPointerDown, true);
    global.addEventListener('pointermove', onPointerMove);
    global.addEventListener('pointerup', onPointerUp);

    H3.world.onRebuild = function () {
      if (selectedId) refreshSelectionVisual();
    };

    updatePanelButtons();
    updateHint();
    renderInspector();
    animate();

    var loading = $('#loading');
    if (loading) setTimeout(function () { loading.hidden = true; }, 260);

    logEdit('boot', {
      walls: getPlan().walls.length,
      doors: getPlan().doors.length,
      windows: getPlan().windows.length,
      rooms: getPlan().rooms.length
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // 暴露给外部（DSH / Hermes 调试用）
  global.HouseEditor = {
    selectById: selectById,
    clearSelection: clearSelection,
    exportJSON: exportJSON,
    saveToBackend: saveToBackend,
    getPlan: getPlan,
    reRender: function () { H3.rebuildAll(); },
    enterWalk: enterWalk,
    exitWalk: exitWalk,
    walkTeleport: walkTeleport,
    isWalking: function () { return walk.active; },
    api: BACKEND
  };
})(window);
