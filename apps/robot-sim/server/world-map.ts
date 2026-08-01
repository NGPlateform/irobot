// 世界地图：障碍物（AABB）+ 占据栅格（unknown/free/occupied）。纯逻辑、无 IO，可单测。
// 负责：程序化生成障碍环境、激光雷达扫描、占据累积建图、A* 避障路径、序列化。
// 障碍与 S3「危险区」是两个概念：这里的 obstacles 是物理障碍（避障 + 建图占据）。

export interface Aabb {
  x: number; // 中心
  y: number;
  w: number; // 全宽
  h: number; // 全高
  kind?: "tree" | "rock"; // 客户端按此渲染低多边形树/岩
}
export type Station = { x: number; y: number };

export interface WorldMapData {
  bounds: { W: number; H: number };
  resolution: number;
  cols: number;
  rows: number;
  obstacles: Aabb[];
  stations: Record<string, Station>;
  occupancy: number[]; // 长度 cols*rows，0 未知 / 1 空 / 2 占据
  terrainSeed: number; // 客户端据此程序化生成地形
  river: Station[]; // 河流折线（半程溪流，不可通行）
  riverWidth: number;
}

export const UNKNOWN = 0;
export const FREE = 1;
export const OCCUPIED = 2;

const DEFAULT_STATIONS: Record<string, Station> = {
  一号站点: { x: 8, y: 1.5 },
  二号站点: { x: 8, y: 6 },
  大厅: { x: 4.5, y: 6.5 },
};
// 各机器人起始/充电位（fleet.ts）——生成障碍时需避开。
const STARTS: Station[] = [{ x: 1, y: 1 }, { x: 1, y: 7 }, { x: 8.5, y: 1 }, { x: 8.5, y: 7 }];

