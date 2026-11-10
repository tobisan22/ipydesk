import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  NdView, VarInfo, defaultView, parseViewIndex, plotCode, selectionExpr, viewExpr, viewIndexText, viewSig,
} from "../varCode";

/** ビューを当てた配列の情報（webview が作るのと同じ形） */
function nd(shape: number[], view: NdView, xr = false): VarInfo {
  let cols = 1;
  for (const a of view.cols) { cols *= shape[a]; }
  return { kind: "ndarray", cls: "ndarray float64", shape, rows: shape[view.row], cols, pages: [],
           numeric: true, labels: false, ndim: shape.length, view, xr };
}
const S = (info: VarInfo, r0: number, r1: number, c0: number, c1: number, keep2d = false) =>
  selectionExpr("R", info, { r0, r1, c0, c1 }, [], keep2d);

test("V-1 既定のビュー: 時系列らしい配列は展開する", () => {
  assert.deepEqual(defaultView([10001, 3, 3]), { row: 0, cols: [1, 2], fix: {} });
  assert.deepEqual(defaultView([3, 3, 10001]), { row: 2, cols: [0, 1], fix: {} }, "MATLAB 流の並び");
  assert.deepEqual(defaultView([200, 5001, 12]), { row: 0, cols: [1], fix: { 2: 0 } }, "積が 64 を超える");
  assert.deepEqual(defaultView([100, 100, 3]), { row: 0, cols: [1], fix: { 2: 0 } }, "10 倍に満たない");
  assert.deepEqual(defaultView([40, 4, 40]), { row: 0, cols: [1], fix: { 2: 0 } }, "一番長い軸が 2 本: 前の軸（条件は満たさない）");
  assert.deepEqual(defaultView([1000, 2, 1000, 2]).row, 0);
  assert.deepEqual(defaultView([5, 0, 100]), { row: 0, cols: [1], fix: { 2: 0 } }, "大きさ 0 の軸");
});

test("V-2 添字入力: 受け付ける書き方とエラー", () => {
  const sh = [200, 5001, 12];
  assert.deepEqual(parseViewIndex(":, 500, :", sh), { row: 0, cols: [2], fix: { 1: 500 } });
  assert.deepEqual(parseViewIndex("M[:, -1, :]", sh), { row: 0, cols: [2], fix: { 1: 5000 } }, "式・負の番号");
  assert.deepEqual(parseViewIndex(":, :, :", sh), { row: 0, cols: [1, 2], fix: {} });
  assert.equal(typeof parseViewIndex("0:10, :, :", sh), "string");
  assert.match(parseViewIndex("0:10, :, :", sh) as string, /整数と : だけ/);
  assert.match(parseViewIndex("::2, :, :", sh) as string, /整数と : だけ/);
  assert.match(parseViewIndex("..., 0", sh) as string, /整数と : だけ/);
  assert.match(parseViewIndex(":, 0, 0", sh) as string, /2 つ以上/);
  assert.match(parseViewIndex(":, :", sh) as string, /3 個/);
  assert.match(parseViewIndex(":, 9999, :", sh) as string, /範囲外/);
  assert.equal(viewIndexText(3, { row: 0, cols: [2], fix: { 1: 500 } }), ":, 500, :");
  assert.equal(viewSig({ row: 2, cols: [0, 1], fix: {} }), "r2|c0,1");
});

test("V-3 ビューの式", () => {
  assert.equal(viewExpr("R", nd([10001, 3, 3], { row: 0, cols: [1, 2], fix: {} })), "R.reshape(10001, -1)");
  assert.equal(viewExpr("M", nd([3, 3, 10001], { row: 2, cols: [0, 1], fix: {} })), "M.transpose(2, 0, 1).reshape(10001, -1)");
  assert.equal(viewExpr("M", nd([200, 5001, 12], { row: 0, cols: [2], fix: { 1: 500 } })), "M[:, 500]");
  assert.equal(viewExpr("M", nd([200, 5001, 12], { row: 2, cols: [0], fix: { 1: 5 } })), "M[:, 5].T");
  assert.equal(viewExpr("X", nd([2, 3, 4], { row: 1, cols: [2], fix: { 0: 1 } })), "X[1]");
  assert.equal(viewExpr("d['a']", nd([3, 3, 9], { row: 2, cols: [0, 1], fix: {} }, true)),
    "d['a'].values.transpose(2, 0, 1).reshape(9, -1)", "DataArray は .values");
});

test("V-4 選択範囲の式: 元の軸で長方形なら添字で書く", () => {
  const R = nd([10001, 3, 3], { row: 0, cols: [1, 2], fix: {} });
  assert.equal(S(R, 0, 100, 0, 3), "R[:100, 0, :]");
  assert.equal(S(R, 0, 100, 3, 5), "R[:100, 1, :2]");
  assert.equal(S(R, 0, 100, 4, 5), "R[:100, 1, 1]");
  assert.equal(S(R, 0, 100, 4, 5, true), "R[:100, 1, 1:2]");
  assert.equal(S(R, 7, 8, 0, 3), "R[7, 0, :]");
  assert.equal(S(R, 0, 100, 2, 5), "R[:100].reshape(100, -1)[:, 2:5]", "長方形にならない");
  assert.equal(S(R, 0, 10001, 0, 9), "R.reshape(10001, -1)", "全体");
  const M = nd([3, 3, 10001], { row: 2, cols: [0, 1], fix: {} });
  assert.equal(S(M, 0, 100, 0, 3), "R[0, :, :100].T");
  assert.equal(S(M, 0, 100, 3, 6, true).startsWith("R[1, :, :100]"), true);
  const T = nd([4, 5, 6], { row: 2, cols: [0], fix: { 1: 3 } });
  assert.equal(S(T, 0, 6, 1, 3), "R[1:3, 3, :].T", "列の軸が行の軸より前なら転置");
});

test("V-5 プロット: ビューの凡例", () => {
  const R = nd([10001, 3, 3], { row: 0, cols: [1, 2], fix: {} });
  const code = plotCode("line", "R", R, { r0: 0, r1: 10001, c0: 0, c1: 3 }, []);
  assert.ok(code);
  assert.ok(code!.includes('plt.plot(R[:, 0, :])'));
  assert.ok(code!.includes('plt.legend(["R[:, 0, 0]","R[:, 0, 1]","R[:, 0, 2]"])'));
});

test("V-6 2 次元以下・ビューの無い配列は今までどおり", () => {
  const A: VarInfo = { kind: "ndarray", cls: "ndarray float64", shape: [10, 4], rows: 10, cols: 4, pages: [],
                       numeric: true, labels: false };
  assert.equal(S(A, 0, 3, 1, 2), "R[:3, 1]");
  const P: VarInfo = { ...A, shape: [10, 4, 5], pages: [5] };
  assert.equal(selectionExpr("R", P, { r0: 0, r1: 3, c0: 1, c1: 2 }, [2], false), "R[:3, 1, 2]");
});
