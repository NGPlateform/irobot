// 世界地图：障碍物（AABB）+ 占据栅格（unknown/free/occupied）。纯逻辑、无 IO，可单测。
// 负责：程序化生成障碍环境、激光雷达扫描、占据累积建图、A* 避障路径、序列化。
// 障碍与 S3「危险区」是两个概念：这里的 obstacles 是物理障碍（避障 + 建图占据）。

export interface Aabb {
  x: number; // 中心
  y: number;
  w: number; // 全宽
  h: number; // 全高
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

  /** 点是否落在某障碍内（可加机器人半径 margin，用于避障膨胀）。 */
  pointBlocked(x: number, y: number, margin = 0): boolean {
    if (x < margin || y < margin || x > this.W - margin || y > this.H - margin) return true;
    for (const o of this.obstacles) {
      if (Math.abs(x - o.x) <= o.w / 2 + margin && Math.abs(y - o.y) <= o.h / 2 + margin) return true;
    }
    return false;
  }

  // ---- 生成 ----
  generate(seed: number): void {
    const rnd = mulberry32(seed || 1);
    this.obstacles = [];
    const keepClear = (x: number, y: number, r: number): boolean => {
      for (const s of Object.values(this.stations)) if (Math.hypot(x - s.x, y - s.y) < r) return false;
      for (const s of STARTS) if (Math.hypot(x - s.x, y - s.y) < r) return false;
      return true;
    };
    const target = 6 + Math.floor(rnd() * 4); // 6..9 个障碍
    let tries = 0;
    while (this.obstacles.length < target && tries < 400) {
      tries++;
      const w = 0.6 + rnd() * 1.1;
      const h = 0.6 + rnd() * 1.1;
      const x = 1 + rnd() * (this.W - 2);
      const y = 1 + rnd() * (this.H - 2);
      if (!keepClear(x, y, 1.3)) continue;
      const cand: Aabb = { x, y, w, h };
      const overlaps = this.obstacles.some(
        (o) => Math.abs(o.x - x) < (o.w + w) / 2 + 0.6 && Math.abs(o.y - y) < (o.h + h) / 2 + 0.6,
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

  // ---- A* 避障路径 ----
  /** 返回从 from 到 to 的航点（不含起点，含 to）。空世界或无障碍时 = [to]（直线）。 */
  pathfind(from: { x: number; y: number }, to: { x: number; y: number }): Station[] {
    if (this.obstacles.length === 0) return [{ x: to.x, y: to.y }];
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
    };
  }
  load(d: WorldMapData): void {
    this.obstacles = (d.obstacles ?? []).map((o) => ({ ...o }));
    if (d.stations) this.stations = { ...d.stations };
    const occ = d.occupancy ?? [];
    this.occ.fill(UNKNOWN);
    for (let i = 0; i < Math.min(occ.length, this.occ.length); i++) this.occ[i] = occ[i] ?? UNKNOWN;
    this.dirty = true;
  }
}
