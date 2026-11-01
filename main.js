/* =============================================================================
 * main.js — 户型 3D 编辑器 · 场景 / 数据 / 几何构建
 * -----------------------------------------------------------------------------
 * 设计要点（重要，后续迭代请先读这里）：
 *  1. 单一数据源：整个场景完全由 PLAN（墙体 / 门 / 窗 / 房间 / 栏杆 / 楼梯）描述，
 *     编辑器的任何修改都只改 PLAN，然后调用 rebuildAll() 或 rebuildOne(id) 重建
 *     对应网格。这样避免了「场景与数据不同步」的问题。
 *  2. 单位：米（m），Y 轴向上。平面坐标 X 向东、Z 向南（与原户型图一致：
 *     图纸左 = 西，图纸上 = 北）。
 *  3. 墙体开洞：墙体按「实心段 + 洞口上/下过梁」拆分后用 BoxGeometry 拼出来，
 *     而不是用 ExtrudeGeometry 挖洞 —— 更轻、更稳、且拖拽时重建成本极低。
 *     洞口由 doors / windows 中 wallId 相同的构件投影到墙中心线得到。
 *  4. 材质：每个构件持有独立材质实例（便于单独改颜色），材质在 rebuild 时复用。
 *
 * 坐标标定说明（由上传的平面图反推）：
 *   图纸像素 → 米：X 方向 7.072 mm/px，Z 方向 6.480 mm/px（该图被非等比拉伸），
 *   原点取图纸墙体外皮 px(297, 228)。因此本文件的数值都可由原图尺寸链复核：
 *   上部 742 / 3670 / 1113 / 1746 / 3736 / 725，底部 1390 / 280 / 4260 / 2071 /
 *   1533 / 2368，左侧 3540 + 3160 = 6700，右侧 2862 + 1910。
 *
 * 【原图模糊，尺寸为常规估算，支持界面手动调整】出现在以下位置：
 *   楼梯踏步与走向、飘窗外挑进深、东侧「休闲阳台」的功能定性、层高 2.8m、
 *   门高 2.1m、窗台 0.45m。
 * ========================================================================== */
