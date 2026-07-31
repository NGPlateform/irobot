import { describe, it, expect } from "vitest";
import { WorldMap, UNKNOWN, FREE, OCCUPIED } from "./world-map.js";

describe("WorldMap（生成 / 扫描 / 建图 / 避障 / 序列化）", () => {
  it("空世界：pathfind 退化为直线 [to]，coverage 从 0 起", () => {
    const m = new WorldMap();
    expect(m.obstacles.length).toBe(0);
    expect(m.coverage()).toBe(0);
    const path = m.pathfind({ x: 1, y: 1 }, { x: 8, y: 6 });
    expect(path).toEqual([{ x: 8, y: 6 }]);
  });

  it("generate 确定性：同 seed 同结果，且不压站点/起点", () => {
    const a = new WorldMap(); a.generate(42);
    const b = new WorldMap(); b.generate(42);
    expect(a.obstacles).toEqual(b.obstacles);
    expect(a.obstacles.length).toBeGreaterThanOrEqual(6);
    for (const s of Object.values(a.stations)) {
      expect(a.pointBlocked(s.x, s.y, 0.4)).toBe(false); // 站点附近未被障碍占据
    }
    const c = new WorldMap(); c.generate(7);
    expect(c.obstacles).not.toEqual(a.obstacles); // 不同 seed 不同布局
  });

  it("scan 命中障碍：正前方障碍的测距 < 无障碍方向", () => {
    const m = new WorldMap();
    m.obstacles = [{ x: 3, y: 1, w: 1, h: 1 }]; // 机器人 (1,1) 正东有障碍
    const east = m.scan({ x: 1, y: 1 }, 4)[0]!; // ray 0 = +x
    expect(east).toBeGreaterThan(1);
    expect(east).toBeLessThan(3); // 命中障碍近侧（~2.5），远小于到东墙(8.5)
  });

  it("integrateScan：途经 cell=free，命中落点=occupied", () => {
    const m = new WorldMap();
    m.obstacles = [{ x: 4, y: 1, w: 1, h: 1 }];
    m.integrateScan({ x: 1, y: 1 });
    const d = m.serialize();
    expect(d.occupancy.some((v) => v === FREE)).toBe(true);
    expect(d.occupancy.some((v) => v === OCCUPIED)).toBe(true);
    expect(m.coverage()).toBeGreaterThan(0);
  });

  it("pathfind 绕开障碍：路径不穿过障碍且到达目标", () => {
    const m = new WorldMap();
    // 在 (1,1)→(1,7) 直线中间放一堵横障碍
    m.obstacles = [{ x: 1, y: 4, w: 3, h: 0.6 }];
    const path = m.pathfind({ x: 1, y: 1 }, { x: 1, y: 7 });
    expect(path.length).toBeGreaterThan(1); // 非直线
    const last = path[path.length - 1]!;
    expect(Math.hypot(last.x - 1, last.y - 7)).toBeLessThan(0.5); // 到达目标附近
    for (const p of path) expect(m.pointBlocked(p.x, p.y, 0.2)).toBe(false); // 航点不在障碍内
  });

  it("serialize ↔ load 往返一致", () => {
    const m = new WorldMap(); m.generate(3); m.integrateScan({ x: 1, y: 1 });
    const data = m.serialize();
    const m2 = new WorldMap(); m2.load(data);
    expect(m2.serialize()).toEqual(data);
    expect(m2.obstacles).toEqual(m.obstacles);
    void UNKNOWN;
  });
});
