import { test } from "node:test";
import * as assert from "node:assert/strict";
import { SizeAxis } from "../sizeAxis";

const N = 10_000_000;

/** 上書き k 件（決まった乱数で）を入れたサイズ表 */
function withOverrides(k: number, n: number): SizeAxis {
  const a = new SizeAxis(22);
  let seed = 1;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const list: number[] = [];
  for (let i = 0; i < k; i++) { list.push(Math.floor(rnd() * n)); }
  for (const i of list) { a.set(i, 14 + Math.floor(rnd() * 386)); }
  return a;
}

test("S-1 上書きなし: pos・total・at", () => {
  const a = new SizeAxis(22);
  assert.equal(a.pos(0), 0);
  assert.equal(a.pos(10), 220);
  assert.equal(a.total(N), 22 * N);
  assert.equal(a.at(0, N), 0);
  assert.equal(a.at(21.9, N), 0);
  assert.equal(a.at(22, N), 1);
  assert.equal(a.at(1e12, N), N - 1, "範囲外は端に収める");
  assert.equal(a.at(-5, N), 0);
});

test("S-2 上書き 1 件: 前後の位置がずれる", () => {
  const a = new SizeAxis(96);
  a.set(3, 200);
  assert.equal(a.size(3), 200);
  assert.equal(a.pos(3), 288);
  assert.equal(a.pos(4), 488);
  assert.equal(a.at(487, 10), 3);
  assert.equal(a.at(488, 10), 4);
  a.set(3, 96);
  assert.equal(a.over.size, 0, "base と同じなら上書きを消す");
});

for (const k of [0, 1, 2000]) {
  test(`S-3 at(pos(i)) === i（上書き ${k} 件、1,000 万要素）`, () => {
    const a = withOverrides(k, N);
    const check = (i: number) => {
      assert.equal(a.at(a.pos(i), N), i);
      assert.equal(a.at(a.pos(i) + a.size(i) - 0.5, N), i);
      assert.equal(a.pos(i + 1) - a.pos(i), a.size(i));
    };
    for (const i of [0, 1, N - 2, N - 1]) { check(i); }
    for (const i of a.keys) { check(i); if (i > 0) { check(i - 1); } if (i < N - 1) { check(i + 1); } }
    for (let i = 0; i < N; i += 99_991) { check(i); }
  });
}

test("S-4 上限 2,000 件を超える新しい番号は無視する", () => {
  const a = new SizeAxis(22);
  for (let i = 0; i < SizeAxis.MAX; i++) { assert.ok(a.set(i * 2, 30)); }
  assert.equal(a.set(99_999, 30), false);
  assert.equal(a.size(99_999), 22);
  assert.ok(a.set(0, 40), "既にある番号は変えられる");
});

test("S-5 setBase・setMany・keysIn・clear", () => {
  const a = new SizeAxis(22);
  a.setMany([5, 6, 7], 40);
  assert.deepEqual(a.keysIn(0, 6), [5]);
  assert.deepEqual(a.keysIn(6, 100), [6, 7]);
  a.setBase(40);
  assert.equal(a.over.size, 0, "新しい base と同じ上書きは消える");
  a.set(1, 10);
  a.setBase(18);
  assert.equal(a.pos(2), 18 + 10);
  a.clear();
  assert.equal(a.total(3), 54);
});

test("S-6 縮尺スクロールの往復", () => {
  const LIM = 15_000_000, view = 700;
  assert.equal(SizeAxis.ratio(1_000_000, view, LIM), 1, "上限以下は縮めない");
  assert.equal(SizeAxis.ratio(500, view, LIM), 1);
  const total = withOverrides(2000, N).total(N);
  const k = SizeAxis.ratio(total, view, LIM);
  assert.ok(k > 1);
  const maxScroll = LIM - view;
  assert.ok(Math.abs(maxScroll * k - (total - view)) < 1e-3, "スクロールの端 = 表の端");
  for (const y of [0, 12345.5, (total - view) / 2, total - view]) {
    assert.ok(Math.abs((y / k) * k - y) < 1e-6);
  }
});

test("S-7 webview に埋め込める（import なし）", () => {
  const src = SizeAxis.toString();
  const B = new Function(src + "; return SizeAxis;")() as typeof SizeAxis;
  const a = new B(22);
  a.set(1, 50);
  assert.equal(a.pos(2), 72);
  assert.equal(B.ratio(100, 10, 50), (100 - 10) / (50 - 10));
});
