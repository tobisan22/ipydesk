/**
 * Variable Editor の行・列のサイズ表。
 *
 * 既定のサイズ（base）から変えた番号だけを over に持つ（上限 MAX 件）。行数・列数ぶんの
 * 配列は持たないので、1,000 万行でも軽い。位置は「番号 × base + 左（上）にある上書きの
 * 差分の合計」で、差分の合計は over の番号を二分探索して累積和から引く。
 *
 * webview にも toString() で埋め込むので、import や外の変数を使わず、このクラスの中だけで
 * 完結させること。単位は 100% のときの px（ズームは使う側で掛ける）。
 */
export class SizeAxis {
  static readonly MAX = 2000;

  /**
   * 縮尺スクロールの倍率（実位置 ÷ スクロール位置）。表の長さ total が lim を超えるとき、
   * スクロールできる長さを lim に抑える。view は見えている長さ。縮めないときは 1
   */
  static ratio(total: number, view: number, lim: number): number {
    const s = Math.min(total, lim);
    return total > s && s > view ? (total - view) / (s - view) : 1;
  }
  base: number;
  over: Map<number, number> = new Map();
  keys: number[] = [];   // over の番号（昇順）
  acc: number[] = [0];   // acc[i] = keys[0..i-1] の差分（サイズ − base）の合計。長さ keys.length + 1

  constructor(base: number) { this.base = base; }

  private rebuild(): void {
    this.keys = [...this.over.keys()].sort((a, b) => a - b);
    this.acc = [0];
    for (const k of this.keys) { this.acc.push(this.acc[this.acc.length - 1] + this.over.get(k)! - this.base); }
  }

  /** i より前（左・上）にある上書きの数（keys の中で i 未満のもの） */
  private before(i: number): number {
    let lo = 0, hi = this.keys.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.keys[m] < i) { lo = m + 1; } else { hi = m; } }
    return lo;
  }

  size(i: number): number { return this.over.get(i) ?? this.base; }

  /** 左端（上端）の位置 */
  pos(i: number): number { return i * this.base + this.acc[this.before(i)]; }

  /** n 個並べた全体の長さ */
  total(n: number): number { return this.pos(n); }

  /** 位置 px にある番号（0〜n-1 に収める） */
  at(px: number, n: number): number {
    if (n <= 0) { return 0; }
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const m = Math.floor((lo + hi + 1) / 2);
      if (this.pos(m) <= px) { lo = m; } else { hi = m - 1; }
    }
    return lo;
  }

  /** サイズを変える。base と同じなら上書きを消す。上限を超える新しい番号は無視して false */
  set(i: number, s: number): boolean {
    if (s === this.base) { this.over.delete(i); }
    else if (this.over.has(i) || this.over.size < SizeAxis.MAX) { this.over.set(i, s); }
    else { return false; }
    this.rebuild();
    return true;
  }

  /** 複数をまとめて変える（rebuild は 1 回） */
  setMany(list: number[], s: number): void {
    for (const i of list) {
      if (s === this.base) { this.over.delete(i); }
      else if (this.over.has(i) || this.over.size < SizeAxis.MAX) { this.over.set(i, s); }
    }
    this.rebuild();
  }

  /** 既定のサイズを変える。上書きはそのまま（base と同じになったものは消す） */
  setBase(b: number): void {
    this.base = b;
    for (const [k, v] of this.over) { if (v === b) { this.over.delete(k); } }
    this.rebuild();
  }

  clear(): void { this.over.clear(); this.rebuild(); }

  /** 上書きをまとめて入れ替える（記憶から作り直すとき）。base と同じもの・上限を超えた分は捨てる */
  replace(entries: Iterable<[number, number]>): void {
    this.over.clear();
    for (const [i, s] of entries) {
      if (s !== this.base && this.over.size < SizeAxis.MAX) { this.over.set(i, s); }
    }
    this.rebuild();
  }

  /** 範囲 [a, b) にある上書きの番号 */
  keysIn(a: number, b: number): number[] {
    const out: number[] = [];
    for (let k = this.before(a); k < this.keys.length && this.keys[k] < b; k++) { out.push(this.keys[k]); }
    return out;
  }
}
