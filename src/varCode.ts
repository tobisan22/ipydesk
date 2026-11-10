/**
 * Variable Editor の「選択範囲 → Python の式 / プロットのコード」。
 *
 * ここの関数は webview にも toString() で埋め込むので、import や外の変数を使わず
 * 関数の中だけで完結させること。互いに呼んでよいのは、このファイルの関数（webview に
 * すべて埋め込む）だけ。
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
  ndim?: number;        // 配列の次元数
  xr?: boolean;         // xarray.DataArray
  dims?: string[] | null;                   // DataArray の軸の名前
  coords?: Record<string, string[]> | null; // DataArray の短い軸の座標（軸番号 → ラベル）
  rowLevels?: number;   // 行の MultiIndex の段の数
  colLevels?: number;   // 列の MultiIndex の段の数
  /** 3 次元以上の配列の見え方。あれば rows / cols はビューを当てた表の大きさ */
  view?: NdView;
}

/** 3 次元以上の配列の見え方: 行の軸 1 つ・列の軸 1 つ以上（C 順に並べる）・残りは番号で固定 */
export interface NdView { row: number; cols: number[]; fix: Record<number, number> }

/**
 * 選択範囲。終端は含まない（Python のスライスと同じ）。
 * cols は離れた列を選んだとき（Ctrl+クリック）の列番号（昇順）。あれば c0 / c1 はその両端
 */
export interface Sel { r0: number; r1: number; c0: number; c1: number; cols?: number[] }