(function (global) {
  'use strict';

  var T = global.THREE;

  /* ===========================================================================
   * 0. 常量与配色
   * ========================================================================= */
  var CFG = {
    defaultWallHeight: 2.8, // 层高【原图模糊，尺寸为常规估算，支持界面手动调整】
    lowWallHeight: 1.2,     // 「降墙」预览模式下的墙高
    doorHeight: 2.1,        // 门高【原图模糊，尺寸为常规估算，支持界面手动调整】
    defaultSill: 0.45,      // 窗台高【原图模糊，尺寸为常规估算，支持界面手动调整】
    slabThickness: 0.18,    // 楼板厚度
    snap: 0.05,             // 拖拽吸附步长
    fov3d: 42,              // 3D 透视视角
    fov2d: 9                // 2D 顶视视角（小 FOV + 远距离 ≈ 正投影，墙体不会"外扩"）
  };

  // 白模家装配色：浅色系 PBR，承重墙深色、非承重墙浅色
  var COLORS = {
    wallStructural: '#a9b3bf', // 承重墙（深色，用于区分结构）
    wallPartition: '#f8f5ee',  // 非承重墙（浅色）
    wallTop: '#ffffff',
    doorFrame: '#b39a77',
    doorLeaf: '#e2cfae',
    doorHandle: '#8b949e',
    glass: '#c6e2f2',
    windowFrame: '#ccd2d9',
    bayTable: '#fbf9f5',
    floorWood: '#ecdfc7',
    floorWoodLight: '#f4ecdb',
    floorTile: '#d5dfe3',
    floorOutdoor: '#ddd8ce',
    floorStone: '#e4e4e0',
    slab: '#dfe3e8',
    railGlass: '#d7e8f2',
    railSolid: '#eeeae1',
    stair: '#efe9dd',
    ground: '#eef0f3',
    label: '#8a94a3',

    // —— 家具（白模浅色系，木色 + 浅灰布艺 + 白陶瓷）——
    furnWood: '#e7dcc7',
    furnWoodDeep: '#d2b895',
    furnFabric: '#dfe4e9',
    furnFabricDeep: '#ccd4dd',
    furnWhite: '#f9f9f7',
    furnCeramic: '#fcfcfb',
    furnMetal: '#b7bec6',
    furnDark: '#79838f',
    furnGlass: '#cfe4ef',
    furnGreen: '#a9c193',
    furnGreenDeep: '#8fae7c',
    furnRug: '#ece4d6',
    furnCounter: '#e9e9e5'
  };

  /* ===========================================================================
   * 1. 户型数据（唯一数据源）
   * ---------------------------------------------------------------------------
   * walls : 中心线 (x1,z1)-(x2,z2) + 厚度 + 高度 + 是否承重
   * doors : 洞口线段 + 铰链端 + 开启方向(swing) + 开启角度
   * windows: 洞口线段 + 窗台/高度 + kind('window' | 'bay' | 'opening')
   *          kind==='opening' 表示「通口」：墙上开洞但不装门窗（如客厅通阳台）
   * rooms : 地面多边形 + 材质类型（用于上色和标签）
   * ======================================================================== */
  function createDefaultPlan() {
    return {
      meta: {
        version: 1,
        name: '现代简约 · 三室两厅两卫',
        // 总面积 = 各房间地面之和（由 rooms 自动统计，见 calcArea）
        note: '由户型平面图反推生成，承重墙深色 / 非承重墙浅色',
        createdAt: '2026-11-01'
      },

      walls: [
        // —— 外围护墙（承重）——
        { id: 'wall-west',        name: '西外墙（主卧 / 客厅）', x1: 1.52, z1: 0.00,  x2: 1.52,  z2: 7.16,  thickness: 0.27, structural: true },
        { id: 'wall-north',       name: '北外墙',                x1: 1.39, z1: 0.125, x2: 8.36,  z2: 0.125, thickness: 0.25, structural: true },
        { id: 'wall-boy-north',   name: '男孩卧北外墙',          x1: 8.20, z1: 0.99,  x2: 12.36, z2: 0.99,  thickness: 0.24, structural: true },
        { id: 'wall-living-south',name: '客厅南外墙',            x1: 1.39, z1: 7.16,  x2: 6.20,  z2: 7.16,  thickness: 0.27, structural: true },
        { id: 'wall-living-east', name: '客厅东侧短墙',          x1: 6.07, z1: 5.97,  x2: 6.07,  z2: 7.16,  thickness: 0.27, structural: true },
        { id: 'wall-kitchen-south', name: '厨房南外墙',          x1: 9.34, z1: 6.03,  x2: 12.36, z2: 6.03,  thickness: 0.28, structural: true },
        { id: 'wall-east-north',  name: '东外墙（男孩卧段）',    x1: 12.22, z1: 0.87, x2: 12.22, z2: 3.62,  thickness: 0.27, structural: true },
        { id: 'wall-east-pass',   name: '厨房东侧通口墙',        x1: 12.22, z1: 3.62, x2: 12.22, z2: 5.385, thickness: 0.27, structural: true },
        { id: 'wall-east-south',  name: '东外墙（厨房东南段）',  x1: 12.22, z1: 5.385,x2: 12.22, z2: 6.03,  thickness: 0.27, structural: true },
        { id: 'wall-balcony-south', name: '休闲阳台南墙',        x1: 12.09, z1: 5.51, x2: 13.49, z2: 5.51,  thickness: 0.25, structural: true },
        { id: 'wall-boy-south',   name: '男孩卧南墙 / 厨房北墙', x1: 8.20, z1: 3.564, x2: 12.36, z2: 3.564, thickness: 0.22, structural: true },

        // —— 内隔墙（非承重）——
        { id: 'wall-dining-south', name: '餐厅 / 门厅南墙',      x1: 5.93, z1: 6.13,  x2: 8.36,  z2: 6.13,  thickness: 0.17, structural: false },
        { id: 'wall-entry',       name: '入户门洞墙',            x1: 8.36, z1: 6.13,  x2: 9.34,  z2: 6.13,  thickness: 0.22, structural: true },
        { id: 'wall-kitchen-west',name: '厨房西墙',              x1: 9.62, z1: 3.56,  x2: 9.62,  z2: 6.03,  thickness: 0.17, structural: false },
        { id: 'wall-balcony-east-n', name: '休闲阳台北窗墙',     x1: 12.36, z1: 3.72, x2: 13.49, z2: 3.72,  thickness: 0.12, structural: false },
        { id: 'wall-balcony-east-e', name: '休闲阳台东窗墙',     x1: 13.49, z1: 3.72, x2: 13.49, z2: 5.51,  thickness: 0.12, structural: false },
        { id: 'wall-hall-west',   name: '主卫东墙 / 男孩卧西墙', x1: 8.27, z1: 0.25,  x2: 8.27,  z2: 4.10,  thickness: 0.18, structural: false },
        { id: 'wall-master-south',name: '主卧南墙 / 客厅北墙',   x1: 1.66, z1: 3.564, x2: 5.43,  z2: 3.564, thickness: 0.22, structural: false },
        { id: 'wall-master-east', name: '主卧东墙（轻质）',      x1: 5.386, z1: 0.25, x2: 5.386, z2: 3.564, thickness: 0.10, structural: false },
        { id: 'wall-bath-mid',    name: '主卫 / 楼梯隔墙',       x1: 5.34, z1: 1.70,  x2: 6.44,  z2: 1.70,  thickness: 0.09, structural: false },
        { id: 'wall-stair-east',  name: '楼梯东隔墙',            x1: 6.39, z1: 1.67,  x2: 6.39,  z2: 2.573, thickness: 0.11, structural: false },
        { id: 'wall-bath-south',  name: '主卫南墙',              x1: 6.34, z1: 2.48,  x2: 8.27,  z2: 2.48,  thickness: 0.18, structural: false }
      ],

      doors: [
        // 洞口线段方向即门扇闭合方向；hinge 指定铰链在 start / end 端点
        { id: 'door-master',  name: '主卧门', wallId: 'wall-master-south', x1: 1.66, z1: 3.564, x2: 2.58, z2: 3.564, height: 2.1, hinge: 'end',   swing:  1, open: 34, color: null },
        { id: 'door-bath',    name: '主卫门', wallId: 'wall-bath-south',   x1: 7.05, z1: 2.48,  x2: 7.85, z2: 2.48,  height: 2.1, hinge: 'end',   swing:  1, open: 34, color: null },
        { id: 'door-boy',     name: '男孩卧门', wallId: 'wall-hall-west',  x1: 8.27, z1: 2.62,  x2: 8.27, z2: 3.41,  height: 2.1, hinge: 'start', swing: -1, open: 34, color: null },
        { id: 'door-kitchen', name: '厨房门', wallId: 'wall-kitchen-west', x1: 9.62, z1: 4.374, x2: 9.62, z2: 5.113, height: 2.1, hinge: 'start', swing: -1, open: 34, color: null },
        { id: 'door-entry',   name: '入户门', wallId: 'wall-entry',        x1: 8.36, z1: 6.13,  x2: 9.34, z2: 6.13,  height: 2.1, hinge: 'end',   swing:  1, open: 30, color: null }
      ],

      windows: [
        // 主卧西飘窗：墙面洞口 Z 0.544~2.158，外挑 0.60m 至 X≈0.92
        { id: 'win-master-bay', name: '主卧西飘窗', kind: 'bay', wallId: 'wall-west', x1: 1.52, z1: 0.544, x2: 1.52, z2: 2.158, sill: 0.45, height: 1.75, bayDepth: 0.60, normal: { x: -1, z: 0 } },
        // 男孩卧东飘窗：洞口 Z 1.231~2.540，外挑 0.59m 至 X≈12.81
        { id: 'win-boy-bay',    name: '男孩卧东飘窗', kind: 'bay', wallId: 'wall-east-north', x1: 12.22, z1: 1.231, x2: 12.22, z2: 2.540, sill: 0.45, height: 1.75, bayDepth: 0.59, normal: { x: 1, z: 0 } },
        // 东侧休闲阳台：北、东两面玻璃
        { id: 'win-leisure-n',  name: '休闲阳台北窗', kind: 'window', wallId: 'wall-balcony-east-n', x1: 12.44, z1: 3.72, x2: 13.41, z2: 3.72, sill: 0.45, height: 1.85 },
        { id: 'win-leisure-e',  name: '休闲阳台东窗', kind: 'window', wallId: 'wall-balcony-east-e', x1: 13.49, z1: 3.80, x2: 13.49, z2: 5.43, sill: 0.45, height: 1.85 },
        // 墙上「通口」：只开洞、不装门窗
        { id: 'pass-balcony',   name: '客厅通阳台通口', kind: 'opening', wallId: 'wall-west', x1: 1.52, z1: 4.206, x2: 1.52, z2: 6.35, sill: 0, top: 2.45 },
        { id: 'pass-leisure',   name: '厨房通休闲阳台通口', kind: 'opening', wallId: 'wall-east-pass', x1: 12.22, z1: 3.72, x2: 12.22, z2: 5.385, sill: 0, top: 2.45 }
      ],

      rooms: [
        { id: 'room-master',  name: '主卧',   kind: 'wood',       poly: [[1.66, 0.25], [5.34, 0.25], [5.34, 3.45], [1.66, 3.45]] },
        { id: 'room-bath',    name: '主卫',   kind: 'tile',       poly: [[5.43, 0.25], [8.18, 0.25], [8.18, 2.39], [6.44, 2.39], [6.44, 1.66], [5.43, 1.66]] },
        { id: 'room-boy',     name: '男孩卧', kind: 'wood',       poly: [[8.36, 1.11], [12.09, 1.11], [12.09, 3.45], [8.36, 3.45]] },
        { id: 'room-living',  name: '客厅',   kind: 'wood-light', poly: [[1.66, 3.67], [5.93, 3.67], [5.93, 7.04], [1.66, 7.04]] },
        { id: 'room-dining',  name: '餐厅',   kind: 'wood-light', poly: [[5.93, 3.67], [8.18, 3.67], [8.18, 6.05], [5.93, 6.05]] },
        { id: 'room-entry',   name: '门厅',   kind: 'wood-light', poly: [[8.36, 3.67], [9.53, 3.67], [9.53, 6.05], [8.36, 6.05]] },
        { id: 'room-kitchen', name: '厨房',   kind: 'tile',       poly: [[9.71, 3.67], [12.09, 3.67], [12.09, 6.03], [9.71, 6.03]] },
        { id: 'room-balcony', name: '阳台',   kind: 'outdoor',    poly: [[0.10, 3.62], [1.39, 3.62], [1.39, 6.60], [0.10, 6.60]] },
        { id: 'room-leisure', name: '休闲阳台', kind: 'outdoor',  poly: [[12.36, 3.80], [13.43, 3.80], [13.43, 5.42], [12.36, 5.42]] },
        { id: 'room-corridor',name: '过道',   kind: 'wood-light', poly: [[6.44, 2.57], [8.18, 2.57], [8.18, 3.45], [6.44, 3.45]] },
        { id: 'room-stair',   name: '楼梯间', kind: 'stone',      poly: [[5.43, 1.75], [6.34, 1.75], [6.34, 3.67], [5.43, 3.67]] }
      ],

      // 阳台栏板（西阳台为通透玻璃栏板 + 南侧实体栏板）
      rails: [
        { id: 'rail-balcony-w', name: '阳台西侧玻璃栏板', x1: 0.08, z1: 3.62, x2: 0.08, z2: 6.60, height: 1.05, kind: 'glass' },
        { id: 'rail-balcony-n', name: '阳台北侧玻璃栏板', x1: 0.08, z1: 3.62, x2: 1.39, z2: 3.62, height: 1.05, kind: 'glass' },
        { id: 'rail-balcony-s', name: '阳台南侧实体栏板', x1: 0.08, z1: 6.60, x2: 1.39, z2: 6.60, height: 1.05, kind: 'solid' }
      ],

      // 楼梯【原图模糊，尺寸为常规估算，支持界面手动调整】
      // 图中标注「上」，由南向北上行；本模型只表达一层起步梯段与平台。
      stairs: { id: 'stair-main', name: '楼梯（上行）', x1: 5.52, z1: 1.83, x2: 6.34, z2: 3.67, steps: 10, rise: 0.15, dir: 'north' },

      /* ---------------------------------------------------------------------
       * 家具（按原图位置还原）
       * 约定：x/z 为构件平面中心，w 沿局部 X，d 沿局部 Z，rot（度）绕 Y 轴旋转，
       *      局部 +Z 为「正面」（沙发/椅子朝坐、柜子朝门、床尾方向）。
       *      solid=false 表示不参与漫游碰撞（地毯等）。
       * 【原图模糊，尺寸为常规估算，支持界面手动调整】
       * ------------------------------------------------------------------- */
      furniture: [
        // —— 主卧 ——
        { id: 'f-bed-master',   type: 'bed',         name: '主卧双人床',     x: 3.49, z: 1.30, w: 1.80, d: 2.05, h: 0.55, rot: 0 },
        { id: 'f-ns-master-w',  type: 'nightstand',  name: '主卧床头柜(西)', x: 2.34, z: 0.46, w: 0.46, d: 0.40, h: 0.50, rot: 0 },
        { id: 'f-ns-master-e',  type: 'nightstand',  name: '主卧床头柜(东)', x: 4.62, z: 0.46, w: 0.46, d: 0.40, h: 0.50, rot: 0 },
        { id: 'f-chair-master', type: 'armchair',    name: '主卧休闲椅',     x: 2.12, z: 1.06, w: 0.74, d: 0.78, h: 0.76, rot: 90 },
        { id: 'f-tvcab-master', type: 'tv_cabinet',  name: '主卧电视柜',     x: 3.46, z: 3.22, w: 1.10, d: 0.40, h: 0.45, rot: 180 },
        { id: 'f-wd-master',    type: 'wardrobe',    name: '主卧衣柜',       x: 4.72, z: 3.20, w: 1.24, d: 0.45, h: 2.10, rot: 180 },

        // —— 主卫 ——
        { id: 'f-bathtub',      type: 'bathtub',     name: '主卫浴缸',       x: 7.33, z: 0.65, w: 1.45, d: 0.70, h: 0.56, rot: 0 },
        { id: 'f-toilet',       type: 'toilet',      name: '主卫马桶',       x: 7.85, z: 1.42, w: 0.42, d: 0.68, h: 0.76, rot: -90 },
        { id: 'f-basin',        type: 'basin',       name: '主卫洗手台',     x: 6.72, z: 1.98, w: 0.55, d: 0.46, h: 0.82, rot: 90 },

        // —— 男孩卧 ——
        { id: 'f-bed-boy',      type: 'bed',         name: '男孩卧单人床',   x: 10.17, z: 2.13, w: 1.50, d: 1.95, h: 0.55, rot: 0 },
        { id: 'f-ns-boy',       type: 'nightstand',  name: '男孩卧床头柜',   x: 9.28, z: 1.32, w: 0.45, d: 0.40, h: 0.50, rot: 0 },
        { id: 'f-wd-boy',       type: 'wardrobe',    name: '男孩卧衣柜',     x: 8.70, z: 1.95, w: 1.50, d: 0.60, h: 2.10, rot: 90 },
        { id: 'f-desk-boy',     type: 'desk',        name: '男孩卧书桌',     x: 11.55, z: 1.31, w: 0.95, d: 0.40, h: 0.75, rot: 0 },
        { id: 'f-chair-boy',    type: 'chair',       name: '男孩卧书桌椅',   x: 11.55, z: 1.80, w: 0.46, d: 0.46, h: 0.88, rot: 180 },
        { id: 'f-bk-boy',       type: 'bookshelf',   name: '男孩卧书柜',     x: 11.50, z: 3.28, w: 0.85, d: 0.34, h: 1.80, rot: 180 },

        // —— 客厅 ——
        { id: 'f-sofa',         type: 'sofa',        name: '客厅三人沙发',   x: 3.80, z: 6.53, w: 2.15, d: 0.92, h: 0.80, rot: 180 },
        { id: 'f-armchair-w',   type: 'armchair',    name: '客厅单椅(西)',   x: 2.26, z: 5.63, w: 0.88, d: 0.82, h: 0.78, rot: 90 },
        { id: 'f-armchair-e',   type: 'armchair',    name: '客厅单椅(东)',   x: 5.36, z: 5.63, w: 0.88, d: 0.82, h: 0.78, rot: -90 },
        { id: 'f-rug',          type: 'rug',         name: '客厅地毯',       x: 3.80, z: 5.40, w: 2.20, d: 1.45, h: 0.014, rot: 0, solid: false },
        { id: 'f-coffee',       type: 'coffee_table',name: '客厅茶几',       x: 3.80, z: 5.40, w: 1.10, d: 0.62, h: 0.42, rot: 0 },
        { id: 'f-side-w',       type: 'side_table',  name: '客厅边几(西)',   x: 2.26, z: 6.55, w: 0.52, d: 0.52, h: 0.55, rot: 0 },
        { id: 'f-side-e',       type: 'side_table',  name: '客厅边几(东)',   x: 5.36, z: 6.55, w: 0.52, d: 0.52, h: 0.55, rot: 0 },
        { id: 'f-tvcab-living', type: 'tv_cabinet',  name: '客厅电视柜',     x: 3.80, z: 3.90, w: 1.55, d: 0.34, h: 0.42, rot: 0 },

        // —— 餐厅 ——
        { id: 'f-dining',       type: 'dining_table',name: '餐桌',           x: 6.94, z: 5.30, w: 0.82, d: 1.05, h: 0.75, rot: 0 },
        { id: 'f-dc-1',         type: 'chair',       name: '餐椅(西北)',     x: 6.30, z: 5.06, w: 0.44, d: 0.44, h: 0.86, rot: 90 },
        { id: 'f-dc-2',         type: 'chair',       name: '餐椅(西南)',     x: 6.30, z: 5.56, w: 0.44, d: 0.44, h: 0.86, rot: 90 },
        { id: 'f-dc-3',         type: 'chair',       name: '餐椅(东北)',     x: 7.58, z: 5.06, w: 0.44, d: 0.44, h: 0.86, rot: -90 },
        { id: 'f-dc-4',         type: 'chair',       name: '餐椅(东南)',     x: 7.58, z: 5.56, w: 0.44, d: 0.44, h: 0.86, rot: -90 },

        // —— 厨房 ——
        { id: 'f-counter-n',    type: 'counter',     name: '厨房北侧操作台', x: 11.25, z: 4.02, w: 1.60, d: 0.58, h: 0.85, rot: 0 },
        { id: 'f-washer',       type: 'washer',      name: '洗衣机',         x: 10.10, z: 4.05, w: 0.62, d: 0.62, h: 0.85, rot: 0 },
        { id: 'f-sink',         type: 'sink',        name: '厨房水槽',       x: 11.18, z: 4.02, w: 0.62, d: 0.42, h: 0.86, rot: 0 },
        { id: 'f-counter-s',    type: 'counter',     name: '厨房南侧灶台',   x: 11.30, z: 5.72, w: 1.50, d: 0.58, h: 0.85, rot: 180 },
        { id: 'f-stove',        type: 'stove',       name: '燃气灶',         x: 11.30, z: 5.72, w: 0.62, d: 0.46, h: 0.86, rot: 180 },
        { id: 'f-fridge',       type: 'fridge',      name: '冰箱',           x: 10.15, z: 5.58, w: 0.62, d: 0.64, h: 1.80, rot: 0 },

        // —— 阳台 ——
        { id: 'f-plant-1',      type: 'plant',       name: '阳台绿植(大)',   x: 0.42, z: 3.92, w: 0.50, d: 0.50, h: 1.05, rot: 0 },
        { id: 'f-plant-2',      type: 'plant',       name: '阳台绿植(小)',   x: 0.92, z: 4.12, w: 0.40, d: 0.40, h: 0.90, rot: 0 },
        { id: 'f-bchair-1',     type: 'balcony_chair',name: '阳台休闲椅(北)',x: 0.52, z: 4.72, w: 0.62, d: 0.66, h: 0.74, rot: 90 },
        { id: 'f-btable',       type: 'round_table', name: '阳台小圆桌',     x: 0.54, z: 5.30, w: 0.54, d: 0.54, h: 0.52, rot: 0 },
        { id: 'f-bchair-2',     type: 'balcony_chair',name: '阳台休闲椅(南)',x: 0.52, z: 5.90, w: 0.62, d: 0.66, h: 0.74, rot: 90 },

        // —— 东侧休闲阳台 ——
        { id: 'f-ltable',       type: 'round_table', name: '休闲阳台小桌',   x: 12.98, z: 4.45, w: 0.60, d: 0.60, h: 0.58, rot: 0 },
        { id: 'f-lchair-1',     type: 'balcony_chair',name: '休闲阳台椅(北)',x: 12.98, z: 3.96, w: 0.56, d: 0.52, h: 0.74, rot: 0 },
        { id: 'f-lchair-2',     type: 'balcony_chair',name: '休闲阳台椅(南)',x: 12.98, z: 4.94, w: 0.56, d: 0.52, h: 0.74, rot: 180 }
      ],

      // 楼板外轮廓（顺时针，闭合）
      footprint: [
        [1.39, 0.00], [8.47, 0.00], [8.47, 0.87], [12.36, 0.87], [12.36, 3.72],
        [13.49, 3.72], [13.49, 5.63], [12.36, 5.63], [12.36, 6.21], [6.20, 6.21],
        [6.20, 7.28], [1.39, 7.28], [1.39, 6.70], [0.00, 6.70], [0.00, 3.54], [1.39, 3.54]
      ]
    };
  }

  /* ===========================================================================
   * 2. 运行时状态与材质
   * ========================================================================= */
  var state = {
    wireframe: false,
    labels: true,
    wallHeight: null, // null = 使用各墙自身高度；数值 = 统一覆盖（「降墙」模式）
    view: '3d'
  };

  var world = {
    scene: null,
    camera: null,
    renderer: null,
    controls: null,
    root: null,        // 所有户型构件都挂在这个 Group 下
    plan: null,
    labelGroup: null
  };

  var matCache = {};

  function makeMaterial(color, opts) {
    var key = color + '|' + JSON.stringify(opts || {});
    if (matCache[key]) return matCache[key].clone(); // 克隆一份，便于单构件改色
    var params = {
      color: new T.Color(color),
      roughness: 0.62,
      metalness: 0.02,
      flatShading: false
    };
    if (opts && opts.transparent) {
      params.transparent = true;
      params.opacity = opts.opacity != null ? opts.opacity : 0.35;
      params.roughness = 0.08;
      params.metalness = 0.0;
      params.depthWrite = false;
      params.side = T.DoubleSide;
    }
    var m = new T.MeshStandardMaterial(params);
    matCache[key] = m;
    return m.clone();
  }

  /**
   * 线框模式：不用 material.wireframe（会把三角面剖分线也画出来，很乱），
   * 而是给每个构件的几何体生成 EdgesGeometry 线段（只保留真实棱边），
   * 同时隐藏地面 / 楼板 / 标签，得到干净的"结构线框"。
   */
  function applyWireframe(on) {
    state.wireframe = on;
    if (!world.root) return;

    if (world.wireGroup) {
      disposeGroup(world.wireGroup);
      world.scene.remove(world.wireGroup);
      world.wireGroup = null;
    }

    world.root.traverse(function (o) {
      if (!o.isMesh) return;
      if (o.userData.hideInWireframe) {
        o.visible = !on;               // 地面类构件在线框模式下整体隐藏
      } else if (!o.userData.isLabel) {
        o.visible = !on;
      }
    });
    if (world.labelGroup) world.labelGroup.visible = state.labels;

    if (!on) return;

    var g = new T.Group();
    g.name = '__wireframe';
    world.root.updateMatrixWorld(true);
    world.root.traverse(function (o) {
      if (!o.isMesh || o.userData.hideInWireframe || o.userData.isLabel) return;
      if (!o.geometry) return;
      var eg;
      try { eg = new T.EdgesGeometry(o.geometry, 20); } catch (e) { return; }
      var col = (o.material && o.material.color) ? o.material.color.getHex() : 0x8c99a8;
      var line = new T.LineSegments(eg, new T.LineBasicMaterial({ color: col, transparent: true, opacity: 0.85 }));
      line.matrixAutoUpdate = false;
      line.matrix.copy(o.matrixWorld);
      g.add(line);
    });
    world.wireGroup = g;
    world.scene.add(g);
  }

  /* ===========================================================================
   * 3. 几何工具
   * ========================================================================= */

  /** 沿墙中心线添加一段实体墙（厚度方向为局部 Z） */
  function addWallSegment(group, wall, len, alpha, t0, t1, y0, y1, mat) {
    var L = t1 - t0;
    var H = y1 - y0;
    if (L <= 0.004 || H <= 0.004) return null;
    var ux = (wall.x2 - wall.x1) / len;
    var uz = (wall.z2 - wall.z1) / len;
    var mid = (t0 + t1) / 2;
    var geo = new T.BoxGeometry(L, H, wall.thickness);
    var mesh = new T.Mesh(geo, mat);
    mesh.position.set(wall.x1 + ux * mid, y0 + H / 2, wall.z1 + uz * mid);
    mesh.rotation.y = -alpha;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  }

  /** 计算所有落在某面墙上的洞口（门 / 窗 / 通口），并投影到墙中心线参数 t */
  function collectOpenings(wall, plan) {
    var dx = wall.x2 - wall.x1;
    var dz = wall.z2 - wall.z1;
    var len = Math.hypot(dx, dz);
    if (len < 1e-4) return [];
    var ux = dx / len;
    var uz = dz / len;
    var hubH = state.wallHeight != null ? state.wallHeight : (wall.height || CFG.defaultWallHeight);

    function proj(x, z) { return (x - wall.x1) * ux + (z - wall.z1) * uz; }

    var list = [];
    (plan.doors || []).forEach(function (d) {
      if (d.wallId !== wall.id) return;
      var p1 = proj(d.x1, d.z1);
      var p2 = proj(d.x2, d.z2);
      list.push({
        ref: d, kind: 'door',
        t0: Math.min(p1, p2), t1: Math.max(p1, p2),
        sill: 0, top: Math.min(hubH, d.height || CFG.doorHeight)
      });
    });
    (plan.windows || []).forEach(function (w) {
      if (w.wallId !== wall.id) return;
      var p1 = proj(w.x1, w.z1);
      var p2 = proj(w.x2, w.z2);
      var sill = w.sill != null ? w.sill : CFG.defaultSill;
      var top = w.top != null ? w.top : sill + (w.height || 1.75);
      list.push({
        ref: w, kind: 'window',
        t0: Math.min(p1, p2), t1: Math.max(p1, p2),
        sill: Math.max(0, Math.min(sill, hubH)),
        top: Math.min(hubH, top)
      });
    });

    list.forEach(function (o) {
      o.t0 = Math.max(0, o.t0);
      o.t1 = Math.min(len, o.t1);
    });
    return list
      .filter(function (o) { return o.t1 - o.t0 > 0.02; })
      .sort(function (a, b) { return a.t0 - b.t0; });
  }

  /** 墙体：实心段 + 洞口过梁 */
  function buildWallGroup(wall, plan) {
    var group = new T.Group();
    var dx = wall.x2 - wall.x1;
    var dz = wall.z2 - wall.z1;
    var len = Math.hypot(dx, dz);
    if (len < 0.02) return group;

    var alpha = Math.atan2(dz, dx);
    var H = state.wallHeight != null ? state.wallHeight : (wall.height || CFG.defaultWallHeight);
    var openings = collectOpenings(wall, plan);
    var mat = makeMaterial(wall.color || (wall.structural ? COLORS.wallStructural : COLORS.wallPartition));
    mat.roughness = wall.structural ? 0.72 : 0.82;

    var cursor = 0;
    openings.forEach(function (o) {
      if (o.t0 > cursor) addWallSegment(group, wall, len, alpha, cursor, o.t0, 0, H, mat);
      // 洞口下墙（窗台）
      if (o.sill > 0.004) addWallSegment(group, wall, len, alpha, o.t0, o.t1, 0, o.sill, mat);
      // 洞口上过梁
      if (o.top < H - 0.004) addWallSegment(group, wall, len, alpha, o.t0, o.t1, o.top, H, mat);
      cursor = Math.max(cursor, o.t1);
    });
    if (cursor < len) addWallSegment(group, wall, len, alpha, cursor, len, 0, H, mat);

    group.userData.material = mat;
    return group;
  }

  /** 门：门框 + 门扇 + 把手 + 地面开启弧线 */
  function buildDoorGroup(door, plan) {
    var group = new T.Group();
    var dx = door.x2 - door.x1;
    var dz = door.z2 - door.z1;
    var w = Math.hypot(dx, dz);
    if (w < 0.15) return group;
    var alpha = Math.atan2(dz, dx);
    var wall = (plan.walls || []).filter(function (x) { return x.id === door.wallId; })[0];
    var th = wall ? wall.thickness : 0.18;
    var hubH = state.wallHeight != null ? state.wallHeight : (wall && wall.height ? wall.height : CFG.defaultWallHeight);
    var H = Math.min(door.height || CFG.doorHeight, hubH - 0.02);

    var frameMat = makeMaterial(door.frameColor || COLORS.doorFrame);
    frameMat.roughness = 0.55;
    var leafMat = makeMaterial(door.color || COLORS.doorLeaf);
    leafMat.roughness = 0.5;

    // —— 门框：两侧门套 + 上樘 ——
    var jambW = 0.05;
    var frameDepth = th + 0.02;
    var cx = (door.x1 + door.x2) / 2;
    var cz = (door.z1 + door.z2) / 2;
    var ux = dx / w;
    var uz = dz / w;

    [1, -1].forEach(function (s) {
      var jg = new T.BoxGeometry(jambW, H, frameDepth);
      var jm = new T.Mesh(jg, frameMat);
      // 门套分别贴在洞口的两个端头
      jm.position.set(cx + ux * (s * (w / 2 - jambW / 2)), H / 2, cz + uz * (s * (w / 2 - jambW / 2)));
      jm.rotation.y = -alpha;
      jm.castShadow = true;
      group.add(jm);
    });
    var head = new T.Mesh(new T.BoxGeometry(w, 0.06, frameDepth), frameMat);
    head.position.set(cx, H - 0.03, cz);
    head.rotation.y = -alpha;
    head.castShadow = true;
    group.add(head);

    // —— 门扇：挂在铰链端，绕铰链旋转 open 度 ——
    var hingeAtEnd = door.hinge !== 'start';
    var hx = hingeAtEnd ? door.x2 : door.x1;
    var hz = hingeAtEnd ? door.z2 : door.z1;
    var ox = hingeAtEnd ? door.x1 : door.x2;
    var oz = hingeAtEnd ? door.z1 : door.z2;
    var a0 = Math.atan2(oz - hz, ox - hx);
    var swing = door.swing || 1;
    var aOpen = a0 + swing * T.MathUtils.degToRad(door.open != null ? door.open : 34);

    var leafW = Math.max(0.2, w - 0.07);
    var leafH = H - 0.06;
    var pivot = new T.Group();
    pivot.position.set(hx, 0, hz);
    pivot.rotation.y = -aOpen;
    var leaf = new T.Mesh(new T.BoxGeometry(leafW, leafH, 0.045), leafMat);
    leaf.position.set(leafW / 2, leafH / 2 + 0.01, 0);
    leaf.castShadow = true;
    leaf.receiveShadow = true;
    pivot.add(leaf);

    // 把手（两侧各一个）
    var handleMat = makeMaterial(COLORS.doorHandle);
    handleMat.metalness = 0.75;
    handleMat.roughness = 0.28;
    [-1, 1].forEach(function (s) {
      var hd = new T.Mesh(new T.CylinderGeometry(0.014, 0.014, 0.11, 10), handleMat);
      hd.rotation.x = Math.PI / 2;
      hd.position.set(leafW - 0.07, 1.0, s * 0.04);
      pivot.add(hd);
    });
    group.add(pivot);

    // —— 地面开启弧线（俯视时像平面图的门开启示意） ——
    var arcPts = [];
    var R = leafW;
    for (var i = 0; i <= 20; i++) {
      var a = a0 + (aOpen - a0) * (i / 20);
      arcPts.push(new T.Vector3(hx + Math.cos(a) * R, 0.012, hz + Math.sin(a) * R));
    }
    arcPts.push(new T.Vector3(hx, 0.012, hz));
    var arc = new T.Line(
      new T.BufferGeometry().setFromPoints(arcPts),
      new T.LineBasicMaterial({ color: 0x9aa4b1, transparent: true, opacity: 0.7 })
    );
    group.add(arc);

    group.userData.material = leafMat;
    return group;
  }

  /** 窗：窗框 + 玻璃（kind==='bay' 时生成外挑飘窗盒） */
  function buildWindowGroup(win, plan) {
    var group = new T.Group();
    var dx = win.x2 - win.x1;
    var dz = win.z2 - win.z1;
    var w = Math.hypot(dx, dz);
    if (w < 0.1) return group;
    var alpha = Math.atan2(dz, dx);
    var wall = (plan.walls || []).filter(function (x) { return x.id === win.wallId; })[0];
    var th = wall ? wall.thickness : 0.2;
    var hubH = state.wallHeight != null ? state.wallHeight : (wall && wall.height ? wall.height : CFG.defaultWallHeight);
    var sill = Math.min(win.sill != null ? win.sill : CFG.defaultSill, hubH - 0.2);
    var top = Math.min(win.top != null ? win.top : sill + (win.height || 1.75), hubH - 0.05);
    var glassH = Math.max(0.1, top - sill);

    var cx = (win.x1 + win.x2) / 2;
    var cz = (win.z1 + win.z2) / 2;

    // 通口：只画一条地面门槛，不装门窗
    if (win.kind === 'opening') {
      var thresh = new T.Mesh(
        new T.BoxGeometry(w, 0.02, th),
        new T.MeshStandardMaterial({ color: 0xcfd6dd, roughness: 0.9 })
      );
      thresh.position.set(cx, 0.012, cz);
      thresh.rotation.y = -alpha;
      thresh.receiveShadow = true;
      group.add(thresh);
      return group;
    }

    var frameMat = makeMaterial(win.frameColor || COLORS.windowFrame);
    frameMat.metalness = 0.35;
    frameMat.roughness = 0.35;
    var glassMat = makeMaterial(COLORS.glass, { transparent: true, opacity: 0.32 });

    if (win.kind === 'bay') {
      // —— 飘窗：窗台板 + 三面玻璃 + 顶板（外挑方向为 normal） ——
      var n = win.normal || { x: 0, z: -1 };
      var depth = win.bayDepth || 0.55;
      var ux = dx / w;
      var uz = dz / w;
      var bay = new T.Group();
      bay.position.set(cx, 0, cz);
      bay.rotation.y = -alpha; // 局部 +X 沿墙，局部 -Z 朝外（下方用 normal 修正）
      group.add(bay);

      // 墙体局部坐标系：局部 +X 沿墙（世界方向 u），局部 +Z = (-uz, ux)。
      // 把 normal 投影到局部 +Z 上，符号即外挑方向（+1 或 -1）。
      var outward = -n.x * uz + n.z * ux;
      var dir = outward >= 0 ? 1 : -1;

      var sillBoard = new T.Mesh(new T.BoxGeometry(w + 0.04, 0.06, depth), makeMaterial(COLORS.bayTable));
      sillBoard.position.set(0, sill - 0.03, dir * depth / 2);
      sillBoard.castShadow = true;
      sillBoard.receiveShadow = true;
      bay.add(sillBoard);

      var topBoard = new T.Mesh(new T.BoxGeometry(w + 0.04, 0.05, depth), frameMat);
      topBoard.position.set(0, top + 0.025, dir * depth / 2);
      bay.add(topBoard);

      // 外侧玻璃
      var front = new T.Mesh(new T.BoxGeometry(w, glassH, 0.024), glassMat);
      front.position.set(0, sill + glassH / 2, dir * depth);
      bay.add(front);
      // 两侧玻璃
      [-1, 1].forEach(function (s) {
        var side = new T.Mesh(new T.BoxGeometry(0.024, glassH, depth), glassMat);
        side.position.set(s * (w / 2), sill + glassH / 2, dir * depth / 2);
        bay.add(side);
      });
      // 竖框
      for (var i = 0; i <= 2; i++) {
        var mx = -w / 2 + (w / 2) * i;
        var bar = new T.Mesh(new T.BoxGeometry(0.035, glassH, 0.05), frameMat);
        bar.position.set(mx, sill + glassH / 2, dir * depth);
        bay.add(bar);
      }
      group.userData.material = glassMat;
      return group;
    }

    // —— 普通窗：窗套 + 玻璃 + 中挺 ——
    var frameDepth = th + 0.02;
    var sillBar = new T.Mesh(new T.BoxGeometry(w, 0.06, frameDepth + 0.03), frameMat);
    sillBar.position.set(cx, sill, cz);
    sillBar.rotation.y = -alpha;
    sillBar.castShadow = true;
    group.add(sillBar);

    var headBar = new T.Mesh(new T.BoxGeometry(w, 0.06, frameDepth + 0.03), frameMat);
    headBar.position.set(cx, top, cz);
    headBar.rotation.y = -alpha;
    group.add(headBar);

    var pane = new T.Mesh(new T.BoxGeometry(w - 0.04, glassH - 0.04, 0.022), glassMat);
    pane.position.set(cx, sill + glassH / 2, cz);
    pane.rotation.y = -alpha;
    group.add(pane);

    [0.5, -0.5].forEach(function (s) {
      var jg2 = new T.Mesh(new T.BoxGeometry(0.04, glassH, frameDepth), frameMat);
      jg2.position.set(cx + (dx / w) * s * w, sill + glassH / 2, cz + (dz / w) * s * w);
      jg2.rotation.y = -alpha;
      group.add(jg2);
    });
    // 中挺
    var mullion = new T.Mesh(new T.BoxGeometry(0.03, glassH - 0.04, 0.06), frameMat);
    mullion.position.set(cx, sill + glassH / 2, cz);
    mullion.rotation.y = -alpha;
    group.add(mullion);

    group.userData.material = glassMat;
    return group;
  }

  /** 地面多边形 → 平面网格 */
  function shapeFromPoly(poly) {
    var s = new T.Shape();
    // 注意：Shape 建在 XY 平面，绕 X 轴 -90° 后 (x, y) → (x, 0, -y)，
    // 因此这里用 -z 作为 shape 的 y，才能在世界上得到正确的 z。
    poly.forEach(function (p, i) {
      if (i === 0) s.moveTo(p[0], -p[1]);
      else s.lineTo(p[0], -p[1]);
    });
    s.closePath();
    return s;
  }

  function buildRoomFloor(room) {
    var geo = new T.ShapeGeometry(shapeFromPoly(room.poly));
    geo.rotateX(-Math.PI / 2);
    var map = {
      wood: COLORS.floorWood,
      'wood-light': COLORS.floorWoodLight,
      tile: COLORS.floorTile,
      outdoor: COLORS.floorOutdoor,
      stone: COLORS.floorStone
    };
    var mat = makeMaterial(room.color || map[room.kind] || COLORS.floorWoodLight);
    mat.roughness = room.kind === 'tile' ? 0.35 : 0.75;
    mat.metalness = room.kind === 'tile' ? 0.06 : 0.0;
    mat.side = T.DoubleSide;
    var mesh = new T.Mesh(geo, mat);
    mesh.position.y = 0.02;
    mesh.receiveShadow = true;
    mesh.userData.roomId = room.id;
    return mesh;
  }

  /** 文字贴图（房间名标签，平贴在地面，俯视时如平面图） */
  function makeLabelTexture(text, sub) {
    var cv = document.createElement('canvas');
    cv.width = 512; cv.height = 192;
    var ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COLORS.label;
    ctx.font = '600 88px "PingFang SC","Microsoft YaHei",system-ui,sans-serif';
    ctx.fillText(text, 256, sub ? 78 : 96);
    if (sub) {
      ctx.font = '400 44px "PingFang SC","Microsoft YaHei",system-ui,sans-serif';
      ctx.fillStyle = 'rgba(138,148,163,0.75)';
      ctx.fillText(sub, 256, 150);
    }
    var tex = new T.CanvasTexture(cv);
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    return tex;
  }

  function calcArea(poly) {
    var a = 0;
    for (var i = 0; i < poly.length; i++) {
      var p = poly[i];
      var q = poly[(i + 1) % poly.length];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return Math.abs(a / 2);
  }

  function centroid(poly) {
    var x = 0, z = 0;
    poly.forEach(function (p) { x += p[0]; z += p[1]; });
    return [x / poly.length, z / poly.length];
  }

  function buildRoomLabel(room) {
    var c = centroid(room.poly);
    var area = calcArea(room.poly);
    var tex = makeLabelTexture(room.name, area.toFixed(1) + ' ㎡');
    var w = 1.9;
    var mat = new T.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
    var geo = new T.PlaneGeometry(w, w * 0.375);
    geo.rotateX(-Math.PI / 2);
    var mesh = new T.Mesh(geo, mat);
    mesh.position.set(c[0], 0.035, c[1]);
    return mesh;
  }

  /** 楼板：外轮廓挤出 */
  function buildBaseSlab(plan) {
    var s = shapeFromPoly(plan.footprint);
    var geo = new T.ExtrudeGeometry(s, { depth: CFG.slabThickness, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, -CFG.slabThickness, 0);
    var mat = makeMaterial(COLORS.slab);
    mat.roughness = 0.92;
    mat.side = T.DoubleSide;
    var mesh = new T.Mesh(geo, mat);
    mesh.position.y = 0.0;
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    mesh.userData.hideInWireframe = true;
    return mesh;
  }

  /** 室内地面底板：铺满楼板轮廓的中性色，避免房间多边形之间出现缝隙 */
  function buildFloorBacker(plan) {
    var geo = new T.ShapeGeometry(shapeFromPoly(plan.footprint));
    geo.rotateX(-Math.PI / 2);
    var mat = makeMaterial('#efeae1');
    mat.roughness = 0.85;
    mat.side = T.DoubleSide;
    var mesh = new T.Mesh(geo, mat);
    mesh.position.y = 0.006; // 低于房间地面(0.02)，只用于补缝
    mesh.receiveShadow = true;
    mesh.userData.isBacker = true;
    mesh.userData.hideInWireframe = true;
    return mesh;
  }

  /** 顶棚：只在第一人称漫游时显示，让室内空间成立（俯视编辑时隐藏） */
  function buildCeiling(plan) {
    var geo = new T.ShapeGeometry(shapeFromPoly(plan.footprint));
    geo.rotateX(-Math.PI / 2);
    var mat = new T.MeshStandardMaterial({
      color: new T.Color('#f8f6f2'), roughness: 0.95, metalness: 0, side: T.DoubleSide
    });
    var mesh = new T.Mesh(geo, mat);
    mesh.name = 'ceiling';
    mesh.position.y = (state.wallHeight != null ? state.wallHeight : CFG.defaultWallHeight);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.visible = false;
    mesh.userData.noPick = true;
    mesh.userData.isCeiling = true;
    return mesh;
  }

  function setCeiling(on) {
    var c = world.scene.getObjectByName('ceiling');
    if (c) c.visible = !!on;
  }

  /** 阳台栏板：玻璃 / 实体 */
  function buildRail(rail) {
    var group = new T.Group();
    var dx = rail.x2 - rail.x1;
    var dz = rail.z2 - rail.z1;
    var len = Math.hypot(dx, dz);
    if (len < 0.05) return group;
    var alpha = Math.atan2(dz, dx);
    var h = rail.height || 1.05;
    var cx = (rail.x1 + rail.x2) / 2;
    var cz = (rail.z1 + rail.z2) / 2;

    var bodyMat = rail.kind === 'glass'
      ? makeMaterial(COLORS.railGlass, { transparent: true, opacity: 0.3 })
      : makeMaterial(COLORS.railSolid);
    var body = new T.Mesh(new T.BoxGeometry(len, h, 0.06), bodyMat);
    body.position.set(cx, h / 2, cz);
    body.rotation.y = -alpha;
    body.castShadow = rail.kind !== 'glass';
    body.receiveShadow = true;
    group.add(body);

    // 顶部扶手
    var railMat = makeMaterial('#c9ced4');
    railMat.metalness = 0.4;
    railMat.roughness = 0.35;
    var bar = new T.Mesh(new T.BoxGeometry(len, 0.05, 0.09), railMat);
    bar.position.set(cx, h + 0.025, cz);
    bar.rotation.y = -alpha;
    bar.castShadow = true;
    group.add(bar);

    group.userData.material = bodyMat;
    return group;
  }

  /** 楼梯：一层起步梯段（【原图模糊，尺寸为常规估算，支持界面手动调整】） */
  function buildStairs(st, plan) {
    var group = new T.Group();
    if (!st) return group;
    var x1 = Math.min(st.x1, st.x2);
    var x2 = Math.max(st.x1, st.x2);
    var z1 = Math.min(st.z1, st.z2);
    var z2 = Math.max(st.z1, st.z2);
    var width = x2 - x1;
    var run = z2 - z1;
    var steps = st.steps || 10;
    var rise = st.rise || 0.15;
    var tread = run / steps;
    var mat = makeMaterial(COLORS.stair);
    mat.roughness = 0.85;
    var edgeMat = new T.LineBasicMaterial({ color: 0xb9b0a0, transparent: true, opacity: 0.9 });

    for (var i = 0; i < steps; i++) {
      var h = (i + 1) * rise;
      // 由南（z2，低）向北（z1，高）上行
      var zc = z2 - tread * (i + 0.5);
      var geo = new T.BoxGeometry(width, h, tread);
      var mesh = new T.Mesh(geo, mat);
      mesh.position.set((x1 + x2) / 2, h / 2, zc);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      // 每级踏步描一圈棱线，俯视时台阶才清晰可读
      var el = new T.LineSegments(new T.EdgesGeometry(geo), edgeMat);
      el.position.copy(mesh.position);
      group.add(el);
    }
    group.userData.material = mat;
    return group;
  }

  /* ===========================================================================
   * 3.9 家具（按平面图位置还原，基础几何体拼装，白模浅色系）
   * 约定：局部 +X = 宽 w，局部 +Z = 深 d 且为「正面」，原点在平面中心、底面 y=0
   * ========================================================================= */

  function fBox(parent, mat, w, h, d, x, y, z) {
    var m = new T.Mesh(new T.BoxGeometry(Math.max(0.004, w), Math.max(0.004, h), Math.max(0.004, d)), mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  }

  /** 圆柱：默认轴向 Y；rotX=90 可做水平轴（洗衣机滚筒、把手等） */
  function fCyl(parent, mat, rTop, rBot, h, seg, x, y, z, rotX) {
    var m = new T.Mesh(new T.CylinderGeometry(rTop, rBot, h, seg || 16), mat);
    m.position.set(x, y, z);
    if (rotX) m.rotation.x = rotX;
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  }

  // 家具主体默认材质：布艺 / 木作 / 陶瓷分色，避免整屋一片米色
  var FURN_MAIN = {
    sofa: 'furnFabric', armchair: 'furnFabric', balcony_chair: 'furnFabricDeep',
    rug: 'furnRug', fridge: 'furnWhite', washer: 'furnWhite',
    toilet: 'furnCeramic', bathtub: 'furnCeramic', basin: 'furnWhite',
    counter: 'furnCounter', stool: 'furnWood'
  };

  function buildFurniture(it) {
    var g = new T.Group();
    var w = it.w, d = it.d;
    var h = it.h != null ? it.h : 0.6;
    var mainColor = it.color || COLORS[FURN_MAIN[it.type]] || COLORS.furnWood;
    var M = {
      main: makeMaterial(mainColor),
      deep: makeMaterial(COLORS.furnWoodDeep),
      soft: makeMaterial(COLORS.furnFabric),
      light: makeMaterial(COLORS.furnFabricDeep),
      white: makeMaterial(COLORS.furnWhite),
      ceramic: makeMaterial(COLORS.furnCeramic),
      metal: makeMaterial(COLORS.furnMetal),
      dark: makeMaterial(COLORS.furnDark),
      glass: makeMaterial(COLORS.furnGlass, { transparent: true, opacity: 0.5 }),
      green: makeMaterial(COLORS.furnGreen),
      green2: makeMaterial(COLORS.furnGreenDeep)
    };
    var i, k, px, pz;

    switch (it.type) {
      /* 床：床头在 -Z，床尾 +Z */
      case 'bed': {
        var hb = Math.min(0.95, h + 0.36);
        fBox(g, M.deep, w, 0.26, d, 0, 0.14, 0);
        fBox(g, M.white, w - 0.06, 0.24, d - 0.08, 0, 0.39, 0.03);
        fBox(g, M.soft, w - 0.10, 0.10, d * 0.52, 0, 0.51, d * 0.18);
        fBox(g, M.main, w, hb, 0.09, 0, hb / 2, -d / 2 + 0.045);
        var pn = w > 1.2 ? 2 : 1;
        for (i = 0; i < pn; i++) {
          px = pn === 1 ? 0 : (i === 0 ? -w * 0.22 : w * 0.22);
          fBox(g, M.white, Math.min(0.52, w * 0.36), 0.12, 0.32, px, 0.58, -d / 2 + 0.34);
        }
        break;
      }

      case 'nightstand':
        fBox(g, M.main, w, h - 0.04, d, 0, (h - 0.04) / 2, 0);
        fBox(g, M.light, w + 0.01, 0.04, d + 0.01, 0, h - 0.02, 0);
        fBox(g, M.metal, w * 0.3, 0.02, 0.02, 0, h * 0.62, d / 2 + 0.005);
        break;

      case 'wardrobe': {
        fBox(g, M.main, w, h, d, 0, h / 2, 0);
        fBox(g, M.light, w * 0.47, h - 0.12, 0.02, -w * 0.24, h / 2, d / 2 + 0.012);
        fBox(g, M.light, w * 0.47, h - 0.12, 0.02, w * 0.24, h / 2, d / 2 + 0.012);
        fBox(g, M.metal, 0.018, 0.18, 0.018, -w * 0.03, h * 0.55, d / 2 + 0.03);
        fBox(g, M.metal, 0.018, 0.18, 0.018, w * 0.03, h * 0.55, d / 2 + 0.03);
        fBox(g, M.deep, w + 0.03, 0.05, d + 0.03, 0, h - 0.025, 0);
        break;
      }

      /* 电视柜：柜体 + 电视（电视面朝 +Z 正面） */
      case 'tv_cabinet': {
        fBox(g, M.main, w, h, d, 0, h / 2, 0);
        fBox(g, M.deep, w + 0.01, 0.035, d + 0.01, 0, h - 0.018, 0);
        var tvW = Math.min(w * 0.68, 1.05), tvH = 0.62;
        fBox(g, M.dark, tvW, tvH, 0.04, 0, h + 0.02 + tvH / 2, -d * 0.24);
        fBox(g, M.dark, 0.18, 0.02, 0.11, 0, h + 0.012, -d * 0.24);
        break;
      }

      /* 沙发：靠背在 -Z，坐面向 +Z */
      case 'sofa':
        fBox(g, M.main, w, 0.30, d, 0, 0.19, 0);
        fBox(g, M.soft, w - 0.40, 0.14, d - 0.24, 0, 0.41, 0.05);
        fBox(g, M.main, w, 0.46, 0.20, 0, h - 0.23, -d / 2 + 0.10);
        fBox(g, M.soft, w - 0.42, 0.32, 0.12, 0, h - 0.32, -d / 2 + 0.25);
        for (i = 0; i < 2; i++) {
          px = (i === 0 ? -1 : 1) * (w / 2 - 0.085);
          fBox(g, M.main, 0.17, 0.34, d, px, 0.47, 0);
        }
        for (i = 0; i < 2; i++) {
          px = (i === 0 ? -1 : 1) * w * 0.26;
          fBox(g, M.light, 0.30, 0.28, 0.11, px, 0.54, -d / 2 + 0.33);
        }
        break;

      /* 单椅 / 休闲椅 */
      case 'armchair':
        fBox(g, M.main, w, 0.28, d, 0, 0.18, 0);
        fBox(g, M.soft, w - 0.26, 0.12, d - 0.20, 0, 0.37, 0.04);
        fBox(g, M.main, w, 0.44, 0.16, 0, h - 0.22, -d / 2 + 0.08);
        fBox(g, M.soft, w - 0.30, 0.28, 0.10, 0, h - 0.30, -d / 2 + 0.20);
        for (i = 0; i < 2; i++) {
          px = (i === 0 ? -1 : 1) * (w / 2 - 0.065);
          fBox(g, M.main, 0.13, 0.28, d, px, 0.44, 0);
        }
        break;

      case 'coffee_table':
        fBox(g, M.main, w, 0.05, d, 0, h - 0.025, 0);
        fBox(g, M.deep, w - 0.12, 0.03, d - 0.10, 0, 0.15, 0);
        for (i = 0; i < 4; i++) {
          px = (i < 2 ? -1 : 1) * (w / 2 - 0.06);
          pz = (i % 2 === 0 ? -1 : 1) * (d / 2 - 0.06);
          fBox(g, M.deep, 0.05, h - 0.05, 0.05, px, (h - 0.05) / 2, pz);
        }
        break;

      case 'rug': {
        var r = fBox(g, M.light, w, 0.014, d, 0, 0.008, 0);
        r.castShadow = false;
        r.userData.hideInWireframe = true;
        break;
      }

      case 'side_table':
        fBox(g, M.main, w, h - 0.06, d, 0, (h - 0.06) / 2, 0);
        fBox(g, M.deep, w + 0.02, 0.04, d + 0.02, 0, h - 0.02, 0);
        fCyl(g, M.metal, 0.018, 0.02, 0.20, 8, 0, h + 0.10, 0);
        fCyl(g, M.white, 0.10, 0.12, 0.15, 14, 0, h + 0.28, 0);
        break;

      case 'dining_table':
        fBox(g, M.main, w, 0.05, d, 0, h - 0.025, 0);
        for (i = 0; i < 4; i++) {
          px = (i < 2 ? -1 : 1) * (w / 2 - 0.07);
          pz = (i % 2 === 0 ? -1 : 1) * (d / 2 - 0.07);
          fBox(g, M.deep, 0.06, h - 0.05, 0.06, px, (h - 0.05) / 2, pz);
        }
        break;

      case 'chair': {
        var seatH = 0.44;
        fBox(g, M.main, w, 0.045, d, 0, seatH, 0);
        fBox(g, M.main, w * 0.88, h - seatH, 0.045, 0, seatH + (h - seatH) / 2, -d / 2 + 0.025);
        for (i = 0; i < 4; i++) {
          px = (i < 2 ? -1 : 1) * (w / 2 - 0.04);
          pz = (i % 2 === 0 ? -1 : 1) * (d / 2 - 0.04);
          fBox(g, M.deep, 0.04, seatH, 0.04, px, seatH / 2, pz);
        }
        break;
      }

      case 'desk':
        fBox(g, M.main, w, 0.045, d, 0, h, 0);
        fBox(g, M.light, 0.04, h, d - 0.05, -w / 2 + 0.03, h / 2, 0);
        fBox(g, M.light, 0.04, h, d - 0.05, w / 2 - 0.03, h / 2, 0);
        fBox(g, M.light, w - 0.10, 0.13, 0.02, 0, h - 0.09, -d / 2 + 0.02);
        fBox(g, M.dark, Math.min(w * 0.46, 0.48), 0.28, 0.025, 0, h + 0.19, -d / 2 + 0.09);
        fBox(g, M.dark, 0.15, 0.02, 0.09, 0, h + 0.03, -d / 2 + 0.09);
        break;

      case 'bookshelf':
        fBox(g, M.main, w, h, d, 0, h / 2, 0);
        for (i = 1; i <= 3; i++) {
          fBox(g, M.light, w + 0.01, 0.025, d + 0.01, 0, h * i / 4, 0);
        }
        for (i = 0; i < 8; i++) {
          var bw = w * 0.09;
          fBox(g, i % 3 === 0 ? M.light : M.deep, bw, h * 0.14 + (i % 4) * 0.02, d * 0.55,
            -w / 2 + 0.06 + i * (w - 0.12) / 8, h * 0.25 + (i % 2) * h * 0.25 + h * 0.07, 0.02);
        }
        break;

      case 'toilet':
        fBox(g, M.ceramic, w * 0.86, h * 0.42, d * 0.58, 0, h * 0.21, d * 0.16);
        fCyl(g, M.ceramic, w * 0.44, w * 0.40, 0.16, 18, 0, h * 0.42, d * 0.18);
        fBox(g, M.ceramic, w, h, d * 0.30, 0, h / 2, -d / 2 + d * 0.15);
        fBox(g, M.metal, w * 0.40, 0.02, 0.02, 0, h * 0.86, -d / 2 + d * 0.30);
        break;

      case 'bathtub': {
        var rim = Math.min(0.07, w * 0.08);
        fBox(g, M.ceramic, w, 0.12, d, 0, 0.06, 0);
        fBox(g, M.ceramic, w, h - 0.12, rim, 0, 0.12 + (h - 0.12) / 2, -d / 2 + rim / 2);
        fBox(g, M.ceramic, w, h - 0.12, rim, 0, 0.12 + (h - 0.12) / 2, d / 2 - rim / 2);
        fBox(g, M.ceramic, rim, h - 0.12, d - 2 * rim, -w / 2 + rim / 2, 0.12 + (h - 0.12) / 2, 0);
        fBox(g, M.ceramic, rim, h - 0.12, d - 2 * rim, w / 2 - rim / 2, 0.12 + (h - 0.12) / 2, 0);
        fBox(g, M.glass, w - 2 * rim - 0.02, 0.012, d - 2 * rim - 0.02, 0, h - 0.08, 0);
        break;
      }

      case 'basin':
        fBox(g, M.main, w, h - 0.07, d, 0, (h - 0.07) / 2, 0);
        fBox(g, M.ceramic, w + 0.02, 0.05, d + 0.02, 0, h - 0.035, 0);
        fCyl(g, M.ceramic, 0.15, 0.12, 0.10, 18, 0, h + 0.04, 0.02);
        fCyl(g, M.metal, 0.014, 0.014, 0.16, 8, 0, h + 0.09, -d / 2 + 0.07);
        break;

      case 'counter':
        fBox(g, M.main, w, h - 0.05, d, 0, (h - 0.05) / 2, 0);
        fBox(g, M.light, w + 0.02, 0.05, d + 0.02, 0, h - 0.025, 0);
        fBox(g, M.light, w, 0.50, 0.02, 0, h + 0.22, -d / 2 + 0.01);   // 挡水板
        for (i = 0; i < Math.max(2, Math.round(w / 0.55)); i++) {        // 柜门缝
          px = -w / 2 + (i + 0.5) * (w / Math.max(2, Math.round(w / 0.55)));
          fBox(g, M.light, 0.012, h - 0.16, 0.012, px, (h - 0.05) / 2, d / 2 + 0.005);
        }
        break;

      case 'sink':
        fBox(g, M.metal, w, 0.02, d, 0, 0.855, 0);
        fBox(g, M.dark, w - 0.09, 0.15, d - 0.09, 0, 0.785, 0);
        fCyl(g, M.metal, 0.014, 0.014, 0.20, 8, 0, 0.95, -d / 2 + 0.05);
        break;

      case 'stove':
        fBox(g, M.dark, w, 0.02, d, 0, 0.865, 0);
        for (i = 0; i < 2; i++) {
          px = (i === 0 ? -1 : 1) * w * 0.22;
          fCyl(g, M.metal, 0.095, 0.095, 0.016, 18, px, 0.878, 0);
          fCyl(g, M.dark, 0.045, 0.045, 0.020, 12, px, 0.882, 0);
        }
        break;

      case 'fridge':
        fBox(g, M.white, w, h, d, 0, h / 2, 0);
        fBox(g, M.light, w - 0.02, h * 0.34, 0.02, 0, h * 0.69, d / 2 + 0.011);
        fBox(g, M.light, w - 0.02, h * 0.56, 0.02, 0, h * 0.29, d / 2 + 0.011);
        fBox(g, M.metal, 0.03, 0.22, 0.025, w * 0.30, h * 0.50, d / 2 + 0.04);
        break;

      case 'washer':
        fBox(g, M.white, w, h, d, 0, h / 2, 0);
        fCyl(g, M.light, w * 0.32, w * 0.32, 0.02, 22, 0, h * 0.45, d / 2 + 0.005, Math.PI / 2);
        fCyl(g, M.dark, w * 0.20, w * 0.20, 0.03, 22, 0, h * 0.45, d / 2 + 0.015, Math.PI / 2);
        fBox(g, M.light, w - 0.06, 0.10, 0.015, 0, h - 0.09, d / 2 + 0.006);
        break;

      case 'plant': {
        var potR = w * 0.32;
        fCyl(g, M.deep, potR, potR * 0.82, 0.30, 14, 0, 0.15, 0);
        fCyl(g, M.green2, 0.018, 0.022, h * 0.5, 6, 0, 0.30 + h * 0.24, 0);
        var blobs = [[0, h * 0.78, 0, w * 0.42], [w * 0.20, h * 0.64, w * 0.12, w * 0.30], [-w * 0.19, h * 0.68, -w * 0.12, w * 0.26]];
        for (i = 0; i < blobs.length; i++) {
          var sp = new T.Mesh(new T.SphereGeometry(blobs[i][3], 12, 9), M.green);
          sp.position.set(blobs[i][0], blobs[i][1], blobs[i][2]);
          sp.scale.set(1, 0.82, 1);
          sp.castShadow = true;
          g.add(sp);
        }
        break;
      }

      case 'round_table':
        fCyl(g, M.main, w / 2, w / 2, 0.04, 24, 0, h - 0.02, 0);
        fCyl(g, M.deep, 0.035, 0.035, h - 0.06, 10, 0, (h - 0.06) / 2, 0);
        fCyl(g, M.deep, w * 0.28, w * 0.30, 0.03, 18, 0, 0.015, 0);
        break;

      case 'balcony_chair':
        fBox(g, M.main, w, 0.13, d, 0, 0.36, 0);
        fBox(g, M.light, w - 0.08, 0.07, d - 0.08, 0, 0.46, 0);
        fBox(g, M.main, w, 0.40, 0.07, 0, 0.62, -d / 2 + 0.045);
        for (i = 0; i < 4; i++) {
          px = (i < 2 ? -1 : 1) * (w / 2 - 0.05);
          pz = (i % 2 === 0 ? -1 : 1) * (d / 2 - 0.05);
          fBox(g, M.deep, 0.045, 0.36, 0.045, px, 0.18, pz);
        }
        break;

      default:
        fBox(g, M.main, w, h, d, 0, h / 2, 0);
    }

    g.userData.material = M.main;
    return g;
  }

  /* ===========================================================================
   * 4. 场景装配
   * ========================================================================= */

  function createStage(canvas) {
    var renderer = new T.WebGLRenderer({ canvas: canvas, antialias: true, alpha: false, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, 2));
    renderer.setClearColor(0xf2f4f7, 1);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = T.PCFSoftShadowMap;
    if ('outputColorSpace' in renderer) renderer.outputColorSpace = T.SRGBColorSpace;

    var scene = new T.Scene();
    scene.background = new T.Color(0xf2f4f7);
    // 不使用雾效：白模在远景（2D 顶视）下会被雾冲淡，画面发灰

    var camera = new T.PerspectiveCamera(CFG.fov3d, 1, 0.05, 300);
    // 2D 顶视使用正交相机（标准平面图，无透视变形）
    var camera2d = new T.OrthographicCamera(-10, 10, 10, -10, 0.1, 200);

    // 白模布光：高环境光打底（保证墙面接近纯白）+ 高空主光（短阴影）+ 反向补光
    scene.add(new T.AmbientLight(0xffffff, 0.66));

    var hemi = new T.HemisphereLight(0xffffff, 0xeceef1, 0.10);
    scene.add(hemi);

    var dir = new T.DirectionalLight(0xffffff, 0.22);
    dir.position.set(-7, 26, 9);
    dir.castShadow = true;
    dir.shadow.mapSize.set(2048, 2048);
    dir.shadow.camera.left = -14;
    dir.shadow.camera.right = 14;
    dir.shadow.camera.top = 14;
    dir.shadow.camera.bottom = -14;
    dir.shadow.camera.near = 1;
    dir.shadow.camera.far = 80;
    dir.shadow.bias = -0.0008;
    scene.add(dir);
    scene.add(dir.target);
    world.sun = dir;

    var fill = new T.DirectionalLight(0xffffff, 0.08);
    fill.position.set(9, 14, -10);
    scene.add(fill);

    // 地面 + 网格
    var groundMat = new T.MeshStandardMaterial({ color: new T.Color(COLORS.ground), roughness: 0.95, metalness: 0 });
    var ground = new T.Mesh(new T.PlaneGeometry(120, 120), groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -CFG.slabThickness - 0.01;
    ground.receiveShadow = true;
    ground.name = 'ground';
    scene.add(ground);

    var grid = new T.GridHelper(80, 160, 0xdfe4ea, 0xeaedf1);
    grid.position.y = -CFG.slabThickness + 0.002;
    grid.material.transparent = true;
    grid.material.opacity = 0.75;
    grid.name = 'grid';
    scene.add(grid);

    var OrbitControls = T.OrbitControls || global.OrbitControls;
    var controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI * 0.495;
    controls.minDistance = 3;
    controls.maxDistance = 240; // 2D 顶视需要很远的相机距离
    controls.screenSpacePanning = false;
    controls.mouseButtons = { LEFT: T.MOUSE.ROTATE, MIDDLE: T.MOUSE.DOLLY, RIGHT: T.MOUSE.PAN };

    world.renderer = renderer;
    world.scene = scene;
    world.camera = camera;
    world.camera3d = camera;
    world.camera2d = camera2d;
    world.controls = controls;

    world.root = new T.Group();
    world.root.name = 'house';
    scene.add(world.root);

    return world;
  }

  function setCameraHome(instant) {
    var plan = world.plan;
    var cx = 6.75, cz = 3.64;
    if (plan && plan.footprint) {
      var xs = plan.footprint.map(function (p) { return p[0]; });
      var zs = plan.footprint.map(function (p) { return p[1]; });
      cx = (Math.min.apply(null, xs) + Math.max.apply(null, xs)) / 2;
      cz = (Math.min.apply(null, zs) + Math.max.apply(null, zs)) / 2;
    }
    // 若当前处于 2D 正交视图，先切回透视相机
    if (world.camera !== world.camera3d) {
      world.camera = world.camera3d;
      world.controls.object = world.camera3d;
      world.controls.enableRotate = true;
      world.controls.mouseButtons.LEFT = T.MOUSE.ROTATE;
      state.view = '3d';
    }
    var cam3 = world.camera3d;
    cam3.fov = CFG.fov3d;
    cam3.aspect = (world.renderer.domElement.clientWidth || 1600) / Math.max(1, world.renderer.domElement.clientHeight || 950);
    cam3.updateProjectionMatrix();
    // 抬高俯角（约 61°），既能看出体块又不至于被外墙完全挡住室内
    var pos = new T.Vector3(cx + 5.0, 19.5, cz + 9.5);
    var tgt = new T.Vector3(cx, 0.4, cz);
    if (instant) {
      cam3.position.copy(pos);
      world.controls.target.copy(tgt);
      world.controls.update();
    } else {
      flyTo(pos, tgt, 620);
    }
  }

  var fly = null;
  function flyTo(pos, target, ms) {
    fly = {
      t0: performance.now(),
      ms: ms || 600,
      fromP: world.camera.position.clone(),
      fromT: world.controls.target.clone(),
      toP: pos.clone(),
      toT: target.clone()
    };
  }

  function updateFly(now) {
    if (!fly) return;
    var k = Math.min(1, (now - fly.t0) / fly.ms);
    var e = k < 0.5 ? 2 * k * k : -1 + (4 - 2 * k) * k; // easeInOutQuad
    world.camera.position.lerpVectors(fly.fromP, fly.toP, e);
    world.controls.target.lerpVectors(fly.fromT, fly.toT, e);
    world.controls.update();
    if (k >= 1) fly = null;
  }

  /* ===========================================================================
   * 5. 重建
   * ========================================================================= */

  function disposeGroup(g) {
    if (!g) return;
    g.traverse(function (o) {
      if (o.geometry) o.geometry.dispose();
      if (o.material && o.material.dispose) o.material.dispose();
    });
    while (g.children.length) g.remove(g.children[0]);
  }

  function rebuildAll() {
    var plan = world.plan;
    if (!world.root) return;
    disposeGroup(world.root);
    world.root = new T.Group();
    world.root.name = 'house';
    world.scene.add(world.root);

    world.root.add(buildBaseSlab(plan));
    var backer = buildFloorBacker(plan);
    world.root.add(backer);
    world.root.add(buildCeiling(plan));   // 默认隐藏，漫游时打开

    plan.rooms.forEach(function (room) {
      var mesh = buildRoomFloor(room);
      mesh.userData.componentId = room.id;
      mesh.userData.componentType = 'room';
      mesh.userData.hideInWireframe = true;
      world.root.add(mesh);
    });

    plan.walls.forEach(function (wall) {
      var g = buildWallGroup(wall, plan);
      if (!g.children.length) return;
      g.name = wall.id;
      g.userData.componentId = wall.id;
      g.userData.componentType = 'wall';
      g.traverse(function (o) { if (o.isMesh) { o.userData.componentId = wall.id; o.userData.componentType = 'wall'; } });
      world.root.add(g);
    });

    (plan.rails || []).forEach(function (rail) {
      var g = buildRail(rail);
      if (!g.children.length) return;
      g.name = rail.id;
      g.userData.componentId = rail.id;
      g.userData.componentType = 'rail';
      g.traverse(function (o) { if (o.isMesh) { o.userData.componentId = rail.id; o.userData.componentType = 'rail'; } });
      world.root.add(g);
    });

    var stairGroup = buildStairs(plan.stairs, plan);
    if (plan.stairs && stairGroup.children.length) {
      stairGroup.name = plan.stairs.id;
      stairGroup.userData.componentId = plan.stairs.id;
      stairGroup.userData.componentType = 'stair';
      stairGroup.traverse(function (o) { if (o.isMesh) { o.userData.componentId = plan.stairs.id; o.userData.componentType = 'stair'; } });
      world.root.add(stairGroup);
    }

    plan.doors.forEach(function (door) {
      var g = buildDoorGroup(door, plan);
      if (!g.children.length) return;
      g.name = door.id;
      g.userData.componentId = door.id;
      g.userData.componentType = 'door';
      g.traverse(function (o) { if (o.isMesh) { o.userData.componentId = door.id; o.userData.componentType = 'door'; } });
      world.root.add(g);
    });

    plan.windows.forEach(function (win) {
      var g = buildWindowGroup(win, plan);
      if (!g.children.length) return;
      g.name = win.id;
      g.userData.componentId = win.id;
      g.userData.componentType = 'window';
      g.traverse(function (o) { if (o.isMesh) { o.userData.componentId = win.id; o.userData.componentType = 'window'; } });
      world.root.add(g);
    });

    // 家具：按原图位置摆放，可单独选中 / 改尺寸 / 改色
    (plan.furniture || []).forEach(function (it) {
      var g = buildFurniture(it);
      g.name = it.id;
      g.position.set(it.x, 0, it.z);
      g.rotation.y = T.MathUtils.degToRad(it.rot || 0);
      g.userData.componentId = it.id;
      g.userData.componentType = 'furniture';
      g.traverse(function (o) {
        if (o.isMesh) {
          o.userData.componentId = it.id;
          o.userData.componentType = 'furniture';
          o.userData.hideInWireframe = true;  // 线框模式只表达结构，家具隐藏
        }
      });
      world.root.add(g);
    });

    // 房间名标签
    world.labelGroup = new T.Group();
    world.labelGroup.name = 'labels';
    plan.rooms.forEach(function (room) {
      var lb = buildRoomLabel(room);
      lb.userData.isLabel = true; // 标签不参与拾取 / 线框
      lb.userData.componentId = room.id;
      world.labelGroup.add(lb);
    });
    world.labelGroup.visible = state.labels;
    world.root.add(world.labelGroup);

    if (state.wireframe) applyWireframe(true);
    if (world.onRebuild) world.onRebuild();
  }

  /** 只重建单个构件（拖拽时逐帧调用，避免整场景重建） */
  function rebuildOne(id) {
    var plan = world.plan;
    var old = world.root.getObjectByName(id);
    if (old) {
      world.root.remove(old);
      disposeGroup(old);
    }
    var comp = null, g = null, compType = '';
    var w = plan.walls.filter(function (x) { return x.id === id; })[0];
    if (w) { comp = w; g = buildWallGroup(w, plan); compType = 'wall'; }
    if (!g || !g.children.length) {
      g = null;
      var d = plan.doors.filter(function (x) { return x.id === id; })[0];
      if (d) { comp = d; g = buildDoorGroup(d, plan); compType = 'door'; }
    }
    if (!g || !g.children.length) {
      g = null;
      var win = plan.windows.filter(function (x) { return x.id === id; })[0];
      if (win) { comp = win; g = buildWindowGroup(win, plan); compType = 'window'; }
    }
    if (!g || !g.children.length) {
      g = null;
      var r = (plan.rails || []).filter(function (x) { return x.id === id; })[0];
      if (r) { comp = r; g = buildRail(r); compType = 'rail'; }
    }
    if (!g || !g.children.length) {
      g = null;
      var f = (plan.furniture || []).filter(function (x) { return x.id === id; })[0];
      if (f) {
        comp = f;
        g = buildFurniture(f);
        compType = 'furniture';
        g.position.set(f.x, 0, f.z);
        g.rotation.y = T.MathUtils.degToRad(f.rot || 0);
        g.traverse(function (o) { if (o.isMesh) o.userData.hideInWireframe = true; });
      }
    }
    if (!g || !comp) return null;
    g.name = id;
    g.userData.componentId = id;
    g.userData.componentType = compType;
    g.traverse(function (o) {
      if (o.isMesh) { o.userData.componentId = id; o.userData.componentType = compType; }
    });
    world.root.add(g);    if (state.wireframe) applyWireframe(true);
    return g;
  }

  /* ===========================================================================
   * 6. 视图模式
   * ========================================================================= */
  function setView(mode) {
    state.view = mode;
    var plan = world.plan;
    var xs = plan.footprint.map(function (p) { return p[0]; });
    var zs = plan.footprint.map(function (p) { return p[1]; });
    var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
    var minZ = Math.min.apply(null, zs), maxZ = Math.max.apply(null, zs);
    var cx = (minX + maxX) / 2;
    var cz = (minZ + maxZ) / 2;
    var w = maxX - minX;
    var d = maxZ - minZ;

    // 2D 平面视图下隐藏地面与网格：避免建筑投影拖出一片灰影，保持图纸感
    var ground = world.scene.getObjectByName('ground');
    var grid = world.scene.getObjectByName('grid');
    if (ground) ground.visible = mode !== '2d';
    if (grid) grid.visible = mode !== '2d';

    // 2D 时把主光改为正上方：阴影正好落在墙体自身下方，平面图不会被墙面阴影打花
    if (world.sun) {
      if (mode === '2d') world.sun.position.set(cx, 40, cz);
      else world.sun.position.set(cx - 7, 26, cz + 9);
      world.sun.target.position.set(cx, 0, cz);
      world.sun.target.updateMatrixWorld();
      world.sun.updateMatrixWorld();
    }

    // 2D 平面图里房间名要压在家具之上才读得清；3D 视图恢复被遮挡的真实关系
    if (world.labelGroup) {
      world.labelGroup.children.forEach(function (lb) {
        if (lb.material) {
          lb.material.depthTest = mode !== '2d';
          lb.material.needsUpdate = true;
        }
        lb.renderOrder = mode === '2d' ? 6 : 0;
      });
    }

    // 右侧属性面板是否占位：面板收起时户型才居中
    var inspector = document.getElementById('inspector');
    var panelVisible = !!(inspector && !inspector.classList.contains('is-hidden'));
    var cw = world.renderer.domElement.clientWidth || 1600;
    var ch = world.renderer.domElement.clientHeight || 950;
    var aspect = cw / Math.max(1, ch);
    var panelRatio = panelVisible ? 324 / Math.max(640, cw) : 0.0;
    var availRatio = Math.max(0.62, 1 - panelRatio - 0.03);

    if (mode === '2d') {
      // —— 真·正投影：使用 OrthographicCamera，得到标准平面图 ——
      var cam2 = world.camera2d;
      var halfH = Math.max(d * 0.70, (w / availRatio * 0.56) / aspect);
      cam2.top = halfH;
      cam2.bottom = -halfH;
      cam2.left = -halfH * aspect;
      cam2.right = halfH * aspect;
      cam2.near = 0.1;
      cam2.far = 200;
      cam2.up.set(0, 0, -1); // 屏幕上方向 = 北
      cam2.zoom = 1;
      cam2.updateProjectionMatrix();
      var shiftX = panelRatio > 0 ? (w / availRatio - w) * 0.5 : 0;
      cam2.position.set(cx + shiftX, 60, cz);
      cam2.lookAt(cx + shiftX, 0, cz);
      cam2.updateMatrixWorld();

      world.camera = cam2;
      world.controls.object = cam2;
      world.controls.enableRotate = false;
      world.controls.mouseButtons.LEFT = T.MOUSE.PAN;
      world.controls.target.set(cx + shiftX, 0, cz);
      world.controls.update();
    } else {
      // —— 3D 透视 ——
      var cam3 = world.camera3d;
      cam3.fov = CFG.fov3d;
      cam3.aspect = aspect;
      cam3.updateProjectionMatrix();
      world.camera = cam3;
      world.controls.object = cam3;
      world.controls.enableRotate = true;
      world.controls.mouseButtons.LEFT = T.MOUSE.ROTATE;
      world.controls.target.set(cx, 0.4, cz);
      world.controls.update();
      flyTo(new T.Vector3(cx + 5.0, 19.5, cz + 9.5), new T.Vector3(cx, 0.4, cz), 560);
    }
  }

  function setLabels(on) {
    state.labels = on;
    if (world.labelGroup) world.labelGroup.visible = on;
  }

  function setWallHeight(h) {
    state.wallHeight = h;
    rebuildAll();
  }

  function focusOn(id) {
    var g = world.root.getObjectByName(id);
    if (!g) return;
    var box = new T.Box3().setFromObject(g);
    if (box.isEmpty()) return;
    var c = box.getCenter(new T.Vector3());
    var size = box.getSize(new T.Vector3());
    var dist = Math.max(size.x, size.y, size.z) * 2.6 + 2.2;
    var dirv = new T.Vector3(1, 1.15, 1).normalize();
    flyTo(c.clone().add(dirv.multiplyScalar(dist)), c, 480);
  }

  /* ===========================================================================
   * 7. 启动
   * ========================================================================= */
  function boot(canvas) {
    world.plan = createDefaultPlan();
    createStage(canvas);
    rebuildAll();
    setCameraHome(true);
    resize();
    return world;
  }

  function resize() {
    if (!world.renderer) return;
    var el = world.renderer.domElement;
    var w = el.clientWidth || el.parentNode.clientWidth || global.innerWidth;
    var h = el.clientHeight || el.parentNode.clientHeight || global.innerHeight;
    world.renderer.setSize(w, h, false);
    var aspect = w / Math.max(1, h);
    if (world.camera3d) {
      world.camera3d.aspect = aspect;
      world.camera3d.updateProjectionMatrix();
    }
    if (state.view === '2d') setView('2d'); // 正交视锥需要按新宽高重新适配
  }

  /* ===========================================================================
   * 7.5 漫游碰撞体
   * 由当前几何状态生成 2D OBB 列表（XZ 平面），供第一人称漫游做「不穿模」检测。
   * 墙体只取「人体高度范围内真正挡路」的实心段：门窗洞口自然成为可通行通道，
   * 洞口的过梁（y0 高于 1.6m）不参与碰撞，人可以从下面走过。
   * ========================================================================= */
  function buildColliders(plan) {
    var out = [];
    function push(x, z, hx, hz, rot, tag) {
      out.push({ x: x, z: z, hx: hx, hz: hz, cos: Math.cos(rot), sin: Math.sin(rot), tag: tag });
    }

    (plan.walls || []).forEach(function (wall) {
      var dx = wall.x2 - wall.x1;
      var dz = wall.z2 - wall.z1;
      var len = Math.hypot(dx, dz);
      if (len < 0.03) return;
      var ux = dx / len, uz = dz / len;
      var alpha = Math.atan2(dz, dx);
      var openings = collectOpenings(wall, plan);
      var cursor = 0, segs = [];
      openings.forEach(function (o) {
        // 只有「落地开口」（门洞、通口）才形成可通行缺口；
        // 窗洞下方仍有窗台墙，人体高度上是实心的，必须挡人。
        if (o.sill > 0.05) return;
        if (o.t0 > cursor) segs.push([cursor, o.t0]);
        cursor = Math.max(cursor, o.t1);
      });
      if (cursor < len) segs.push([cursor, len]);
      segs.forEach(function (s) {
        if (s[1] - s[0] < 0.06) return;
        var mid = (s[0] + s[1]) / 2;
        // 局部 X 沿墙方向 → 旋转角取 -alpha（与 mesh 的 rotation.y 同一条约定）
        push(wall.x1 + ux * mid, wall.z1 + uz * mid, (s[1] - s[0]) / 2, wall.thickness / 2, -alpha, 'wall');
      });
    });

    (plan.rails || []).forEach(function (rail) {
      var dx = rail.x2 - rail.x1;
      var dz = rail.z2 - rail.z1;
      var len = Math.hypot(dx, dz);
      if (len < 0.03) return;
      push((rail.x1 + rail.x2) / 2, (rail.z1 + rail.z2) / 2, len / 2, 0.05, -Math.atan2(dz, dx), 'rail');
    });

    // 楼梯：整段当作不可穿越的实体（本模型只表达一层起步梯段，不做爬升）
    if (plan.stairs) {
      var st = plan.stairs;
      push((st.x1 + st.x2) / 2, (st.z1 + st.z2) / 2,
        Math.abs(st.x2 - st.x1) / 2, Math.abs(st.z2 - st.z1) / 2, 0, 'stair');
    }

    (plan.furniture || []).forEach(function (it) {
      if (it.solid === false) return;
      if (it.type === 'rug') return;
      // 家具碰撞盒略收 6%，避免贴着家具时被卡住
      push(it.x, it.z, it.w * 0.47, it.d * 0.47, T.MathUtils.degToRad(it.rot || 0), 'furniture');
    });

    return out;
  }

  /* ===========================================================================
   * 8. 对外 API（editor.js 只通过这里操作场景）
   * ========================================================================= */
  global.House3D = {
    CFG: CFG,
    COLORS: COLORS,
    state: state,
    world: world,
    createDefaultPlan: createDefaultPlan,
    boot: boot,
    resize: resize,
    rebuildAll: rebuildAll,
    rebuildOne: rebuildOne,
    setView: setView,
    setLabels: setLabels,
    setWallHeight: setWallHeight,
    applyWireframe: applyWireframe,
    focusOn: focusOn,
    flyTo: flyTo,
    setCameraHome: setCameraHome,
    updateFly: updateFly,
    calcArea: calcArea,
    centroid: centroid,
    buildColliders: buildColliders,
    setCeiling: setCeiling,
    // 供编辑器渲染属性面板时复用
    _internal: { collectOpenings: collectOpenings, makeMaterial: makeMaterial }
  };
})(window);