/** 确定性 PRNG，保证 generate(seed) 可复现（可单测）。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class WorldMap {
  readonly W = 9.5;
  readonly H = 8;
  readonly res = 0.25;
  readonly cols: number;
  readonly rows: number;
  readonly robotRadius = 0.28;
  private occ: Uint8Array;
  obstacles: Aabb[] = [];
  stations: Record<string, Station> = { ...DEFAULT_STATIONS };
  terrainSeed = 0;
  river: Station[] = [];
  riverWidth = 0.8;
  /** 占据有变化时置位，供 Session 节流广播。 */
  dirty = false;

  constructor() {
    this.cols = Math.ceil(this.W / this.res);
    this.rows = Math.ceil(this.H / this.res);
    this.occ = new Uint8Array(this.cols * this.rows);
  }

  // ---- 栅格坐标 ----
  private cx(x: number): number { return Math.min(this.cols - 1, Math.max(0, Math.floor(x / this.res))); }
  private cy(y: number): number { return Math.min(this.rows - 1, Math.max(0, Math.floor(y / this.res))); }
  private cellCenter(cx: number, cy: number): Station { return { x: (cx + 0.5) * this.res, y: (cy + 0.5) * this.res }; }
  private get(cx: number, cy: number): number { return this.occ[cy * this.cols + cx] ?? UNKNOWN; }
  private set(cx: number, cy: number, v: number): void {
    const i = cy * this.cols + cx;
    if (i >= 0 && i < this.occ.length && this.occ[i] !== v) { this.occ[i] = v; this.dirty = true; }
  }

  /** 点是否落在某障碍内 / 河流内（可加机器人半径 margin，用于避障膨胀）。 */
  pointBlocked(x: number, y: number, margin = 0): boolean {
    if (x < margin || y < margin || x > this.W - margin || y > this.H - margin) return true;
    for (const o of this.obstacles) {
      if (Math.abs(x - o.x) <= o.w / 2 + margin && Math.abs(y - o.y) <= o.h / 2 + margin) return true;
    }
    if (this.river.length >= 2 && this.distToRiver(x, y) <= this.riverWidth / 2 + margin) return true;
    return false;
  }

  /** 点到河流折线的最近距离（河流不可通行）。 */
  distToRiver(x: number, y: number): number {
    let best = Infinity;
    for (let i = 0; i + 1 < this.river.length; i++) {
      const a = this.river[i]!, b = this.river[i + 1]!;
      const dx = b.x - a.x, dy = b.y - a.y;
      const len2 = dx * dx + dy * dy || 1e-9;
      let t = ((x - a.x) * dx + (y - a.y) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const px = a.x + t * dx, py = a.y + t * dy;
      best = Math.min(best, Math.hypot(x - px, y - py));
    }
    return best;
  }

  // ---- 生成 ----
  generate(seed: number): void {
    const rnd = mulberry32(seed || 1);
    this.terrainSeed = (seed || 1) >>> 0;
    this.obstacles = [];

    // 半程溪流：从一条随机边中点进入，2-4 段折向地图内部（止于 ~60% 处），不完全横穿以保连通。
    this.riverWidth = 0.7 + rnd() * 0.3;
    const edge = Math.floor(rnd() * 4);
    let sx: number, sy: number, tx: number, ty: number;
    if (edge === 0) { sx = 1 + rnd() * (this.W - 2); sy = 0; tx = this.W * 0.5; ty = this.H * 0.55; }
    else if (edge === 1) { sx = 1 + rnd() * (this.W - 2); sy = this.H; tx = this.W * 0.5; ty = this.H * 0.45; }
    else if (edge === 2) { sx = 0; sy = 1 + rnd() * (this.H - 2); tx = this.W * 0.55; ty = this.H * 0.5; }
    else { sx = this.W; sy = 1 + rnd() * (this.H - 2); tx = this.W * 0.45; ty = this.H * 0.5; }
    const segs = 2 + Math.floor(rnd() * 3);
    this.river = [{ x: sx, y: sy }];
    for (let i = 1; i <= segs; i++) {
      const t = i / segs;
      const jx = (rnd() - 0.5) * 1.6, jy = (rnd() - 0.5) * 1.6;
      this.river.push({
        x: Math.max(0.3, Math.min(this.W - 0.3, sx + (tx - sx) * t + (i < segs ? jx : 0))),
        y: Math.max(0.3, Math.min(this.H - 0.3, sy + (ty - sy) * t + (i < segs ? jy : 0))),
      });
    }

    const keepClear = (x: number, y: number, r: number): boolean => {
      for (const s of Object.values(this.stations)) if (Math.hypot(x - s.x, y - s.y) < r) return false;
      for (const s of STARTS) if (Math.hypot(x - s.x, y - s.y) < r) return false;
      if (this.distToRiver(x, y) < this.riverWidth / 2 + 0.5) return false; // 障碍避开河流
      return true;
    };
    const target = 9 + Math.floor(rnd() * 6); // 9..14（多为树，营造林地）
    let tries = 0;
    while (this.obstacles.length < target && tries < 600) {
      tries++;
      const w = 0.55 + rnd() * 0.9;
      const h = 0.55 + rnd() * 0.9;
      const x = 1 + rnd() * (this.W - 2);
      const y = 1 + rnd() * (this.H - 2);
      if (!keepClear(x, y, 1.2)) continue;
      const cand: Aabb = { x, y, w, h, kind: rnd() < 0.75 ? "tree" : "rock" };
      const overlaps = this.obstacles.some(
        (o) => Math.abs(o.x - x) < (o.w + w) / 2 + 0.5 && Math.abs(o.y - y) < (o.h + h) / 2 + 0.5,
      );
      if (overlaps) continue;
      this.obstacles.push(cand);
    }
    this.clearOccupancy();
  }

  clearOccupancy(): void {
    this.occ.fill(UNKNOWN);
    this.dirty = true;
  }

  // ---- 激光雷达扫描（权威，服务器侧）----
  /** 从 (px,py) 沿角度 ang 到最近墙/障碍的距离。 */
  private rangeAt(px: number, py: number, ang: number, maxRange: number): { dist: number; hitObstacle: boolean } {
    const dx = Math.cos(ang), dy = Math.sin(ang);
    let best = maxRange, hit = false;
    // 墙
    const wallT = (dir: number, p: number, size: number): number => {
      if (dir > 1e-9) return (size - p) / dir;
      if (dir < -1e-9) return (0 - p) / dir;
      return Infinity;
    };
    best = Math.min(best, Math.max(0, Math.min(wallT(dx, px, this.W), wallT(dy, py, this.H))));
    // 障碍（slab 法）
    for (const o of this.obstacles) {
      const minx = o.x - o.w / 2, maxx = o.x + o.w / 2, miny = o.y - o.h / 2, maxy = o.y + o.h / 2;
      let t0 = 0, t1 = maxRange;
      for (const [p, d, lo, hi] of [[px, dx, minx, maxx], [py, dy, miny, maxy]] as const) {
        if (Math.abs(d) < 1e-9) { if (p < lo || p > hi) { t0 = Infinity; break; } continue; }
        let ta = (lo - p) / d, tb = (hi - p) / d;
        if (ta > tb) { const s = ta; ta = tb; tb = s; }
        t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
        if (t0 > t1) break;
      }
      if (t0 <= t1 && t0 > 1e-6 && t0 < best) { best = t0; hit = true; }
    }
    return { dist: best, hitObstacle: hit };
  }

  scan(pose: { x: number; y: number }, rays = 90, maxRange = 5): number[] {
    const out: number[] = [];
    for (let i = 0; i < rays; i++) {
      out.push(this.rangeAt(pose.x, pose.y, (i / rays) * Math.PI * 2, maxRange).dist);
    }
    return out;
  }

  /** 用一圈扫描累积占据：射线途经 cell 标 free，命中障碍的落点 cell 标 occupied。 */
  integrateScan(pose: { x: number; y: number }, rays = 72, maxRange = 4.5): void {
    for (let i = 0; i < rays; i++) {
      const ang = (i / rays) * Math.PI * 2;
      const { dist, hitObstacle } = this.rangeAt(pose.x, pose.y, ang, maxRange);
      const dx = Math.cos(ang), dy = Math.sin(ang);
      const step = this.res * 0.5;
      for (let d = 0; d < dist - 1e-6; d += step) {
        const gx = this.cx(pose.x + dx * d), gy = this.cy(pose.y + dy * d);
        if (this.get(gx, gy) !== OCCUPIED) this.set(gx, gy, FREE);
      }
      if (hitObstacle && dist < maxRange) {
        this.set(this.cx(pose.x + dx * dist), this.cy(pose.y + dy * dist), OCCUPIED);
      }
    }
  }

  coverage(): number {
    let known = 0;
    for (let i = 0; i < this.occ.length; i++) if (this.occ[i] !== UNKNOWN) known++;
    return known / this.occ.length;
  }

  /** 从 from 所在 cell 出发，在非阻挡 cell 上 BFS，返回可达掩码。 */
  private reachableMask(from: { x: number; y: number }): Uint8Array {
    const n = this.cols * this.rows;
    const seen = new Uint8Array(n);
    const passable = (i: number): boolean => {
      const c = this.cellCenter(i % this.cols, Math.floor(i / this.cols));
      return !this.pointBlocked(c.x, c.y, this.robotRadius);
    };
    const start = this.cy(from.y) * this.cols + this.cx(from.x);
    const queue = [start]; seen[start] = 1; // 起点视为可达（机器人就在那）
    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++]!;
      const cxx = cur % this.cols, cyy = Math.floor(cur / this.cols);
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
        const nx = cxx + dx, ny = cyy + dy;
        if (nx < 0 || ny < 0 || nx >= this.cols || ny >= this.rows) continue;
        const ni = ny * this.cols + nx;
        if (seen[ni] || !passable(ni)) continue;
        seen[ni] = 1; queue.push(ni);
      }
    }
    return seen;
  }

  /** 前沿探索：找最近可达的"已知空地邻接未知"的前沿点；无则返回 null（可达区已探完）。 */
  nextFrontier(from: { x: number; y: number }): Station | null {
    const reach = this.reachableMask(from);
    let best: Station | null = null, bestD = Infinity;
    for (let cy = 0; cy < this.rows; cy++) {
      for (let cx = 0; cx < this.cols; cx++) {
        if (this.get(cx, cy) !== FREE) continue;
        if (!reach[cy * this.cols + cx]) continue; // 必须可达
        const nbrUnknown =
          this.get(cx - 1, cy) === UNKNOWN || this.get(cx + 1, cy) === UNKNOWN ||
          this.get(cx, cy - 1) === UNKNOWN || this.get(cx, cy + 1) === UNKNOWN;
        if (!nbrUnknown) continue;
        const pt = this.cellCenter(cx, cy);
        const d = Math.hypot(pt.x - from.x, pt.y - from.y);
        if (d < 0.6) continue; // 太近略过
        if (d < bestD) { bestD = d; best = pt; }
      }
    }
    return best;
  }

  // ---- A* 避障路径 ----
  /** 返回从 from 到 to 的航点（不含起点，含 to）。无障碍无河时 = [to]（直线）。 */
  pathfind(from: { x: number; y: number }, to: { x: number; y: number }): Station[] {
    if (this.obstacles.length === 0 && this.river.length < 2) return [{ x: to.x, y: to.y }];
    const sc = this.cy(from.y) * this.cols + this.cx(from.x);
    const gc = this.cy(to.y) * this.cols + this.cx(to.x);
    if (sc === gc) return [{ x: to.x, y: to.y }];
    const n = this.cols * this.rows;
    const blocked = (i: number): boolean => {
      const cxx = i % this.cols, cyy = Math.floor(i / this.cols);
      const c = this.cellCenter(cxx, cyy);
      return this.pointBlocked(c.x, c.y, this.robotRadius);
    };
    const g = new Float64Array(n).fill(Infinity);
    const f = new Float64Array(n).fill(Infinity);
    const came = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    const hx = (i: number) => {
      const ax = i % this.cols, ay = Math.floor(i / this.cols);
      const bx = gc % this.cols, by = Math.floor(gc / this.cols);
      const dxa = Math.abs(ax - bx), dya = Math.abs(ay - by);
      return (dxa + dya) + (Math.SQRT2 - 2) * Math.min(dxa, dya);
    };
    g[sc] = 0; f[sc] = hx(sc);
    // 简单二叉堆
    const heap: number[] = [sc];
    const less = (a: number, b: number) => (f[a] ?? Infinity) < (f[b] ?? Infinity);
    const push = (v: number) => { heap.push(v); let c = heap.length - 1; while (c > 0) { const p = (c - 1) >> 1; if (less(heap[c]!, heap[p]!)) { [heap[c], heap[p]] = [heap[p]!, heap[c]!]; c = p; } else break; } };
    const pop = (): number => { const top = heap[0]!; const last = heap.pop()!; if (heap.length) { heap[0] = last; let c = 0; for (;;) { const l = 2 * c + 1, r = 2 * c + 2; let m = c; if (l < heap.length && less(heap[l]!, heap[m]!)) m = l; if (r < heap.length && less(heap[r]!, heap[m]!)) m = r; if (m === c) break; [heap[c], heap[m]] = [heap[m]!, heap[c]!]; c = m; } } return top; };

    let found = false;
    while (heap.length) {
      const cur = pop();
      if (cur === gc) { found = true; break; }
      if (closed[cur]) continue;
      closed[cur] = 1;
      const ccx = cur % this.cols, ccy = Math.floor(cur / this.cols);
      for (let dyd = -1; dyd <= 1; dyd++) for (let dxd = -1; dxd <= 1; dxd++) {
        if (dxd === 0 && dyd === 0) continue;
        const nx = ccx + dxd, ny = ccy + dyd;
        if (nx < 0 || ny < 0 || nx >= this.cols || ny >= this.rows) continue;
        const ni = ny * this.cols + nx;
        if (closed[ni] || blocked(ni)) continue;
        if (dxd !== 0 && dyd !== 0) { // 不切障碍角
          if (blocked(ccy * this.cols + nx) || blocked(ny * this.cols + ccx)) continue;
        }
        const cost = (dxd !== 0 && dyd !== 0) ? Math.SQRT2 : 1;
        const ng = (g[cur] ?? Infinity) + cost;
        if (ng < (g[ni] ?? Infinity)) { came[ni] = cur; g[ni] = ng; f[ni] = ng + hx(ni); push(ni); }
      }
    }
    if (!found) return [{ x: to.x, y: to.y }]; // 无路：退化直线（尽力而为）
    // 回溯 + 视距拉直
    const cells: number[] = [];
    for (let c = gc; c !== -1; c = came[c] ?? -1) cells.push(c);
    cells.reverse();
    const pts: Station[] = cells.map((c) => this.cellCenter(c % this.cols, Math.floor(c / this.cols)));
    pts.push({ x: to.x, y: to.y }); // 精确到目标
    return this.simplify([{ x: from.x, y: from.y }, ...pts]).slice(1);
  }

  private clearLine(a: Station, b: Station): boolean {
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.ceil(d / (this.res * 0.5));
    for (let i = 1; i < steps; i++) {
      const x = a.x + ((b.x - a.x) * i) / steps, y = a.y + ((b.y - a.y) * i) / steps;
      if (this.pointBlocked(x, y, this.robotRadius)) return false;
    }
    return true;
  }
  private simplify(pts: Station[]): Station[] {
    if (pts.length <= 2) return pts;
    const out: Station[] = [pts[0]!];
    let anchor = 0;
    for (let i = 2; i < pts.length; i++) {
      if (!this.clearLine(pts[anchor]!, pts[i]!)) { out.push(pts[i - 1]!); anchor = i - 1; }
    }
    out.push(pts[pts.length - 1]!);
    return out;
  }

  // ---- 序列化 ----
  serialize(): WorldMapData {
    return {
      bounds: { W: this.W, H: this.H },
      resolution: this.res,
      cols: this.cols,
      rows: this.rows,
      obstacles: this.obstacles.map((o) => ({ ...o })),
      stations: { ...this.stations },
      occupancy: Array.from(this.occ),
      terrainSeed: this.terrainSeed,
      river: this.river.map((p) => ({ ...p })),
      riverWidth: this.riverWidth,
    };
  }
  load(d: WorldMapData): void {
    this.obstacles = (d.obstacles ?? []).map((o) => ({ ...o }));
    if (d.stations) this.stations = { ...d.stations };
    this.terrainSeed = d.terrainSeed ?? 0;
    this.river = (d.river ?? []).map((p) => ({ ...p }));
    this.riverWidth = d.riverWidth ?? 0.8;
    const occ = d.occupancy ?? [];
    this.occ.fill(UNKNOWN);
    for (let i = 0; i < Math.min(occ.length, this.occ.length); i++) this.occ[i] = occ[i] ?? UNKNOWN;
    this.dirty = true;
  }
}