/** プロットの描き方。split: 2 列以上を段に分ける（X 軸は共有） */
export interface PlotOpts { split?: boolean }

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
  const c = sel.cols ? "[" + sel.cols.join(", ") + "]" : one(sel.c0, sel.c1, info.cols);
  if (info.kind === "ndarray" && info.view && info.shape.length >= 3) {
    // ビュー: 元の配列の添字で書けるなら書く（R[0:100, 0, 0:3]）。書けなければ並べ替えてから
    // 行を切り出し、その分だけ reshape する（R[0:100].reshape(100, -1)[:, 0:5]）
    const v = info.view, sh = info.shape;
    const cs = v.cols.map(a => sh[a]);
    const lo: number[] = [], hi: number[] = [];
    let a0 = sel.c0, a1 = sel.c1 - 1;
    for (let d = cs.length - 1; d >= 0; d--) {
      lo[d] = a0 % cs[d]; a0 = Math.floor(a0 / cs[d]);
      hi[d] = a1 % cs[d]; a1 = Math.floor(a1 / cs[d]);
    }
    // 長方形か: lo と hi が最初に違う次元 j より後ろは全部、j より前は 1 つずつ
    let j = 0;
    while (j < cs.length && lo[j] === hi[j]) { j++; }
    let box = true;
    for (let d = j + 1; d < cs.length; d++) { if (lo[d] !== 0 || hi[d] !== cs[d] - 1) { box = false; } }
    const vary: number[] = [];
    for (let d = 0; d < cs.length; d++) { if (hi[d] > lo[d]) { vary.push(d); } }
    if (!sel.cols && box && vary.length <= 1) {
      const idx: string[] = [];
      for (const k of Object.keys(v.fix)) { idx[+k] = String(v.fix[+k]); }
      idx[v.row] = r;
      // 残す列の軸: 幅のある軸。1 列だけで keep2d なら最後の列の軸を k:k+1 で残す
      const keepCol = vary.length === 1 ? vary[0] : keep2d ? cs.length - 1 : -1;
      v.cols.forEach((ax, d) => {
        if (d !== keepCol) { idx[ax] = String(lo[d]); return; }
        const s = one(lo[d], hi[d] + 1, cs[d]);
        idx[ax] = /^\d+$/.test(s) ? s + ":" + (lo[d] + 1) : s;
      });
      const rowKept = !/^\d+$/.test(r);
      const colAxis = keepCol >= 0 ? v.cols[keepCol] : -1;
      // 残った軸は元の順に並ぶので、列の軸が行の軸より前なら転置する
      const t = rowKept && colAxis >= 0 && colAxis < v.row ? ".T" : "";
      if (idx.every(x => x === ":")) { return base + t; }
      return base + "[" + idx.join(", ") + "]" + t;
    }
    const et = viewExpr(expr, info, false);
    const rs = (sel.r0 === 0 ? "" : String(sel.r0)) + ":" + (sel.r1 === info.rows ? "" : String(sel.r1));
    const nr = sel.r1 - sel.r0;
    const rsel = !keep2d && nr === 1 ? "0" : ":";
    return et + (rs === ":" ? "" : "[" + rs + "]") + ".reshape(" + nr + ", -1)"
      + (rsel === ":" && c === ":" ? "" : "[" + rsel + ", " + c + "]");
  }
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
  kind: PlotKind, expr: string, info: VarInfo, sel: Sel, page: number[], opts?: PlotOpts): string | null {
  const cols = sel.cols;
  const nr = sel.r1 - sel.r0;
  const nc = cols ? cols.length : sel.c1 - sel.c0;
  const k = info.kind;
  const pandas = k === "dataframe" || k === "series";
  const table2d = k === "dataframe" || (k === "ndarray" && info.shape.length >= 2);
  if (!info.numeric || nr < 1 || nc < 1 || k === "scalar") { return null; }
  const S = (keep2d: boolean, s: Sel = sel) => selectionExpr(expr, info, s, page, keep2d);
  const head = "import matplotlib.pyplot as plt; plt.figure(" + JSON.stringify(expr.trim()) + "); plt.clf(); ";
  const colAt = (i: number) => cols ? cols[i] : sel.c0 + i;
  // 選んだ列の from 番目から to 番目の手前まで。連続していればスライスで書ける形にする
  const part = (from: number, to: number = nc): Sel => {
    const a = colAt(from), b = colAt(to - 1) + 1;
    const out: Sel = { r0: sel.r0, r1: sel.r1, c0: a, c1: b };
    if (cols && b - a !== to - from) { out.cols = cols.slice(from, to); }
    return out;
  };
  // 凡例・軸ラベルに出す名前: ビューは元の配列の式（R[:, 0, 1]）、それ以外は列番号
  const names = (from: number): string[] => {
    const out: string[] = [];
    for (let i = from; i < nc; i++) {
      const c = colAt(i);
      out.push(info.view
        ? selectionExpr(expr, info, { r0: 0, r1: info.rows, c0: c, c1: c + 1 }, page, false) : String(c));
    }
    return out;
  };
  const legend = (from: number) =>
    nc - from >= 2 && nc - from <= 20 ? "; plt.legend(" + JSON.stringify(names(from)) + ")" : "";
  // 段を分ける: 列ごとに 1 段（8 段まで。それより多ければ重ねる）
  const split = (n: number) => !!(opts && opts.split) && n >= 2 && n <= 8;
  const axes = (n: number) => "plt.gcf().subplots(" + n + ", 1, sharex=True)";
  switch (kind) {
    case "line": {
      if (nr * nc < 2) { return null; }
      const multi = nr > 1 && nc > 1;
      if (pandas) {
        return head + S(false) + (multi && split(nc) ? ".plot(subplots=True, ax=" + axes(nc) + ")" : ".plot(ax=plt.gca())");
      }
      if (multi && split(nc)) {
        return head + "[(a.plot(y), a.set_ylabel(n)) for a, y, n in zip(" + axes(nc) + ", " + S(true) + ".T, "
          + JSON.stringify(names(0)) + ")];";
      }
      // ビュー・離れた列で 2 列以上: 凡例を出す（どの列の線か分かるように）
      return head + "plt.plot(" + S(false) + ")" + ((info.view || cols) && multi ? legend(0) : "");
    }
    case "xy": {     // 左端の列が X、残りが Y（Excel と同じ）
      if (!table2d || nc < 2 || nr < 2) { return null; }
      const ny = nc - 1;
      if (k === "dataframe") {
        return head + S(true) + (split(ny) ? ".plot(x=0, subplots=True, ax=" + axes(ny) + ")" : ".plot(x=0, ax=plt.gca())");
      }
      const X = S(false, part(0, 1));
      if (split(ny)) {
        // 内包表記の中では外の変数を使わない（pdb で停止中は、中から停止フレームの変数が見えない）
        return head + "[(a.plot(x, y), a.set_ylabel(n)) for a, x, y, n in zip(" + axes(ny) + ", [" + X + "] * " + ny
          + ", " + S(true, part(1)) + ".T, " + JSON.stringify(names(1)) + ")];";
      }
      return head + "plt.plot(" + X + ", " + S(false, part(1)) + ")" + legend(1);
    }
    case "scatter":
      if (!table2d || nc !== 2 || nr < 2) { return null; }
      return head + (k === "dataframe"
        ? S(true) + ".plot.scatter(x=0, y=1, ax=plt.gca())"
        : "plt.scatter(" + S(false, part(0, 1)) + ", " + S(false, part(1, 2)) + ")");
    case "hist":
      if (nr * nc < 2) { return null; }
      return head + (pandas
        ? S(false) + ".plot.hist(bins=20, alpha=0.7, ax=plt.gca())"
        : "plt.hist(" + S(false) + ", bins=\"auto\")");
    case "image":
      if (!table2d || cols || nr < 2 || nc < 2) { return null; }
      return head + "plt.imshow(" + S(true) + (k === "dataframe" ? ".to_numpy(dtype=float)" : "")
        + ", aspect=\"auto\", interpolation=\"nearest\"); plt.colorbar()";
    default:
      return null;
  }
}

