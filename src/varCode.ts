/**
 * Variable Editor の「選択範囲 → Python の式 / プロットのコード」。
 *
 * ここの関数は webview にも toString() で埋め込むので、import や外の変数を使わず
 * 関数の中だけで完結させること（互いに呼ぶのは selectionExpr と plotCode だけ）。
 */

/** Python 側 ipydesk.varview.info() の形 */
export interface VarInfo {
  kind: "ndarray" | "dataframe" | "series" | "list" | "scalar";
  cls: string;
  shape: number[];
  rows: number;
  cols: number;
  pages: number[];      // 3 次元目以降の大きさ
  numeric: boolean;
  labels: boolean;      // pandas（行・列ラベルあり）
}

/** 選択範囲。終端は含まない（Python のスライスと同じ） */
export interface Sel { r0: number; r1: number; c0: number; c1: number }

export type PlotKind = "line" | "xy" | "scatter" | "hist" | "image";

/**
 * 選択範囲を表す Python の式。keep2d=false なら、1 行・1 列だけの選択は次元を落とす
 * （x[:, 2] のように。plot に渡すと 1 本の線になる）。全体を選んでいれば変数名だけ
 */
export function selectionExpr(
  expr: string, info: VarInfo, sel: Sel, page: number[], keep2d: boolean): string {
  const e = expr.trim();
  const base = /^[A-Za-z_]\w*(\.[A-Za-z_]\w*|\[[^\[\]]*\])*$/.test(e) ? e : "(" + e + ")";
  const one = (a: number, b: number, n: number): string => {
    if (a === 0 && b === n) { return ":"; }
    if (!keep2d && b - a === 1) { return String(a); }
    return (a === 0 ? "" : String(a)) + ":" + (b === n ? "" : String(b));
  };
  const r = one(sel.r0, sel.r1, info.rows);
  const c = one(sel.c0, sel.c1, info.cols);
  switch (info.kind) {
    case "ndarray": {
      if (info.shape.length <= 1) { return r === ":" ? base : base + "[" + r + "]"; }
      const pg = info.pages.map((n, i) => String(Math.max(0, Math.min(page[i] ?? 0, n - 1))));
      if (r === ":" && c === ":" && pg.length === 0) { return base; }
      return base + "[" + [r, c, ...pg].join(", ") + "]";
    }
    case "dataframe":
      return r === ":" && c === ":" ? base : base + ".iloc[" + r + ", " + c + "]";
    case "series":
      return r === ":" ? base : base + ".iloc[" + r + "]";
    case "list":
      return r === ":" ? base : base + "[" + r + "]";
    default:
      return base;
  }
}

/**
 * 選択範囲をプロットする 1 行のコード。その種類のプロットができない選択なら null。
 * コードはセッションのターミナルへそのまま送る（MATLAB と同じく履歴に残り、再利用できる）。
 * ブレークポイントで停止中でも動くよう、plt の import から始める。
 * 図は変数ごとに 1 つ（plt.figure("x")）に描き直す。前の図は Figure タブの履歴に残る
 */
export function plotCode(
  kind: PlotKind, expr: string, info: VarInfo, sel: Sel, page: number[]): string | null {
  const nr = sel.r1 - sel.r0;
  const nc = sel.c1 - sel.c0;
  const k = info.kind;
  const pandas = k === "dataframe" || k === "series";
  const table2d = k === "dataframe" || (k === "ndarray" && info.shape.length >= 2);
  if (!info.numeric || nr < 1 || nc < 1 || k === "scalar") { return null; }
  const S = (keep2d: boolean, s: Sel = sel) => selectionExpr(expr, info, s, page, keep2d);
  const head = "import matplotlib.pyplot as plt; plt.figure(" + JSON.stringify(expr.trim()) + "); plt.clf(); ";
  const col = (c: number, c1 = c + 1) => ({ r0: sel.r0, r1: sel.r1, c0: c, c1 });
  switch (kind) {
    case "line":
      if (nr * nc < 2) { return null; }
      return head + (pandas ? S(false) + ".plot(ax=plt.gca())" : "plt.plot(" + S(false) + ")");
    case "xy":
      if (!table2d || nc < 2 || nr < 2) { return null; }
      return head + (k === "dataframe"
        ? S(true) + ".plot(x=0, ax=plt.gca())"
        : "plt.plot(" + S(false, col(sel.c0)) + ", " + S(false, col(sel.c0 + 1, sel.c1)) + ")");
    case "scatter":
      if (!table2d || nc !== 2 || nr < 2) { return null; }
      return head + (k === "dataframe"
        ? S(true) + ".plot.scatter(x=0, y=1, ax=plt.gca())"
        : "plt.scatter(" + S(false, col(sel.c0)) + ", " + S(false, col(sel.c0 + 1)) + ")");
    case "hist":
      if (nr * nc < 2) { return null; }
      return head + (pandas
        ? S(false) + ".plot.hist(bins=20, alpha=0.7, ax=plt.gca())"
        : "plt.hist(" + S(false) + ", bins=\"auto\")");
    case "image":
      if (!table2d || nr < 2 || nc < 2) { return null; }
      return head + "plt.imshow(" + S(true) + (k === "dataframe" ? ".to_numpy(dtype=float)" : "")
        + ", aspect=\"auto\", interpolation=\"nearest\"); plt.colorbar()";
    default:
      return null;
  }
}