/**
 * ビューを当てた表を表す Python の式。固定の軸を番号で切り出し、行の軸・列の軸の順に並べ替え、
 * 列の軸が 2 つ以上なら reshape で 2 次元にする（reshape2d=false なら並べ替えまで）。
 * 例: R (10001, 3, 3) → R.reshape(10001, -1)、M (3, 3, 10001) → M.transpose(2, 0, 1).reshape(10001, -1)
 */
export function viewExpr(expr: string, info: VarInfo, reshape2d = true): string {
  const e = expr.trim();
  let out = /^[A-Za-z_]\w*(\.[A-Za-z_]\w*|\[[^\[\]]*\])*$/.test(e) ? e : "(" + e + ")";
  const v = info.view;
  if (!v) { return out; }
  const nd = info.shape.length;
  const idx: string[] = [];
  const rest: number[] = [];
  for (let k = 0; k < nd; k++) {
    if (v.fix[k] !== undefined) { idx.push(String(v.fix[k])); } else { idx.push(":"); rest.push(k); }
  }
  const perm = [v.row, ...v.cols].map(a => rest.indexOf(a));
  const permuted = perm.some((p, i) => p !== i);
  // DataArray の transpose は軸の名前で指定するので、並べ替え・reshape するときは .values で ndarray にする
  if (info.xr && (permuted || (reshape2d && v.cols.length > 1))) { out += ".values"; }
  while (idx.length && idx[idx.length - 1] === ":") { idx.pop(); }
  if (idx.length) { out += "[" + idx.join(", ") + "]"; }
  if (permuted) { out += perm.length === 2 ? ".T" : ".transpose(" + perm.join(", ") + ")"; }
  if (reshape2d && v.cols.length > 1) { out += ".reshape(" + info.shape[v.row] + ", -1)"; }
  return out;
}

/**
 * 開いたときの見え方（3 次元以上）。時系列らしい配列（一番長い軸がほかの軸の積の 10 倍以上で、
 * ほかの軸の積が 64 以下）は、一番長い軸を行にして残りを列に展開する（同じ長さなら前の軸）。
 * それ以外は軸 0 が行・軸 1 が列・残りは番号 0 で固定（0.1.9 までと同じ）
 */
export function defaultView(shape: number[]): NdView {
  const nd = shape.length;
  if (!shape.includes(0)) {
    let li = 0;
    for (let k = 1; k < nd; k++) { if (shape[k] > shape[li]) { li = k; } }
    let p = 1;
    for (let k = 0; k < nd; k++) { if (k !== li) { p *= shape[k]; } }
    if (shape[li] >= 10 * p && p <= 64) {
      const cols: number[] = [];
      for (let k = 0; k < nd; k++) { if (k !== li) { cols.push(k); } }
      return { row: li, cols, fix: {} };
    }
  }
  const fix: Record<number, number> = {};
  for (let k = 2; k < nd; k++) { fix[k] = 0; }
  return { row: 0, cols: [1], fix };
}

/** ビューを添字の形で書く（":, 500, :"）。添字入力の初期値 */
export function viewIndexText(nd: number, v: NdView): string {
  const out: string[] = [];
  for (let k = 0; k < nd; k++) { out.push(v.fix[k] !== undefined ? String(v.fix[k]) : ":"); }
  return out.join(", ");
}

/**
 * 添字の入力（":, 500, :"。前後の式と [ ] は省ける）からビューを作る。受け付けるのは整数と ":" だけ。
 * ":" が 2 つなら前が行・後ろが列、3 つ以上なら先頭が行・残りが展開する列。
 * 読めなければエラーの文を返す
 */
export function parseViewIndex(text: string, shape: number[]): NdView | string {
  let t = text.trim();
  const m = /\[(.*)\]\s*$/.exec(t);
  if (m) { t = m[1]; }
  const tok = t.split(",").map(x => x.trim());
  const nd = shape.length;
  const colon: number[] = [];
  const fix: Record<number, number> = {};
  for (let k = 0; k < tok.length; k++) {
    const x = tok[k];
    if (x === ":") { colon.push(k); continue; }
    if (/^[-+]?\d+$/.test(x)) {
      if (k >= nd) { continue; }
      let i = parseInt(x, 10);
      if (i < 0) { i += shape[k]; }
      if (i < 0 || i >= shape[k]) { return "軸 " + k + " の番号 " + x + " は範囲外です（0〜" + (shape[k] - 1) + "）"; }
      fix[k] = i;
      continue;
    }
    return "整数と : だけ使えます（" + (x || "空") + "）";
  }
  if (tok.length !== nd) { return "添字は " + nd + " 個（軸の数）書いてください"; }
  if (colon.length < 2) { return ": は 2 つ以上必要です（行と列）"; }
  return { row: colon[0], cols: colon.slice(1), fix };
}

/** 列幅を覚えるときのビューの署名（固定の番号は入れない）。例 "r0|c1,2" */
export function viewSig(v: NdView): string {
  return "r" + v.row + "|c" + v.cols.join(",");
}
