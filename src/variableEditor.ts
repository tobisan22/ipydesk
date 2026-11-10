/**
 * Variable Editor（MATLAB の「変数エディター」）
 *
 * 配列・DataFrame・Series・list を表で開き、選択範囲をワンクリックでプロットする。
 *  - 表の中身は、見えている範囲だけを Python（ipydesk.varview）に問い合わせて取る。
 *    100 万行の配列でもスクロールに合わせて少しずつ読むので重くならない
 *  - 変数が変わったら（ワークスペースビューが更新されたら）見えている範囲を取り直す
 *  - プロットは Python のコードとしてセッションのターミナルへ送る。MATLAB と同じく
 *    実行したコードが履歴に残るので、そのままスクリプトへ貼って再利用できる
 *  - ブレークポイントで停止中は、そのフレームの変数を見る（ワークスペースビューと同じ）
 *  - 列幅・行の高さ・行見出しの幅・表示倍率を変えられる。列幅・全体の行の高さ・倍率は
 *    式ごとに workspaceState へ保存する（個別の行の高さは保存しない）
 *  - 選択範囲の統計をフッターに、選んだセルの全文をインスペクタに出す
 *  - 3 次元以上の配列は次元バーで見え方（行の軸・列の軸・固定の軸）を選ぶ。列の軸が 2 つ以上なら
 *    C 順に 1 列に並べる。今の見え方は Python の式で出す
 *  - DataFrame の MultiIndex は見出しを段に分ける。ウィンドウ枠の固定・ヒートマップ
 */
import * as vscode from "vscode";
import {
  defaultView, NdView, parseViewIndex, plotCode, selectionExpr, viewExpr, viewIndexText, viewSig,
} from "./varCode";
import { SizeAxis } from "./sizeAxis";

export interface VarQuery {
  op: "block" | "copy" | "collabels" | "stats" | "cell";
  expr: string;
  r0?: number; r1?: number; c0?: number; c1?: number;
  r?: number; c?: number;
  page?: number[];
  full?: number[];
  view?: NdView;
}

/** 式ごとに保存する見た目（webview が作り、拡張が workspaceState に置く） */
export interface VarLayout {
  kind?: string;
  rw?: number;                          // 手で変えた行見出しの幅（無ければ自動）
  byLabel?: Record<string, number>;     // DataFrame / Series: 列名 → 幅
  byIndex?: Record<string, number>;     // 列番号 → 幅
  byView?: Record<string, Record<string, number>>;  // 3 次元以上: ビューの署名 → 列番号 → 幅
  view?: NdView & { shape: number[] };  // 3 次元以上: 最後の見え方（形が同じときだけ戻す）
  rh?: number;                          // 全体の行の高さ（18 / 22 / 28）
  zoom?: number;                        // 表示倍率（%）
  split?: boolean;                      // プロット: 列ごとに段を分ける
  t?: number;                           // 最後に使った日時
}

/** 右クリックメニューのコマンド（package.json の webview/context） */
export type VarMenuCmd = "colAutoFit" | "colReset" | "colResetAll" | "rowAutoFit" | "rowReset" | "rowResetAll"
  | "freezeCols" | "freezeRows" | "unfreeze" | "copyViewExpr";

export interface VariableEditorHost {
  /** Python へ問い合わせる（ipydesk.varview.handle の答えが返る）。timeoutMs は大きな統計用 */
  query(sid: number, q: VarQuery, timeoutMs?: number): Promise<any>;
  /** コードをセッションで実行する（プロット） */
  run(sid: number, code: string): void;
  /** 見た目（列幅など）を保存する */
  saveLayout(expr: string, layout: VarLayout): void;
  /** パネルが閉じられた */
  closed(ed: VariableEditor): void;
}

export class VariableEditor {
  static readonly viewType = "ipydeskVariable";
  readonly panel: vscode.WebviewPanel;

  constructor(
    readonly expr: string,
    readonly sid: number,
    title: string,
    column: vscode.ViewColumn,
    private readonly host: VariableEditorHost,
    layout: VarLayout | undefined,
    defaultZoom: number,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      VariableEditor.viewType, title, { viewColumn: column, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true });
    this.panel.iconPath = new vscode.ThemeIcon("table");
    this.panel.webview.html = html(this.panel.webview.cspSource, expr, layout ?? {}, defaultZoom);
    this.panel.webview.onDidReceiveMessage(m => this.onMessage(m));
    this.panel.onDidDispose(() => host.closed(this));
  }

  private post(m: unknown) { void this.panel.webview.postMessage(m); }

  private async onMessage(m: any) {
    switch (m?.type) {
      case "query": {
        try {
          const res = await this.host.query(this.sid, { ...m.q, expr: this.expr }, m.slow ? 30000 : undefined);
          this.post({ type: "result", reqId: m.reqId, res });
        } catch (e) {
          this.post({ type: "result", reqId: m.reqId,
            res: { ok: false, error: e instanceof Error ? e.message : String(e), transient: true } });
        }
        break;
      }
      case "plot":
        if (typeof m.code === "string" && m.code) { this.host.run(this.sid, m.code); }
        break;
      case "copy": {
        try {
          const res = await this.host.query(this.sid,
            { op: "copy", expr: this.expr, ...m.sel, page: m.page, view: m.view ?? undefined });
          if (!res?.ok) { throw new Error(res?.error ?? "取得できませんでした"); }
          await vscode.env.clipboard.writeText(res.text);
          vscode.window.setStatusBarMessage(`IPyDesk: ${m.label} をコピーしました`, 2000);
        } catch (e) {
          vscode.window.showErrorMessage(
            `IPyDesk: コピーに失敗しました — ${e instanceof Error ? e.message : String(e)}`);
        }
        break;
      }
      case "clip":     // 統計の値をクリック
        if (typeof m.text === "string") {
          await vscode.env.clipboard.writeText(m.text);
          vscode.window.setStatusBarMessage(`IPyDesk: ${m.label ?? m.text} をコピーしました`, 2000);
        }
        break;
      case "layout":
        if (m.data && typeof m.data === "object") { this.host.saveLayout(this.expr, m.data); }
        break;
    }
  }

  /** 変数が変わったかもしれない（実行・ステップの後）。見えている範囲を取り直させる */
  refresh() { this.post({ type: "refresh" }); }

  /** セッションが終わった */
  ended() { this.post({ type: "ended" }); }

  /** 右クリックメニューで選ばれたコマンド。ctx は data-vscode-context（col / row） */
  menu(cmd: VarMenuCmd, ctx: { col?: unknown; row?: unknown } | undefined) {
    this.post({ type: "menu", cmd,
      col: typeof ctx?.col === "number" ? ctx.col : undefined,
      row: typeof ctx?.row === "number" ? ctx.row : undefined });
  }

  reveal() { this.panel.reveal(undefined, false); }
}

function nonce(): string {
  let s = "";
  const c = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) { s += c.charAt(Math.floor(Math.random() * c.length)); }
  return s;
}

const js = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

export function html(cspSource: string, expr: string, layout: VarLayout = {}, defaultZoom = 100): string {
  const n = nonce();
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${n}';">
<style>
  html, body { height: 100%; margin: 0; padding: 0; overflow: hidden; }
  body { display: flex; flex-direction: column; color: var(--vscode-foreground);
         background: var(--vscode-editor-background);
         font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
  .bar { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: center; padding: 6px 10px;
         border-bottom: 1px solid var(--vscode-panel-border, #8884); }
  .title { display: flex; gap: 8px; align-items: baseline; min-width: 0; }
  .expr { font-family: var(--vscode-editor-font-family); font-weight: 600; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 12px; white-space: nowrap; }
  .pages { display: flex; gap: 4px; align-items: center; font-family: var(--vscode-editor-font-family);
           font-size: 12px; color: var(--vscode-descriptionForeground); }
  .pages input { width: 52px; padding: 1px 4px; color: var(--vscode-input-foreground);
           background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, #8886);
           font: inherit; }
  .tools { display: flex; gap: 4px; margin-left: auto; flex-wrap: wrap; align-items: center; }
  button { display: inline-flex; align-items: center; gap: 4px; padding: 3px 9px; border-radius: 2px;
           border: 1px solid var(--vscode-button-border, transparent); cursor: pointer; font: inherit;
           color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  button.on { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  button:disabled { opacity: .4; cursor: default; }
  button.sm { padding: 3px 6px; min-width: 22px; justify-content: center; }
  select { font: inherit; padding: 2px 4px; color: var(--vscode-dropdown-foreground);
           background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border, #8886); }
  .zoom { display: inline-flex; gap: 2px; align-items: center; }
  #zl { min-width: 44px; justify-content: center; font-variant-numeric: tabular-nums; }
  .sep { width: 1px; align-self: stretch; background: var(--vscode-panel-border, #8884); margin: 0 2px; }
  #grid { position: relative; flex: 1; overflow: auto; outline: none;
          font-family: var(--vscode-editor-font-family);
          font-size: calc(var(--vscode-editor-font-size, 13px) * var(--z, 1)); }
  #spacer { position: absolute; top: 0; left: 0; width: 1px; height: 1px; }
  #layer { position: absolute; top: 0; left: 0; overflow: hidden; }
  .c, .h { position: absolute; box-sizing: border-box; padding: 0 6px;
           white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
           border-right: 1px solid var(--vscode-editorGroup-border, #8883);
           border-bottom: 1px solid var(--vscode-editorGroup-border, #8883); cursor: cell; user-select: none; }
  .c.wrap, .h.wrap { white-space: pre-wrap; overflow-wrap: anywhere; display: -webkit-box;
           -webkit-box-orient: vertical; padding-top: 2px; }
  .c.num { text-align: right; }
  .c.fzr { z-index: 1; background: var(--vscode-editor-background); }
  .c.fzc { z-index: 2; background: var(--vscode-editor-background); }
  .c.fzb, .h.fzb { border-bottom: 2px solid var(--vscode-focusBorder, #07f); }
  .c.fzrb, .h.fzrb { border-right: 2px solid var(--vscode-focusBorder, #07f); }
  .c.sel { background: var(--vscode-editor-selectionBackground); }
  .c.cur { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .c.wait { color: var(--vscode-descriptionForeground); }
  .h { background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
       color: var(--vscode-descriptionForeground); z-index: 3; text-align: center; cursor: default; }
  .h.row { text-align: right; cursor: e-resize; }
  .h.lv { text-align: left; }
  .h.col { cursor: s-resize; }
  .h.hl { color: var(--vscode-foreground); background: var(--vscode-list-inactiveSelectionBackground); }
  .h.rep { color: color-mix(in srgb, var(--vscode-descriptionForeground) 35%, transparent); }
  .h.corner { z-index: 4; cursor: pointer; }
  .dimbar { display: none; flex-wrap: wrap; gap: 4px 12px; align-items: center; padding: 4px 10px; font-size: 12px;
            color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-panel-border, #8884); }
  .dimbar.on { display: flex; }
  .ax { display: inline-flex; gap: 4px; align-items: center; padding: 1px 4px; border-radius: 3px; }
  .ax.cur { outline: 1px solid var(--vscode-focusBorder); }
  .ax b { color: var(--vscode-foreground); font-weight: 600; }
  .ax input, #vedit { padding: 1px 4px; color: var(--vscode-input-foreground); font: inherit;
           background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, #8886); }
  .ax input { width: 56px; font-family: var(--vscode-editor-font-family); }
  #vedit { width: 180px; font-family: var(--vscode-editor-font-family); }
  .vexpr { font-family: var(--vscode-editor-font-family); color: var(--vscode-foreground); cursor: text;
           border-bottom: 1px dashed transparent; }
  .vexpr:hover { border-bottom-color: var(--vscode-descriptionForeground); }
  .dimbar .err { color: var(--vscode-errorForeground); }
  body[data-rz="col"], body[data-rz="col"] * { cursor: col-resize !important; }
  body[data-rz="row"], body[data-rz="row"] * { cursor: row-resize !important; }
  #guide { position: fixed; z-index: 10; display: none; pointer-events: none;
           background: var(--vscode-focusBorder, #07f); }
  #insp { display: none; flex-direction: column; min-height: 40px;
          border-top: 1px solid var(--vscode-panel-border, #8884); }
  #insp.on { display: flex; }
  #insp-split { height: 5px; margin-top: -3px; cursor: row-resize; }
  #insp-head { padding: 2px 10px; font-size: 12px; color: var(--vscode-descriptionForeground); }
  #insp-head code { font-family: var(--vscode-editor-font-family); color: var(--vscode-foreground); }
  #insp pre { flex: 1; margin: 0; padding: 2px 10px 6px; overflow: auto; white-space: pre-wrap;
              overflow-wrap: anywhere; user-select: text;
              font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
  .foot { display: flex; flex-wrap: wrap; gap: 4px 12px; padding: 4px 10px; font-size: 12px; min-height: 18px;
          color: var(--vscode-descriptionForeground);
          border-top: 1px solid var(--vscode-panel-border, #8884); }
  .foot code { font-family: var(--vscode-editor-font-family); color: var(--vscode-foreground); }
  .foot .err { color: var(--vscode-errorForeground); }
  .foot .sv { cursor: pointer; color: var(--vscode-foreground); font-family: var(--vscode-editor-font-family); }
  .foot .sv:hover { text-decoration: underline; }
  .foot a { color: var(--vscode-textLink-foreground); cursor: pointer; }
  .overlay { position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
             padding: 20px; text-align: center; line-height: 1.7; z-index: 5;
             color: var(--vscode-descriptionForeground); background: var(--vscode-editor-background); }
</style></head><body>
<div class="bar">
  <div class="title"><span class="expr" id="expr"></span><span class="meta" id="meta">読み込み中…</span></div>
  <div class="pages" id="pages"></div>
  <div class="tools">
    <button class="primary" data-plot="line" title="選択範囲を折れ線で描く（列ごとに 1 本）">📈 Plot</button>
    <button data-plot="xy" title="左端の列を X、残りの列を Y にして描く。離れた列は、列見出しを Ctrl+クリックして選ぶ">X–Y</button>
    <button data-plot="scatter" title="2 列を選んで、左の列を X・右の列を Y にした散布図">Scatter</button>
    <button data-plot="hist" title="選択範囲のヒストグラム">Hist</button>
    <button data-plot="image" title="選択範囲を画像（カラーマップ）として描く">Image</button>
    <button id="split" title="Plot / X–Y で 2 列以上を描くとき、同じ軸に重ねずに列ごとに段を分ける（X 軸は共有。8 列まで）">Subplots</button>
    <span class="sep"></span>
    <button id="copy" title="選択範囲をタブ区切りでコピー（Ctrl+C）。Excel にそのまま貼れます">Copy</button>
    <button id="insp-btn" title="選んだセルの値を全文で表示する（インスペクタ）">Inspect</button>
    <button id="heat" title="値の大きさで背景に色を付ける（ヒートマップ）。基準は表示中の範囲">Heat</button>
    <select id="heat-scale" title="ヒートマップの基準" style="display:none">
      <option value="all">基準: 表示中の全体</option><option value="col">基準: 列ごと</option>
    </select>
    <span class="sep"></span>
    <select id="rh" title="行の高さ">
      <option value="18">行: 詰める</option><option value="22">行: 標準</option><option value="28">行: 広く</option>
    </select>
    <span class="zoom" title="表示倍率（Ctrl+ホイール）。倍率の数字をクリックで 100%">
      <button class="sm" id="zo">−</button><button class="sm" id="zl">100%</button><button class="sm" id="zi">+</button>
    </span>
    <button id="reload" title="最新の値を読み直す">⟳</button>
  </div>
</div>
<div class="dimbar" id="dimbar"></div>
<div id="grid" tabindex="0"><div id="spacer"></div><div id="layer"></div>
  <div class="overlay" id="overlay"></div></div>
<div id="insp"><div id="insp-split" title="ドラッグで高さを変える"></div>
  <div id="insp-head"></div><pre id="insp-body"></pre></div>
<div class="foot" id="foot"></div>
<div id="guide"></div>
<script nonce="${n}">
const vscode = acquireVsCodeApi();
const EXPR = ${js(expr)};
const LAYOUT = ${js(layout)};
const DEF_ZOOM = ${js(defaultZoom)};
${selectionExpr.toString()}
${plotCode.toString()}
${viewExpr.toString()}
${defaultView.toString()}
${viewIndexText.toString()}
${parseViewIndex.toString()}
${viewSig.toString()}
${SizeAxis.toString()}

const HH0 = 22;                  // 列見出しの高さ（100% のとき）
const BR = 100, BC = 25;         // 問い合わせる単位（行・列）
// ブラウザは要素の長さに上限がある（Chromium で約 3,355 万 px）。表の長さが LIM を超えるときは
// #spacer を LIM に抑え、スクロールバーの位置を縮尺して表の中の位置（実位置）に読み替える。
// 実位置は pos に持ち、ホイール・キー操作は実位置で動かす（scrollTop は整数に丸められるため）
const LIM = 15000000;
const pos = { y: 0, x: 0, st: 0, sl: 0 };   // 実位置と、それを置いたときの scrollTop / scrollLeft
const COL_MIN = 24, COL_MAX = 1200, FIT_MIN = 40, FIT_MAX = 600;
const ROW_MIN = 14, ROW_MAX = 400, RW_MIN = 24, RW_MAX = 600;
const ST_AUTO = 1000000, ST_MAX = 20000000;  // 統計: 自動で計算する／計算できるセル数

const clampN = (v, a, b) => Math.max(a, Math.min(b, v));
const DENS = [18, 22, 28];
let Z = clampN(Math.round(+(LAYOUT.zoom || DEF_ZOOM) / 10) * 10 || 100, 50, 200) / 100;
const cols = new SizeAxis(96);
const rows = new SizeAxis(DENS.includes(LAYOUT.rh) ? LAYOUT.rh : 22);
let RW0 = 56, rwManual = typeof LAYOUT.rw === "number";
if (rwManual) { RW0 = clampN(LAYOUT.rw, RW_MIN, RW_MAX); }
const saved = { byLabel: { ...(LAYOUT.byLabel || {}) }, byIndex: { ...(LAYOUT.byIndex || {}) },
                byView: { ...(LAYOUT.byView || {}) } };
let labels = null;               // 列名（collabels）。無い・多すぎるときは null（列番号で覚える）
let labelLevels = null;          // 列の MultiIndex の段ごとのラベル（collabels の levels）
let rwl = [];                    // 行の MultiIndex: 段ごとの行見出しの幅（100%）

// 3 次元以上の配列の見え方。raw は Python の info、info はビューを当てた表の情報
let raw = null, view = null, legacy = false, curFix = undefined;
let frozenR = 0, frozenC = 0;    // ウィンドウ枠の固定（行・列の数）
let heatOn = false, heatMode = "all";

let info = null, scope = "";
let page = [];
let gen = 0;                     // 変数が変わるたびに増やす（古い答えを見分ける）
const cache = new Map();         // "br,bc" → { gen, sig, r0, c0, cells, rowLabels, colLabels, full }
const pending = new Map();       // reqId → { kind, ... }
const failed = new Map();        // key → gen（同じ世代では問い合わせ直さない）
let reqSeq = 0;
let sel = null;                  // { ar, ac, fr, fc }（両端を含む。a = 起点、f = 動かす端）
let extra = [];                  // 列見出しの Ctrl+クリックで足した、離れた列（sel の列に加えて選ぶ。行は sel と共通）
let split = !!LAYOUT.split;      // プロット: 列ごとに段を分ける
let selSeq = 0;                  // 選択が変わるたびに増やす（統計・インスペクタの古い答えを捨てる）
let drag = null;                 // "cell" | "row" | "col"
let rz = null;                   // サイズ変更のドラッグ { kind, i, x, y, size }
let ended = false, lastError = "";
const fitPending = new Set();    // 高さの自動調整を待つ行（全文が届いたら測る）
const $ = id => document.getElementById(id);
const grid = $("grid"), layer = $("layer");
$("expr").textContent = EXPR;
const esc = s => String(s ?? "").replace(/[&<>"]/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const NUM_RE = /^[-+]?(\\d[\\d.]*(e[-+]?\\d+)?|\\.\\d+|Inf|NaN)([-+][\\d.]+(e[-+]?\\d+)?j)?$/i;
const vstate = vscode.getState() || {};
let inspOn = !!vstate.inspOn, inspH = vstate.inspH || 120;

// ---- 寸法（px）。SizeAxis は 100% の値で持ち、表示のときに Z を掛ける ----
const colLv = () => (info && info.colLevels > 1 ? info.colLevels : 1);
const rowLv = () => (info && info.rowLevels > 1 ? info.rowLevels : 1);
const HH = () => Math.round(HH0 * Z) * colLv();
const qview = () => (view ? { row: view.row, cols: view.cols, fix: view.fix } : undefined);
const RWp = () => RW0 * Z;
function totalH() { return info ? rows.total(info.rows) * Z : 0; }
function totalW() { return info ? cols.total(info.cols) * Z : 0; }
function viewH() { return Math.max(0, grid.clientHeight - HH()); }
function viewW() { return Math.max(0, grid.clientWidth - RWp()); }
const ratio = (t, v) => SizeAxis.ratio(t, v, LIM);
let fontPx = 13, fontFamily = "monospace";   // 100% のときのフォント（測る用）
function readFont() {
  const cs = getComputedStyle(grid);
  fontPx = (parseFloat(cs.fontSize) || 13 * Z) / Z;
  fontFamily = cs.fontFamily || "monospace";
}
const LH0 = () => Math.round(fontPx * 1.35);   // 折り返したときの 1 行の高さ（100%）
const canvas = document.createElement("canvas").getContext("2d");
function measure(s) { canvas.font = fontPx + "px " + fontFamily; return canvas.measureText(s).width; }

function sizeSpacer() {
  if (!info) { return; }
  // layer も同じ大きさで切る（縮尺中はセルが #spacer の外にはみ出し、スクロール範囲が広がるため）
  const w = (RWp() + Math.min(totalW(), LIM)) + "px", h = (HH() + Math.min(totalH(), LIM)) + "px";
  for (const el of [$("spacer"), layer]) { el.style.width = w; el.style.height = h; }
}
const clampTo = (v, total, view) => Math.max(0, Math.min(v, Math.max(0, total - view)));
/** スクロールバーで動かされていたら、そこから実位置を読み直す */
function syncPos() {
  const st = grid.scrollTop, sl = grid.scrollLeft;
  const ky = ratio(totalH(), viewH()), kx = ratio(totalW(), viewW());
  if (ky === 1) { pos.y = st; } else if (Math.abs(st - pos.st) >= 1) { pos.y = st * ky; }
  if (kx === 1) { pos.x = sl; } else if (Math.abs(sl - pos.sl) >= 1) { pos.x = sl * kx; }
  pos.y = clampTo(pos.y, totalH(), viewH());
  pos.x = clampTo(pos.x, totalW(), viewW());
  pos.st = st; pos.sl = sl;
}
function setPos(y, x) {
  syncPos();
  if (y !== undefined) {
    pos.y = clampTo(y, totalH(), viewH());
    grid.scrollTop = pos.y / ratio(totalH(), viewH());
    pos.st = grid.scrollTop;
  }
  if (x !== undefined) {
    pos.x = clampTo(x, totalW(), viewW());
    grid.scrollLeft = pos.x / ratio(totalW(), viewW());
    pos.sl = grid.scrollLeft;
  }
  render();
}
/** 寸法が変わる操作の前後で、左上のセルが動かないようにする */
function keepTopLeft(fn) {
  if (!info) { fn(); return; }
  syncPos();
  const r = rows.at(pos.y / Z, info.rows), c = cols.at(pos.x / Z, info.cols);
  const fy = (pos.y / Z - rows.pos(r)) / rows.size(r), fx = (pos.x / Z - cols.pos(c)) / cols.size(c);
  fn();
  sizeSpacer();
  setPos((rows.pos(r) + fy * rows.size(r)) * Z, (cols.pos(c) + fx * cols.size(c)) * Z);
}

// ---- 問い合わせ ----
function send(q, p, slow) {
  const reqId = ++reqSeq;
  pending.set(reqId, p);
  vscode.postMessage({ type: "query", reqId, q, slow: !!slow });
  return reqId;
}
/** そのブロックで全文（改行あり・長い上限）が要る行。高くした行と、高さの自動調整を待つ行 */
function fullRows(br) {
  const a = br * BR, b = a + BR;
  const out = rows.keysIn(a, b).filter(r => rows.size(r) > rows.base);
  for (const r of fitPending) { if (r >= a && r < b && !out.includes(r)) { out.push(r); } }
  return out.sort((x, y) => x - y);
}
function request(br, bc) {
  const key = br + "," + bc;
  const full = fullRows(br), sig = full.join(",");
  const c = cache.get(key);
  if (c && c.gen === gen && c.sig === sig) { return; }
  if (failed.get(key) === gen) { return; }
  for (const p of pending.values()) { if (p.kind === "block" && p.key === key && p.gen === gen && p.sig === sig) { return; } }
  const v = qview();
  send({ op: "block", r0: br * BR, r1: br * BR + BR, c0: bc * BC, c1: bc * BC + BC, page, full, view: v },
       { kind: "block", key, gen, sig, view: !!v });
}

function onResult(reqId, res) {
  const p = pending.get(reqId);
  if (!p) { return; }
  pending.delete(reqId);
  if (p.kind === "labels") { onLabels(res); return; }
  if (p.kind === "stats") { onStats(p, res); return; }
  if (p.kind === "cell") { onCell(p, res); return; }
  if (!res || !res.ok) {
    failed.set(p.key, p.gen);
    lastError = (res && res.error) || "取得できませんでした";
    if (!info) { showOverlay(esc(lastError)); }
    renderFoot();
    return;
  }
  lastError = "";
  scope = res.scope || "";
  if (p.view && !res.block.view) {
    // view を知らない古い Python（0.1.9 以前）: 軸 0 が行・軸 1 が列のページ表示に戻す
    legacy = true;
    view = null;
    setInfo(res.info);
    renderDimbar();
    invalidate(true);
    return;
  }
  setInfo(res.info);
  if (res.block.rowLevels && !rwManual) {   // 行の MultiIndex: 段ごとに幅を広げる
    res.block.rowLevels.forEach((labs, k) => {
      const w = Math.min(200, Math.ceil(Math.max(0, ...labs.map(x => measure(String(x))))) + 14);
      rwl[k] = Math.max(rwl[k] || 30, w);
    });
    const sum = rwl.reduce((a, b) => a + b, 0);
    if (sum !== RW0) { RW0 = sum; sizeSpacer(); }
  } else if (info.labels && res.block.rowLabels && !rwManual) {   // 行ラベル（日時など）が切れないよう広げる（狭めはしない）
    const w = Math.min(240, Math.ceil(Math.max(0, ...res.block.rowLabels.map(x => measure(String(x))))) + 14);
    if (w > RW0) { RW0 = w; sizeSpacer(); }
  }
  if (!!p.view !== !!view) { render(); return; }   // ビューの有無が変わる前の答え（形が違う）は捨てる
  const entry = { gen: p.gen, sig: p.sig, ...res.block };
  const old = cache.get(p.key);
  if (p.gen === gen || !old) { cache.set(p.key, entry); }   // 古くても空よりはよい（すぐ取り直す）
  if (fitPending.size && res.block.full) {
    const done = res.block.full.filter(r => fitPending.has(r));
    if (done.length) { for (const r of done) { fitPending.delete(r); } fitRows(done, true); }
  }
  hideOverlay();
  render();
}

/** Python の info を受け取る。3 次元以上の配列はビューを当てた表の情報にする */
function setInfo(r) {
  const shapeSame = raw && JSON.stringify(raw.shape) === JSON.stringify(r.shape) && raw.kind === r.kind;
  raw = r;
  let fresh = false;
  if (r.kind === "ndarray" && r.shape.length >= 3 && !legacy) {
    if (!view || !shapeSame) { view = initialView(r.shape); fixCur(); fresh = true; }
  } else { view = null; }
  applyInfo(derive(r), false);
  if (!shapeSame) { renderDimbar(); }
  // ビューを決める前に取った値（最初の問い合わせ・形が変わる前）は使えないので取り直す
  if (fresh) { invalidate(true); }
}
/** 開いたときの見え方: 前に開いたときと形が同じならそのビュー、それ以外は既定（defaultView） */
function initialView(shape) {
  const s = LAYOUT.view;
  if (s && JSON.stringify(s.shape) === JSON.stringify(shape)) {
    const t = parseViewIndex(viewIndexText(shape.length, s), shape);
    if (typeof t !== "string" && t.row === s.row) { return { row: s.row, cols: s.cols.slice(), fix: { ...s.fix } }; }
  }
  return defaultView(shape);
}
/** ビューを当てた表の行数・列数（固定の軸に大きさ 0 があれば空の表。Python の _Nd と同じ） */
function viewDims(r, v) {
  if (Object.keys(v.fix).some(k => r.shape[+k] === 0)) { return [0, 1]; }
  let nc = 1;
  for (const a of v.cols) { nc *= r.shape[a]; }
  return [r.shape[v.row], nc];
}
/** 行見出しの自動の幅（100%）: 行番号・座標・MultiIndex の段 */
function autoRWBase() {
  if (!info) { return 48; }
  if (rowLv() > 1) {
    if (rwl.length !== rowLv()) { rwl = new Array(rowLv()).fill(40); }
    return rwl.reduce((a, b) => a + b, 0);
  }
  let w = Math.max(48, Math.ceil(measure(String(Math.max(0, info.rows - 1)))) + 16);
  if (info.labels) { w = Math.max(w, 72); }
  const co = view && raw && raw.coords && raw.coords[view.row];
  if (co && co.length) { w = Math.max(w, Math.min(240, Math.ceil(Math.max(...co.map(x => measure(String(x))))) + 14)); }
  return w;
}
function derive(r) {
  if (!view) { return r; }
  const [nr, nc] = viewDims(r, view);
  return { ...r, rows: nr, cols: nc, pages: [], view };
}
/** 表の大きさ・種類・ビューの署名が変わったら、寸法を作り直す */
function applyInfo(i, force) {
  const sigOf = x => x.kind + "|" + x.cols + "|" + (x.view ? viewSig(x.view) : "");
  const shapeChanged = force || !info || info.rows !== i.rows || info.cols !== i.cols
    || info.kind !== i.kind || JSON.stringify(info.pages) !== JSON.stringify(i.pages)
    || (info.view ? viewSig(info.view) : "") !== (i.view ? viewSig(i.view) : "")
    || info.rowLevels !== i.rowLevels || info.colLevels !== i.colLevels;
  const kindChanged = !info || sigOf(info) !== sigOf(i);
  info = i;
  if (!shapeChanged) { renderMeta(); return; }
  readFont();
  if (!rwManual) { RW0 = autoRWBase(); }
  rows.clear();                  // 個別の行の高さは形が変わったら捨てる（番号がずれるため）
  if (kindChanged) {
    cols.setBase(i.kind === "dataframe" ? 110 : 96);
    labels = null; labelLevels = null;
    applySaved();
    if (i.kind === "dataframe" || i.kind === "series") { send({ op: "collabels" }, { kind: "labels" }); }
  }
  frozenR = Math.min(frozenR, i.rows); frozenC = Math.min(frozenC, i.cols);
  page = i.pages.map((n, k) => Math.max(0, Math.min(page[k] || 0, n - 1)));
  renderPages();
  if (sel) {   // 形が変わっても選択は範囲内に収める
    const cl = (v, n) => Math.max(0, Math.min(v, n - 1));
    extra = extra.filter(c => c < i.cols);
    if (i.rows === 0 || i.cols === 0) { sel = null; extra = []; }
    else { sel = { ar: cl(sel.ar, i.rows), ac: cl(sel.ac, i.cols), fr: cl(sel.fr, i.rows), fc: cl(sel.fc, i.cols) }; }
  }
  sizeSpacer();
  renderMeta();
}

// ---- 列幅の記憶（DataFrame は列名、それ以外は列番号） ----
function labelIndex() {
  if (!labels) { return null; }
  const m = new Map(), dup = new Set();
  labels.forEach((l, i) => { if (m.has(l)) { dup.add(l); } else { m.set(l, i); } });
  for (const d of dup) { m.delete(d); }
  return m;
}
/** 列番号で覚える場所。3 次元以上はビューの署名ごと（"r0|c1" は 0.1.9 までの byIndex と同じ） */
function idxStore() {
  if (view && viewSig(view) !== "r0|c1") {
    const s = viewSig(view);
    return saved.byView[s] || (saved.byView[s] = {});
  }
  return saved.byIndex;
}
function applySaved() {
  if (!info) { return; }
  const out = new Map();
  for (const [k, w] of Object.entries(idxStore())) {
    const c = +k;
    if (Number.isInteger(c) && c >= 0 && c < info.cols) { out.set(c, clampN(+w, COL_MIN, COL_MAX)); }
  }
  const li = labelIndex();
  if (li) { for (const [l, w] of Object.entries(saved.byLabel)) { if (li.has(l)) { out.set(li.get(l), clampN(+w, COL_MIN, COL_MAX)); } } }
  cols.replace(out);
  sizeSpacer();
}
function onLabels(res) {
  labels = res && res.ok && Array.isArray(res.labels) ? res.labels.map(String) : null;
  labelLevels = res && res.ok && Array.isArray(res.levels) ? res.levels.map(l => l.map(String)) : null;
  keepTopLeft(applySaved);
}
/** 列幅を記憶に書く（w が既定なら消す） */
function rememberCol(c, w) {
  const li = labelIndex();
  const lab = labels && li && li.get(labels[c]) === c ? labels[c] : null;
  const dflt = w === cols.base;
  const st = idxStore();
  if (lab !== null) {
    if (dflt) { delete saved.byLabel[lab]; } else { saved.byLabel[lab] = w; }
    delete st[c];
  } else if (dflt) { delete st[c]; } else { st[c] = w; }
}
let saveTimer = 0;
function saveLayout() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    for (const k of Object.keys(saved.byView)) { if (!Object.keys(saved.byView[k]).length) { delete saved.byView[k]; } }
    vscode.postMessage({ type: "layout", data: {
      kind: info ? info.kind : undefined, rw: rwManual ? RW0 : undefined,
      byLabel: saved.byLabel, byIndex: saved.byIndex,
      byView: Object.keys(saved.byView).length ? saved.byView : undefined,
      view: view && raw ? { shape: raw.shape, row: view.row, cols: view.cols, fix: view.fix } : LAYOUT.view,
      rh: rows.base === 22 ? undefined : rows.base, zoom: Math.round(Z * 100), split: split || undefined } });
  }, 500);
}

// ---- 次元バー（3 次元以上の配列の見え方） ----
function fixCur() {
  const fk = view ? Object.keys(view.fix).map(Number).sort((a, b) => a - b) : [];
  if (curFix === undefined || !fk.includes(curFix)) { curFix = fk.length ? fk[0] : undefined; }
}
/** ビューを変える。行・列の軸が変わったら表を作り直し、固定の番号だけなら値を取り直す */
function setView(v) {
  if (!raw) { return; }
  const sigChanged = !view || viewSig(view) !== viewSig(v);
  view = v;
  fixCur();
  if (sigChanged) { frozenR = 0; frozenC = 0; }
  applyInfo(derive(raw), sigChanged);
  if (sigChanged) { setPos(0, 0); }
  invalidate(sigChanged);        // 番号だけなら古い値を出したまま取り直す（Alt+↓ を押し続けても追いつく）
  renderDimbar();
  saveLayout();
  selChanged();
}
function setRole(k, role) {
  const v = { row: view.row, cols: view.cols.slice(), fix: { ...view.fix } };
  const was = v.row === k ? "row" : v.cols.includes(k) ? "col" : "fix";
  if (role === was) { return; }
  const sortN = a => a.sort((x, y) => x - y);
  if (role === "row") {          // 元の行の軸は列になる（行は常に 1 つ）
    const old = v.row;
    v.row = k; v.cols = v.cols.filter(a => a !== k); delete v.fix[k];
    v.cols.push(old); sortN(v.cols);
  } else if (role === "col") {
    if (was === "row") {         // 新しい行: 残りの列の先頭、無ければ固定の先頭
      const others = v.cols;
      const fk = sortN(Object.keys(v.fix).map(Number));
      if (others.length) { v.row = others[0]; v.cols = others.slice(1); }
      else { v.row = fk[0]; delete v.fix[fk[0]]; v.cols = []; }
    } else { delete v.fix[k]; }
    v.cols.push(k); sortN(v.cols);
  } else {
    if (was === "row") {
      if (v.cols.length < 2) { return vmsg("列の軸が 1 つ以上必要です"); }
      v.row = v.cols[0]; v.cols = v.cols.slice(1);
    } else {
      if (v.cols.length < 2) { return vmsg("列の軸が 1 つ以上必要です"); }
      v.cols = v.cols.filter(a => a !== k);
    }
    v.fix[k] = 0;
    curFix = k;
  }
  setView(v);
}
function stepFix(k, d, abs) {
  if (!view || view.fix[k] === undefined) { return; }
  const n = raw.shape[k];
  let x = abs !== undefined ? abs : view.fix[k] + d;
  if (abs !== undefined && x < 0) { x += n; }
  x = clampN(x, 0, Math.max(0, n - 1));
  curFix = k;
  if (x === view.fix[k]) { renderDimbar(); return; }
  setView({ row: view.row, cols: view.cols, fix: { ...view.fix, [k]: x } });
}
function swapRowCol() {
  if (!view) { return; }
  const c0 = view.cols[0];
  const cols2 = [view.row, ...view.cols.slice(1)].sort((a, b) => a - b);
  setView({ row: c0, cols: cols2, fix: { ...view.fix } });
}
function vmsg(t) { const e = $("vmsg"); if (e) { e.textContent = t || ""; } }
function renderDimbar() {
  const el = $("dimbar");
  if (!view || !raw) { el.classList.remove("on"); el.innerHTML = ""; return; }
  el.classList.add("on");
  const sh = raw.shape, dims = raw.dims || null;
  const NAMES = { row: "行", col: "列", fix: "固定" };
  let h = "";
  for (let k = 0; k < sh.length; k++) {
    const role = view.row === k ? "row" : view.cols.includes(k) ? "col" : "fix";
    h += '<span class="ax' + (role === "fix" && curFix === k ? " cur" : "") + '" data-ax="' + k + '">軸' + k
      + (dims && dims[k] ? " <b>" + esc(dims[k]) + "</b>" : "")
      + ' <select data-role="' + k + '" title="この軸の役割">'
      + ["row", "col", "fix"].map(r => '<option value="' + r + '"' + (r === role ? " selected" : "") + ">" + NAMES[r] + "</option>").join("")
      + "</select>";
    if (role === "fix") {
      h += ' <button class="sm" data-step="-1" data-k="' + k + '" title="番号を −1（Alt+↑）">◀</button>'
        + '<input type="text" data-fix="' + k + '" value="' + view.fix[k] + '" title="番号（負の数は後ろから）。ホイールで ±1">'
        + '<button class="sm" data-step="1" data-k="' + k + '" title="番号を +1（Alt+↓）">▶</button> /' + sh[k];
    } else { h += " " + sh[k].toLocaleString(); }
    h += "</span>";
  }
  const ctx = esc(JSON.stringify({ webviewSection: "viewExpr", preventDefaultContextMenuItems: true }));
  h += '<button id="swap" title="行の軸と（先頭の）列の軸を入れ替える">⇄ 行列入替</button>'
    + '<span>表示: <span class="vexpr" id="vexpr" data-vscode-context="' + ctx
    + '" title="クリックで添字（:, 500, : など）を入力。右クリックで式をコピー">' + esc(viewExpr(EXPR, info)) + "</span>"
    + " → 行 " + info.rows.toLocaleString() + " × 列 " + info.cols.toLocaleString() + "</span>"
    + '<span class="err" id="vmsg"></span>';
  el.innerHTML = h;
}
function editViewExpr() {
  const e = $("vexpr");
  if (!e || !view) { return; }
  const inp = document.createElement("input");
  inp.id = "vedit";
  inp.value = viewIndexText(raw.shape.length, view);
  inp.title = "整数と : だけ。: が 2 つなら前が行・後ろが列、3 つ以上なら先頭が行・残りを列に展開。Enter で確定、Esc で取り消し";
  e.replaceWith(inp);
  inp.focus(); inp.select();
  let done = false;
  inp.addEventListener("keydown", ev => {
    ev.stopPropagation();
    if (ev.key === "Escape") { done = true; renderDimbar(); grid.focus(); }
    if (ev.key !== "Enter") { return; }
    const v = parseViewIndex(inp.value, raw.shape);
    if (typeof v === "string") { vmsg(v); return; }   // エラー: 表示は変えない
    done = true;
    setView(v);
    grid.focus();
  });
  inp.addEventListener("blur", () => { if (!done) { renderDimbar(); } });
}
$("dimbar").addEventListener("change", e => {
  const t = e.target;
  if (t.dataset.role !== undefined) { setRole(+t.dataset.role, t.value); return; }
  if (t.dataset.fix !== undefined) {
    const x = parseInt(t.value, 10);
    if (Number.isNaN(x)) { renderDimbar(); return; }
    stepFix(+t.dataset.fix, 0, x);
  }
});
$("dimbar").addEventListener("click", e => {
  const s = e.target.closest("[data-step]");
  if (s) { stepFix(+s.dataset.k, +s.dataset.step); return; }
  if (e.target.closest("#swap")) { swapRowCol(); return; }
  if (e.target.closest("#vexpr")) { editViewExpr(); return; }
  const ax = e.target.closest(".ax");
  if (ax && view && view.fix[+ax.dataset.ax] !== undefined && curFix !== +ax.dataset.ax) { curFix = +ax.dataset.ax; renderDimbar(); }
});
$("dimbar").addEventListener("wheel", e => {
  const t = e.target;
  if (!t.dataset || t.dataset.fix === undefined) { return; }
  e.preventDefault();
  stepFix(+t.dataset.fix, e.deltaY > 0 ? 1 : -1);
}, { passive: false });
$("dimbar").addEventListener("keydown", e => {
  const t = e.target;
  if (t.dataset && t.dataset.fix !== undefined && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    e.preventDefault();
    stepFix(+t.dataset.fix, e.key === "ArrowUp" ? 1 : -1);
  }
});

// ---- 見出しのラベル（ビュー・座標・MultiIndex） ----
function unravel(c, cs) {
  const out = new Array(cs.length);
  for (let d = cs.length - 1; d >= 0; d--) { out[d] = c % cs[d]; c = Math.floor(c / cs[d]); }
  return out;
}
function coordsOf(ax) { return raw && raw.coords ? raw.coords[ax] : undefined; }
/** 列の MultiIndex の段 k のラベル */
function colLevel(c, k) {
  if (labelLevels && labelLevels[k] && labelLevels[k][c] !== undefined) { return labelLevels[k][c]; }
  for (const e of cache.values()) {
    if (c >= e.c0 && c < e.c1 && e.colLevels) { return e.colLevels[k][c - e.c0]; }
  }
  return "";
}
/** 行の MultiIndex の段 k のラベル（読み込んでいなければ undefined） */
function rowLevel(r, k) {
  for (const e of cache.values()) {
    if (r >= e.r0 && r < e.r1 && e.rowLevels) { return e.rowLevels[k][r - e.r0]; }
  }
  return undefined;
}

// ---- サイズの変更 ----
function setColWidths(list, w) {
  w = clampN(Math.round(w), COL_MIN, COL_MAX);
  keepTopLeft(() => { cols.setMany(list, w); for (const c of list) { rememberCol(c, cols.size(c)); } });
  saveLayout();
}
function resetAllCols() {
  saved.byLabel = {}; saved.byIndex = {};
  keepTopLeft(() => cols.clear());
  saveLayout();
}
function setRowHeights(list, h) {
  h = clampN(Math.round(h), ROW_MIN, ROW_MAX);
  keepTopLeft(() => rows.setMany(list, h));
  render();
}
/** 選んだ列すべて（列全体を選んでいて、その中の列なら）。それ以外は c だけ */
function colTargets(c) {
  const s = norm();
  if (s && s.r0 === 0 && s.r1 === info.rows && (s.cols ? s.cols.includes(c) : c >= s.c0 && c < s.c1)) {
    if (s.cols) { return s.cols.slice(0, SizeAxis.MAX); }
    const out = [];
    for (let i = s.c0; i < s.c1 && out.length < SizeAxis.MAX; i++) { out.push(i); }
    return out;
  }
  return [c];
}
function rowTargets(r) {
  const s = norm();
  if (s && s.c0 === 0 && s.c1 === info.cols && r >= s.r0 && r < s.r1) {
    const out = [];
    for (let i = s.r0; i < s.r1 && out.length < SizeAxis.MAX; i++) { out.push(i); }
    return out;
  }
  return [r];
}
/** 読み込み済みのセルで列幅を合わせる（読んでいない行は測らない） */
function fitCols(list) {
  readFont();
  const want = new Set(list);
  const best = new Map();
  for (const c of list) { best.set(c, measure(colLabel(c))); }
  for (const e of cache.values()) {
    if (!e.cells) { continue; }
    for (const row of e.cells) {
      for (let j = 0; j < row.length; j++) {
        const c = e.c0 + j;
        if (!want.has(c)) { continue; }
        let m = 0;
        for (const line of String(row[j]).split("\\n")) { m = Math.max(m, measure(line)); }
        if (m > best.get(c)) { best.set(c, m); }
      }
    }
  }
  keepTopLeft(() => {
    for (const c of list) {
      cols.set(c, clampN(Math.ceil(best.get(c)) + 14, FIT_MIN, FIT_MAX));
      rememberCol(c, cols.size(c));
    }
  });
  saveLayout();
}
/** 行の高さを内容に合わせる。全文がまだ無い行は取り寄せてから測る（見えている行だけ） */
function fitRows(list, ready) {
  if (!info) { return; }
  readFont();
  const lh = LH0();
  const need = [], heights = new Map();
  for (const r of list) {
    const br = Math.floor(r / BR);
    let hasFull = ready;
    let lines = 1;
    for (const e of cache.values()) {
      if (e.r0 !== br * BR || !e.cells) { continue; }
      if (e.full && e.full.includes(r)) { hasFull = true; }
      const row = e.cells[r - e.r0];
      if (!row) { continue; }
      for (let j = 0; j < row.length; j++) {
        const avail = Math.max(8, cols.size(e.c0 + j) - 12);
        let n = 0;
        for (const line of String(row[j]).split("\\n")) { n += Math.max(1, Math.ceil(measure(line) / avail)); }
        lines = Math.max(lines, n);
      }
    }
    if (!hasFull) { need.push(r); continue; }
    heights.set(r, lines <= 1 ? rows.base : clampN(lines * lh + 4, ROW_MIN, ROW_MAX));
  }
  if (heights.size) {
    keepTopLeft(() => { for (const [r, h] of heights) { rows.set(r, h); } });
  }
  if (need.length) { for (const r of need) { fitPending.add(r); } render(); }
}
function visibleRowsOf(list) {
  if (!info) { return []; }
  syncPos();
  const a = rows.at(pos.y / Z, info.rows), b = rows.at((pos.y + viewH()) / Z, info.rows) + 1;
  return list.filter(r => r >= a && r < b);
}
function autoRW() {
  rwManual = false;
  if (rowLv() > 1) { rwl = []; }
  RW0 = autoRWBase();
  for (const e of cache.values()) {
    if (rowLv() > 1 && e.rowLevels) {
      e.rowLevels.forEach((labs, k) => {
        rwl[k] = Math.max(rwl[k] || 30, Math.min(200, Math.ceil(Math.max(0, ...labs.map(x => measure(String(x))))) + 14));
      });
      RW0 = rwl.reduce((a, b) => a + b, 0);
    } else if (e.rowLabels) {
      RW0 = Math.max(RW0, Math.min(240, Math.ceil(Math.max(0, ...e.rowLabels.map(x => measure(String(x))))) + 14));
    }
  }
  sizeSpacer(); render(); saveLayout();
}

// ---- ズーム・行の高さ ----
function setZoom(z) {
  z = clampN(Math.round(z * 10) / 10, 0.5, 2);
  if (z === Z) { return; }
  keepTopLeft(() => { Z = z; grid.style.setProperty("--z", String(Z)); });
  $("zl").textContent = Math.round(Z * 100) + "%";
  readFont();
  saveLayout();
}
function setDensity(h) {
  keepTopLeft(() => rows.setBase(h));
  $("rh").value = String(h);
  saveLayout();
}

function renderMeta() {
  if (!info) { return; }
  const size = info.shape.length ? info.shape.join("×") : "1×1";
  $("meta").textContent = size + "  " + info.cls + (scope ? "  ·  " + scope : "");
}

function renderPages() {
  const el = $("pages");
  if (!info || info.pages.length === 0) { el.innerHTML = ""; return; }
  let h = "[:, :";
  info.pages.forEach((n, k) => {
    h += ', <input type="number" min="0" max="' + (n - 1) + '" value="' + page[k]
      + '" data-k="' + k + '" title="' + (k + 3) + ' 次元目（0〜' + (n - 1) + '）">';
  });
  el.innerHTML = h + "]";
}
$("pages").addEventListener("change", e => {
  const t = e.target;
  if (!t.dataset || t.dataset.k === undefined || !info) { return; }
  const k = +t.dataset.k, n = info.pages[k];
  page[k] = Math.max(0, Math.min(Math.round(+t.value || 0), n - 1));
  t.value = page[k];
  invalidate(true);
  selChanged();
});

function norm() {
  if (!info || info.rows === 0 || info.cols === 0) { return null; }
  if (!sel) { return null; }
  const s = { r0: Math.min(sel.ar, sel.fr), r1: Math.max(sel.ar, sel.fr) + 1,
              c0: Math.min(sel.ac, sel.fc), c1: Math.max(sel.ac, sel.fc) + 1 };
  if (extra.length) {   // 離れた列: 連続していなければ cols（昇順）を付ける。c0 / c1 はその両端
    const set = new Set(extra);
    for (let c = s.c0; c < s.c1; c++) { set.add(c); }
    const list = [...set].sort((a, b) => a - b);
    s.c0 = list[0]; s.c1 = list[list.length - 1] + 1;
    if (s.c1 - s.c0 !== list.length) { s.cols = list; }
  }
  return s;
}
/** 選択の列数（離れた列を選んでいれば、その数） */
function selCols(t) { return t.cols ? t.cols.length : t.c1 - t.c0; }
/** プロット・コピーの対象。何も選んでいなければ全体 */
function target() {
  return norm() || (info ? { r0: 0, r1: info.rows, c0: 0, c1: info.cols } : null);
}

function cellOf(r, c) {
  const e = cache.get(Math.floor(r / BR) + "," + Math.floor(c / BC));
  if (!e) { return undefined; }
  const row = e.cells[r - e.r0];
  return row ? row[c - e.c0] : undefined;
}
function rowLabel(r) {
  if (view) { const co = coordsOf(view.row); return co && co[r] !== undefined ? co[r] : String(r); }
  if (!info.labels) { return String(r); }
  for (const e of cache.values()) {
    if (r >= e.r0 && r < e.r1 && e.rowLabels) { return e.rowLabels[r - e.r0]; }
  }
  return "";
}
function colLabel(c) {
  if (view) {      // 展開した列は [j,k]（座標があれば x/vx のように座標の値）
    const cs = view.cols.map(a => raw.shape[a]);
    if (cs.length === 1) { const co = coordsOf(view.cols[0]); return co && co[c] !== undefined ? co[c] : String(c); }
    const ix = unravel(c, cs);
    if (view.cols.every(a => coordsOf(a))) { return ix.map((i, d) => coordsOf(view.cols[d])[i]).join("/"); }
    return "[" + ix.join(",") + "]";
  }
  if (!info.labels) { return String(c); }
  if (labels && labels[c] !== undefined) { return labels[c]; }
  for (const e of cache.values()) {
    if (c >= e.c0 && c < e.c1 && e.colLabels) { return e.colLabels[c - e.c0]; }
  }
  return "";
}
/** 列見出しのツールチップ: ビューなら元の配列でのその列の式 */
function colTip(c, lab) {
  if (!view) { return lab; }
  return lab + "\\n" + selectionExpr(EXPR, info, { r0: 0, r1: info.rows, c0: c, c1: c + 1 }, [], false);
}

// ---- ヒートマップ ----
function numOf(v) {
  if (v === undefined || !NUM_RE.test(v) || /j$/.test(v)) { return NaN; }
  return parseFloat(v);   // Inf / NaN は NaN になり、色を付けない
}
/** 表示中のセルの最小・最大（全体と列ごと） */
function heatRange(rlist, clist) {
  const all = { min: Infinity, max: -Infinity }, col = new Map();
  for (const c of clist) {
    const s = { min: Infinity, max: -Infinity };
    for (const r of rlist) {
      const x = numOf(cellOf(r, c));
      if (!Number.isFinite(x)) { continue; }
      if (x < s.min) { s.min = x; } if (x > s.max) { s.max = x; }
    }
    col.set(c, s);
    if (s.min < all.min) { all.min = s.min; } if (s.max > all.max) { all.max = s.max; }
  }
  return { all, col };
}
/** 0 をまたぐなら 0 を中心にした発散型（負: 青、正: 赤）、またがないなら順序型 */
function heatColor(hr, c, v) {
  const x = numOf(v);
  const s = heatMode === "col" ? hr.col.get(c) : hr.all;
  if (!Number.isFinite(x) || !s || !(s.max >= s.min)) { return ""; }
  if (s.min < 0 && s.max > 0) {
    const m = Math.max(-s.min, s.max), t = x / m;
    return (t < 0 ? "rgba(59,130,246," : "rgba(239,68,68,") + (Math.abs(t) * 0.6).toFixed(3) + ")";
  }
  const span = s.max - s.min, t = span > 0 ? (x - s.min) / span : 0.5;
  const neg = s.max <= 0;          // 全部 0 以下なら青、それ以外は赤
  const a = 0.06 + 0.54 * (neg ? 1 - t : t);
  return (neg ? "rgba(59,130,246," : "rgba(239,68,68,") + a.toFixed(3) + ")";
}

// ---- ウィンドウ枠の固定 ----
function frozen() {
  const fr = info ? Math.min(frozenR, info.rows) : 0, fc = info ? Math.min(frozenC, info.cols) : 0;
  return { fr, fc, FH: rows.pos(fr) * Z, FW: cols.pos(fc) * Z };
}
function freezeAt(kind, n) {
  if (!info) { return; }
  if (kind === "col") {
    const fw = cols.pos(Math.min(n, info.cols)) * Z;
    if (n > 0 && fw > (grid.clientWidth - RWp()) * 0.8) { lastError = "固定する列が画面に収まりません"; renderFoot(); return; }
    frozenC = n;
  } else {
    const fh = rows.pos(Math.min(n, info.rows)) * Z;
    if (n > 0 && fh > (grid.clientHeight - HH()) * 0.8) { lastError = "固定する行が画面に収まりません"; renderFoot(); return; }
    frozenR = n;
  }
  lastError = "";
  render();
}

let raf = 0;
function render() {
  if (raf) { return; }
  raf = requestAnimationFrame(() => { raf = 0; draw(); });
}

function draw() {
  if (!info) { return; }
  syncPos();
  const st = grid.scrollTop, sl = grid.scrollLeft, h = grid.clientHeight, w = grid.clientWidth;
  const hh = HH(), rw = RWp();
  const ry = pos.y, rx = pos.x;
  const dy = st - ry, dx = sl - rx;     // 実位置 → 置く位置（縮尺しないときは 0）
  const nr = info.rows, nc = info.cols;
  const { fr, fc, FH, FW } = frozen();
  // 固定した行・列はいつも出し、残りはその後ろからスクロール位置に合わせて出す
  const rA = nr ? Math.max(fr, rows.at((ry + FH) / Z, nr)) : 0, rB = nr ? Math.min(nr, rows.at((ry + h - hh) / Z, nr) + 1) : 0;
  const cA = nc ? Math.max(fc, cols.at((rx + FW) / Z, nc)) : 0, cB = nc ? Math.min(nc, cols.at((rx + w - rw) / Z, nc) + 1) : 0;
  const rlist = [], clist = [];
  for (let r = 0; r < fr; r++) { rlist.push(r); }
  for (let r = rA; r < rB; r++) { rlist.push(r); }
  for (let c = 0; c < fc; c++) { clist.push(c); }
  for (let c = cA; c < cB; c++) { clist.push(c); }
  const brs = new Set(rlist.map(r => Math.floor(r / BR))), bcs = new Set(clist.map(c => Math.floor(c / BC)));
  for (const br of brs) { for (const bc of bcs) { request(br, bc); } }
  const ytop = r => hh + rows.pos(r) * Z + (r < fr ? st : dy);
  const xleft = c => rw + cols.pos(c) * Z + (c < fc ? sl : dx);
  const s = norm();
  const cset = s && s.cols ? new Set(s.cols) : null;
  const inC = c => s && (cset ? cset.has(c) : c >= s.c0 && c < s.c1);
  const inSel = (r, c) => s && r >= s.r0 && r < s.r1 && inC(c);
  const hr = heatOn && info.numeric ? heatRange(rlist, clist) : null;
  const lh = LH0() * Z;
  let out = "";
  const rowGeo = [];
  for (const r of rlist) {
    const top = ytop(r), ht = rows.size(r) * Z;
    const wrap = rows.size(r) > rows.base;
    const vstyle = wrap ? "height:" + ht + "px;line-height:" + lh + "px;-webkit-line-clamp:"
      + Math.max(1, Math.floor((ht - 4) / lh)) : "height:" + ht + "px;line-height:" + (ht - 1) + "px";
    const rb = fr > 0 && r === fr - 1 ? " fzb" : "";
    rowGeo.push([r, top, vstyle, wrap, rb]);
    for (const c of clist) {
      const v = cellOf(r, c);
      const on = inSel(r, c);
      const bg = hr && !on ? heatColor(hr, c, v) : "";
      const cls = "c" + (wrap ? " wrap" : "") + (v !== undefined && NUM_RE.test(v) ? " num" : "")
        + (v === undefined ? " wait" : "") + (c < fc ? " fzc" : r < fr ? " fzr" : "") + rb
        + (fc > 0 && c === fc - 1 ? " fzrb" : "")
        + (on ? " sel" : "") + (sel && sel.fr === r && sel.fc === c ? " cur" : "");
      out += '<div class="' + cls + '" data-r="' + r + '" data-c="' + c + '" style="top:' + top
        + 'px;left:' + xleft(c) + 'px;width:' + (cols.size(c) * Z) + 'px;' + vstyle
        + (bg ? ";background:" + bg : "") + '" title="' + esc(v ?? "") + '">' + (v === undefined ? "…" : esc(v)) + "</div>";
    }
  }
  // 列見出し（上に張り付く）。MultiIndex は段ごとに出し、上の段は隣り合う同じラベルをまとめる
  const L = colLv(), h1 = hh / L;
  const lstyle = "height:" + h1 + "px;line-height:" + (h1 - 1) + "px";
  for (let k = 0; k < L - 1; k++) {
    for (const seg of [clist.filter(c => c < fc), clist.filter(c => c >= fc)]) {
      let i = 0;
      while (i < seg.length) {
        let j = i;
        const same = (a, b) => { for (let q = 0; q <= k; q++) { if (colLevel(a, q) !== colLevel(b, q)) { return false; } } return true; };
        while (j + 1 < seg.length && seg[j + 1] === seg[j] + 1 && same(seg[i], seg[j + 1])) { j++; }
        const a = seg[i], b = seg[j], lab = colLevel(a, k);
        const hl = inC(a) && inC(b);
        out += '<div class="h col' + (hl ? " hl" : "") + (a < fc ? " fzh" : "") + '" data-r="-1" data-c="' + a + '" data-c2="' + b
          + '" style="top:' + (st + k * h1) + "px;left:" + xleft(a) + "px;width:" + (xleft(b) + cols.size(b) * Z - xleft(a))
          + "px;" + lstyle + (a < fc ? ";z-index:4" : "") + '" title="' + esc(lab) + '">' + esc(lab) + "</div>";
        i = j + 1;
      }
    }
  }
  const cstyle = "height:" + h1 + "px;line-height:" + (h1 - 1) + "px";
  for (const c of clist) {
    const hl = inC(c);
    const lab = L > 1 ? colLevel(c, L - 1) : colLabel(c);
    const ctx = esc(JSON.stringify({ webviewSection: "colHeader", col: c, preventDefaultContextMenuItems: true }));
    out += '<div class="h col' + (hl ? " hl" : "") + (fc > 0 && c === fc - 1 ? " fzrb" : "") + '" data-r="-1" data-c="' + c
      + '" data-vscode-context="' + ctx + '" style="top:' + (st + (L - 1) * h1) + "px;left:" + xleft(c) + "px;width:"
      + (cols.size(c) * Z) + "px;" + cstyle + (c < fc ? ";z-index:4" : "") + '" title="'
      + esc(colTip(c, L > 1 ? colLabel(c) : lab)) + '">' + esc(lab) + "</div>";
  }
  // 行見出し（左に張り付く）。MultiIndex は段ごとの列に分け、上の行と同じラベルは薄く出す
  const K = rowLv();
  const rsum = K > 1 ? rwl.reduce((a, b) => a + b, 0) || 1 : 1;
  for (const [r, top, vstyle, wrap, rb] of rowGeo) {
    const hl = s && r >= s.r0 && r < s.r1;
    const ctx = esc(JSON.stringify({ webviewSection: "rowHeader", row: r, preventDefaultContextMenuItems: true }));
    const zs = r < fr ? ";z-index:4" : "";
    if (K > 1) {
      let x = sl, rep = r > 0;
      for (let k = 0; k < K; k++) {
        const wk = (rwl[k] || 30) * (rw / Z) / rsum * Z;
        const lab = rowLevel(r, k) ?? "";
        rep = rep && rowLevel(r - 1, k) === lab;
        out += '<div class="h row lv' + (rep ? " rep" : "") + (wrap ? " wrap" : "") + (hl ? " hl" : "") + rb + '" data-r="' + r
          + '" data-c="-1" data-vscode-context="' + ctx + '" style="top:' + top + "px;left:" + x + "px;width:" + wk + "px;"
          + vstyle + zs + '" title="' + esc(lab) + '">' + esc(lab) + "</div>";
        x += wk;
      }
      continue;
    }
    const lab = rowLabel(r);
    out += '<div class="h row' + (wrap ? " wrap" : "") + (hl ? " hl" : "") + rb + '" data-r="' + r + '" data-c="-1" data-vscode-context="'
      + ctx + '" style="top:' + top + 'px;left:' + sl + 'px;width:' + rw + 'px;' + vstyle + zs + '" title="' + esc(lab) + '">'
      + esc(lab) + "</div>";
  }
  const hstyle = "height:" + hh + "px;line-height:" + (hh - 1) + "px";
  out += '<div class="h corner" data-r="-1" data-c="-1" title="すべて選択（Ctrl+A）" style="top:' + st
    + 'px;left:' + sl + 'px;width:' + rw + 'px;' + hstyle + ';z-index:5"></div>';
  layer.innerHTML = out;
  // 見えていない古い範囲は捨てる（メモリを使い続けないように）
  if (cache.size > 120) {
    for (const [k, e] of cache) {
      const keepR = e.r0 < fr, keepC = e.c0 < fc;   // 固定した行・列のブロックは残す
      if ((!keepR && (e.r1 < rA - 2 * BR || e.r0 > rB + 2 * BR)) || (!keepC && (e.c1 < cA - 2 * BC || e.c0 > cB + 2 * BC))) {
        cache.delete(k);
      }
    }
  }
  renderFoot();
  renderTools();
}

function selLabel() {
  const t = norm();
  if (!info) { return ""; }
  return selectionExpr(EXPR, info, t || { r0: 0, r1: info.rows, c0: 0, c1: info.cols }, page, false);
}

// ---- 統計（選択範囲） ----
let stat = null;                 // { seq, state: "wait"|"link"|"big"|"busy"|"done"|"err", data, error }
let statTimer = 0;
function selChanged(now) {
  selSeq++;
  stat = null;
  clearTimeout(statTimer);
  statTimer = setTimeout(() => { autoStats(); inspect(); }, now ? 0 : 250);
}
function autoStats(force) {
  const t = norm();
  if (!t || !info || ended) { stat = null; renderFoot(); return; }
  const n = (t.r1 - t.r0) * selCols(t);
  if (n <= 1 && !force) { stat = null; renderFoot(); return; }   // 1 セルは値そのもの
  if (n > ST_MAX) { stat = { seq: selSeq, state: "big" }; renderFoot(); return; }
  if (n > ST_AUTO && !force) { stat = { seq: selSeq, state: "link" }; renderFoot(); return; }
  stat = { seq: selSeq, state: "wait" };
  send({ op: "stats", ...t, page, view: qview() }, { kind: "stats", seq: selSeq }, n > ST_AUTO);
  renderFoot();
}
function onStats(p, res) {
  if (p.seq !== selSeq) { return; }   // 古い選択の答え
  if (!res || !res.ok) {
    stat = { seq: p.seq, state: res && res.transient ? "busy" : "err", error: res && res.error };
  } else { stat = { seq: p.seq, state: "done", data: res.stats }; }
  renderFoot();
}
function g6(v) {
  if (v === null || v === undefined) { return "NaN"; }
  if (typeof v === "string") { return v; }
  if (Number.isInteger(v) && Math.abs(v) < 1e15) { return String(v); }
  return String(Number(v.toPrecision(6)));
}
const sv = (name, v, raw) => name + ' <span class="sv" data-v="' + esc(raw ?? (v === null ? "nan" : String(v)))
  + '" title="クリックで丸めない値をコピー">' + esc(g6(v)) + "</span>";
function statsHtml() {
  if (!stat || stat.seq !== selSeq) { return ""; }
  switch (stat.state) {
    case "wait": return "統計を計算中…";
    case "link": return '<a data-act="stats">統計を計算</a>';
    case "busy": return '<a data-act="stats" title="実行中は値を読めません">統計を計算</a>';
    case "big": return "選択が大きすぎます（統計は " + ST_MAX.toLocaleString() + " セルまで）";
    case "err": return '<span class="err">' + esc(stat.error || "統計を計算できませんでした") + "</span>";
  }
  const d = stat.data;
  if (!d || d.kind === "none") { return ""; }
  const part = [];
  part.push("n " + d.n.toLocaleString());
  if (d.kind === "bool") {
    part.push("True " + d.true.toLocaleString() + "（" + (d.n ? (100 * d.true / d.n).toFixed(1) : "0") + "%）");
  } else if (d.kind === "complex") {
    const m = d.mean, sg = m[1] !== null && m[1] < 0 ? "" : "+";
    part.push('mean <span class="sv" data-v="' + esc(String(m[0]) + sg + String(m[1]) + "j")
      + '" title="クリックで丸めない値をコピー">' + esc(g6(m[0]) + sg + g6(m[1]) + "j") + "</span>");
    part.push(sv("|x| max", d.absmax));
  } else {
    part.push(sv("min", d.min), sv("max", d.max), sv("mean", d.mean), sv("std(N−1)", d.std));
    if (d.nan) { part.push("NaN " + d.nan.toLocaleString()); }
    if (d.inf) { part.push("Inf " + d.inf.toLocaleString()); }
  }
  let h = part.join(" · ");
  if (d.numCols < d.allCols) { h += "（数値 " + d.numCols + "/" + d.allCols + " 列）"; }
  return h;
}

function renderFoot() {
  const f = $("foot");
  if (ended) { f.innerHTML = '<span class="err">セッションが終了しました</span>'; return; }
  let h = "";
  if (info) {
    const t = norm();
    h += t ? "<span>選択 " + (t.r1 - t.r0) + "×" + selCols(t) + "  <code>" + esc(selLabel()) + "</code></span>"
           : "<span>選択なし（プロット・コピーは全体）</span>";
    const sh = statsHtml();
    if (sh) { h += "<span>" + sh + "</span>"; }
  }
  if (lastError) { h += '<span class="err">' + esc(lastError) + "</span>"; }
  f.innerHTML = h;
}
$("foot").addEventListener("click", e => {
  const a = e.target.closest("[data-act]");
  if (a && a.dataset.act === "stats") { autoStats(true); return; }
  const v = e.target.closest(".sv");
  if (v) { vscode.postMessage({ type: "clip", text: v.dataset.v }); }
});

function renderTools() {
  const t = target();
  for (const b of document.querySelectorAll("button[data-plot]")) {
    const code = info && t && !ended ? plotCode(b.dataset.plot, EXPR, info, t, page, { split }) : null;
    b.disabled = !code;
    b.dataset.code = code || "";
    b.title = (b.dataset.tip || (b.dataset.tip = b.title)) + (code ? "\\n\\n" + code : "");
  }
  $("copy").disabled = !info || ended;
}

function showOverlay(h) { const o = $("overlay"); o.innerHTML = h; o.style.display = "flex"; }
function hideOverlay() { $("overlay").style.display = "none"; }

/** 変数が変わった。今の表示は残したまま、見えている範囲を取り直す */
function invalidate(dropCache) {
  gen++;
  failed.clear();
  if (dropCache) { cache.clear(); }
  if (!info) { request(0, 0); return; }
  render();
}

// ---- インスペクタ（選んだセルの全文） ----
let inspSeq = 0, inspTimer = 0;
function applyInsp() {
  $("insp").classList.toggle("on", inspOn);
  $("insp").style.height = inspH + "px";
  $("insp-btn").classList.toggle("on", inspOn);
  vscode.setState({ ...(vscode.getState() || {}), inspOn, inspH });
}
function inspect() {
  if (!inspOn || !info) { return; }
  clearTimeout(inspTimer);
  inspTimer = setTimeout(() => {
    if (!sel) { $("insp-head").textContent = "セルを選ぶと、その値を全文で表示します"; $("insp-body").textContent = ""; return; }
    const r = sel.fr, c = sel.fc;
    const ex = selectionExpr(EXPR, info, { r0: r, r1: r + 1, c0: c, c1: c + 1 }, page, false);
    $("insp-head").innerHTML = "<code>" + esc(ex) + "</code>  読み込み中…";
    send({ op: "cell", r, c, page, view: qview() }, { kind: "cell", seq: ++inspSeq, ex });
  }, 120);
}
function onCell(p, res) {
  if (p.seq !== inspSeq) { return; }
  if (!res || !res.ok) {
    $("insp-head").innerHTML = "<code>" + esc(p.ex) + '</code>  <span class="err">' + esc((res && res.error) || "取得できませんでした") + "</span>";
    return;
  }
  const d = res.cell;
  $("insp-head").innerHTML = "<code>" + esc(p.ex) + "</code>  " + esc(d.type)
    + (d.len !== null && d.len !== undefined ? "  ·  " + d.len.toLocaleString() + " 文字" : "")
    + (d.cut ? "  ·  先頭 100,000 文字だけ表示" : "");
  $("insp-body").textContent = d.text;
}
$("insp-btn").addEventListener("click", () => { inspOn = !inspOn; applyInsp(); render(); inspect(); });
let inspDrag = null;
$("insp-split").addEventListener("mousedown", e => {
  e.preventDefault();
  inspDrag = { y: e.clientY, h: inspH };
  document.body.dataset.rz = "row";
});

// ---- マウス: 選択とサイズ変更 ----
function hit(ev) {
  const rect = grid.getBoundingClientRect();
  const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
  syncPos();
  const { FH, FW } = frozen();
  const hh = HH(), rw = RWp();
  // 固定した行・列の上はスクロール位置を足さない
  const r = y < hh ? -1 : rows.at((y - hh + (y - hh < FH ? 0 : pos.y)) / Z, info.rows);
  const c = x < rw ? -1 : cols.at((x - rw + (x - rw < FW ? 0 : pos.x)) / Z, info.cols);
  return { r: Math.min(r, info.rows - 1), c: Math.min(c, info.cols - 1) };
}
/** 見出しの端（サイズを変えられる場所）なら { kind, i } */
function edgeAt(ev) {
  if (!info) { return null; }
  const rect = grid.getBoundingClientRect();
  const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
  const hh = HH(), rw = RWp();
  if (x < 0 || y < 0 || x > grid.clientWidth || y > grid.clientHeight) { return null; }
  if (x < rw && rw - x <= 4) { return { kind: "rw" }; }
  syncPos();
  const { FH, FW } = frozen();
  // 列の境目は見出しの一番下の段だけ（MultiIndex の上の段はまとめた見出しなので境目ではない）
  if (y < hh && y >= hh - hh / colLv() && x >= rw && info.cols > 0) {
    const px = (x - rw + (x - rw < FW ? 0 : pos.x)) / Z, c = cols.at(px, info.cols);
    const left = cols.pos(c), right = left + cols.size(c);
    if ((right - px) * Z <= 4 && px < right + 4 / Z) { return { kind: "col", i: c }; }
    if ((px - left) * Z <= 4 && c > 0) { return { kind: "col", i: c - 1 }; }
  }
  if (x < rw && y >= hh && info.rows > 0) {
    const py = (y - hh + (y - hh < FH ? 0 : pos.y)) / Z, r = rows.at(py, info.rows);
    const top = rows.pos(r), bottom = top + rows.size(r);
    if ((bottom - py) * Z <= 3 && py < bottom + 3 / Z) { return { kind: "row", i: r }; }
    if ((py - top) * Z <= 3 && r > 0) { return { kind: "row", i: r - 1 }; }
  }
  return null;
}
function showGuide(kind, at) {
  const g = $("guide"), rect = grid.getBoundingClientRect();
  g.style.display = "block";
  if (kind === "row") {
    Object.assign(g.style, { left: rect.left + "px", width: grid.clientWidth + "px", top: at + "px", height: "1px" });
  } else {
    Object.assign(g.style, { top: rect.top + "px", height: grid.clientHeight + "px", left: at + "px", width: "1px" });
  }
}

layer.addEventListener("mousedown", ev => {
  if (!info || ev.button !== 0) { return; }
  const edge = edgeAt(ev);
  if (edge) {
    ev.preventDefault();
    if (ev.detail >= 2) {        // 端のダブルクリック: 内容に合わせる
      if (edge.kind === "col") { fitCols(colTargets(edge.i)); }
      else if (edge.kind === "row") { fitRows(visibleRowsOf(rowTargets(edge.i)), false); }
      else { autoRW(); }
      return;
    }
    const size = edge.kind === "col" ? cols.size(edge.i) : edge.kind === "row" ? rows.size(edge.i) : RW0;
    rz = { ...edge, x: ev.clientX, y: ev.clientY, size };
    if (edge.kind === "row") { showGuide("row", ev.clientY); }
    else { showGuide("col", ev.clientX); }
    return;
  }
  const d = ev.target.closest("[data-r]");
  if (!d) { return; }
  ev.preventDefault();
  grid.focus();
  const r = +d.dataset.r, c = +d.dataset.c;
  const last = { r: info.rows - 1, c: info.cols - 1 };
  // 列見出しの Ctrl+クリック: 離れた列を足す（選んである列なら外す）。行の範囲は今の選択のまま
  const add = (ev.ctrlKey || ev.metaKey) && !ev.shiftKey && r < 0 && c >= 0 ? norm() : null;
  if (!add) { extra = []; }
  if (add) {
    const c2 = d.dataset.c2 !== undefined ? +d.dataset.c2 : c;
    const list = add.cols ? add.cols.slice() : [];
    if (!add.cols) { for (let i = add.c0; i < add.c1; i++) { list.push(i); } }
    if (c2 === c && list.length > 1 && list.includes(c)) {
      extra = list.filter(x => x !== c);
      const k = extra.pop();
      sel = { ar: sel.ar, ac: k, fr: sel.fr, fc: k };
      drag = null;
    } else {
      extra = list;
      sel = { ar: sel.ar, ac: c, fr: sel.fr, fc: c2 };
      drag = c2 === c ? "col" : null;      // Ctrl+ドラッグ: 連続した列をまとめて足す
    }
  }
  else if (r < 0 && c < 0) { sel = { ar: 0, ac: 0, fr: last.r, fc: last.c }; drag = null; }
  else if (r < 0 && d.dataset.c2 !== undefined) {   // MultiIndex の上の段: まとめた列すべて
    sel = { ar: 0, ac: c, fr: last.r, fc: +d.dataset.c2 };
    drag = null;
  }
  else if (r < 0) {
    sel = ev.shiftKey && sel ? { ar: 0, ac: sel.ac, fr: last.r, fc: c } : { ar: 0, ac: c, fr: last.r, fc: c };
    drag = "col";
  } else if (c < 0) {
    sel = ev.shiftKey && sel ? { ar: sel.ar, ac: 0, fr: r, fc: last.c } : { ar: r, ac: 0, fr: r, fc: last.c };
    drag = "row";
  } else {
    sel = ev.shiftKey && sel ? { ...sel, fr: r, fc: c } : { ar: r, ac: c, fr: r, fc: c };
    drag = "cell";
  }
  if (drag) { selSeq++; stat = null; } else { selChanged(true); }   // ドラッグ中は統計を問い合わせない
  render();
});
window.addEventListener("mousemove", ev => {
  if (inspDrag) {
    if (!(ev.buttons & 1)) { inspDrag = null; delete document.body.dataset.rz; return; }
    inspH = clampN(inspDrag.h - (ev.clientY - inspDrag.y), 40, Math.max(60, window.innerHeight - 120));
    applyInsp();
    render();
    return;
  }
  if (rz) {
    if (!(ev.buttons & 1)) { endResize(ev); return; }
    if (rz.kind === "row") { showGuide("row", ev.clientY); } else { showGuide("col", ev.clientX); }
    return;
  }
  if (!drag) {                   // 端の上ではカーソルを変える
    const e = ev.buttons ? null : edgeAt(ev);
    const k = e ? (e.kind === "row" ? "row" : "col") : "";
    if ((document.body.dataset.rz || "") !== k) {
      if (k) { document.body.dataset.rz = k; } else { delete document.body.dataset.rz; }
    }
  }
  if (!drag || !info || !sel || !(ev.buttons & 1)) { drag = null; return; }
  const p = hit(ev);
  // 端まで来たらスクロールしながら広げる
  const rect = grid.getBoundingClientRect();
  if (ev.clientY > rect.bottom - 10) { setPos(pos.y + rows.base * Z); }
  const fz = frozen();
  if (ev.clientY < rect.top + HH() + fz.FH + 4) { setPos(pos.y - rows.base * Z); }
  if (ev.clientX > rect.right - 10) { setPos(undefined, pos.x + 48); }
  if (ev.clientX < rect.left + RWp() + fz.FW + 4) { setPos(undefined, pos.x - 48); }
  if (drag !== "col") { sel.fr = Math.max(0, p.r); }
  if (drag !== "row") { sel.fc = Math.max(0, p.c); }
  selSeq++; stat = null;
  render();
});
function endResize(ev) {
  const r = rz;
  rz = null;
  $("guide").style.display = "none";
  if (!r || !info) { return; }
  if (r.kind === "col") { setColWidths(colTargets(r.i), r.size + (ev.clientX - r.x) / Z); }
  else if (r.kind === "row") { setRowHeights(rowTargets(r.i), r.size + (ev.clientY - r.y) / Z); }
  else {
    rwManual = true;
    RW0 = clampN(Math.round(r.size + (ev.clientX - r.x) / Z), RW_MIN, RW_MAX);
    sizeSpacer(); render(); saveLayout();
  }
}
window.addEventListener("mouseup", ev => {
  if (inspDrag) { inspDrag = null; delete document.body.dataset.rz; return; }
  if (rz) { endResize(ev); return; }
  if (drag) { drag = null; selChanged(true); }
});

function scrollToCell(r, c) {
  syncPos();
  const { fr, fc, FH, FW } = frozen();
  const top = rows.pos(r) * Z, left = cols.pos(c) * Z, rh = rows.size(r) * Z, cw = cols.size(c) * Z;
  const h = viewH(), w = viewW();
  let y, x;
  // 固定した行・列はいつも見えている。それ以外は固定した分を除いた場所に収める
  if (r >= fr) {
    if (top < pos.y + FH) { y = top - FH; } else if (top + rh > pos.y + h) { y = Math.min(top - FH, top + rh - h); }
  }
  if (c >= fc) {
    if (left < pos.x + FW) { x = left - FW; } else if (left + cw > pos.x + w) { x = Math.min(left - FW, left + cw - w); }
  }
  if (y !== undefined || x !== undefined) { setPos(y, x); }
}

// ホイール: Ctrl+ホイールでズーム。縮尺しているときは実位置を動かす（そのままだと 1 目盛りで何十行も飛ぶ）
grid.addEventListener("wheel", ev => {
  if (!info) { return; }
  if (ev.ctrlKey) {
    ev.preventDefault();
    if (ev.deltaY) { setZoom(Z + (ev.deltaY < 0 ? 0.1 : -0.1)); }
    return;
  }
  const ky = ratio(totalH(), viewH()), kx = ratio(totalW(), viewW());
  if (ky === 1 && kx === 1) { return; }
  const unit = ev.deltaMode === 1 ? rows.base * Z : ev.deltaMode === 2 ? viewH() : 1;
  let ddy = ev.deltaY * unit, ddx = ev.deltaX * unit;
  if (ev.shiftKey && !ddx) { ddx = ddy; ddy = 0; }
  if ((ddy && ky !== 1) || (ddx && kx !== 1)) {
    ev.preventDefault();
    setPos(ddy ? pos.y + ddy : undefined, ddx ? pos.x + ddx : undefined);
  }
}, { passive: false });

grid.addEventListener("keydown", ev => {
  if (!info) { return; }
  const ctrl = ev.ctrlKey || ev.metaKey;
  if (ctrl && !ev.altKey && (ev.key === "=" || ev.key === "+" || ev.key === ";" || ev.key === "-" || ev.key === "0")) {
    ev.preventDefault(); ev.stopPropagation();
    setZoom(ev.key === "0" ? 1 : Z + (ev.key === "-" ? -0.1 : 0.1));
    return;
  }
  if (ev.altKey && !ctrl && view && ev.key.startsWith("Arrow")) {
    // Alt+↑↓: 選んでいる固定の軸の番号を ±1、Alt+←→: 固定の軸を切り替える
    ev.preventDefault(); ev.stopPropagation();
    const fk = Object.keys(view.fix).map(Number).sort((a, b) => a - b);
    if (!fk.length) { return; }
    fixCur();
    if (ev.key === "ArrowUp" || ev.key === "ArrowDown") { stepFix(curFix, ev.key === "ArrowDown" ? 1 : -1); }
    else {
      const i = fk.indexOf(curFix), d = ev.key === "ArrowRight" ? 1 : -1;
      curFix = fk[(i + d + fk.length) % fk.length];
      renderDimbar();
    }
    return;
  }
  if (info.rows === 0 || info.cols === 0) { return; }
  if (ctrl && ev.key.toLowerCase() === "a") {
    extra = []; sel = { ar: 0, ac: 0, fr: info.rows - 1, fc: info.cols - 1 }; ev.preventDefault(); selChanged(); render(); return;
  }
  if (ctrl && ev.key.toLowerCase() === "c") { ev.preventDefault(); copy(); return; }
  if (ev.key === " " && (ev.shiftKey || ctrl) && sel) {   // Shift+Space: 行全体、Ctrl+Space: 列全体
    ev.preventDefault();
    extra = [];
    sel = ev.shiftKey && !ctrl ? { ar: sel.ar, ac: 0, fr: sel.fr, fc: info.cols - 1 }
                               : { ar: 0, ac: sel.ac, fr: info.rows - 1, fc: sel.fc };
    selChanged(); render(); return;
  }
  const pageRows = Math.max(1, Math.floor(viewH() / (rows.base * Z)) - 1);
  const mv = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1],
               PageUp: [-pageRows, 0], PageDown: [pageRows, 0] }[ev.key];
  let r, c;
  const cur = sel || { ar: 0, ac: 0, fr: 0, fc: 0 };
  if (mv) {
    r = cur.fr + mv[0]; c = cur.fc + mv[1];
    if (ctrl) { if (mv[0]) { r = mv[0] < 0 ? 0 : info.rows - 1; } if (mv[1]) { c = mv[1] < 0 ? 0 : info.cols - 1; } }
  } else if (ev.key === "Home") { r = ctrl ? 0 : cur.fr; c = 0; }
  else if (ev.key === "End") { r = ctrl ? info.rows - 1 : cur.fr; c = info.cols - 1; }
  else if (ev.key === "Escape") { sel = null; extra = []; selChanged(); render(); return; }
  else { return; }
  ev.preventDefault();
  r = Math.max(0, Math.min(r, info.rows - 1)); c = Math.max(0, Math.min(c, info.cols - 1));
  extra = [];
  sel = ev.shiftKey && sel ? { ...sel, fr: r, fc: c } : { ar: r, ac: c, fr: r, fc: c };
  scrollToCell(r, c);
  selChanged();
  render();
});
grid.addEventListener("scroll", render);
new ResizeObserver(render).observe(grid);

function copy() {
  const t = target();
  if (!t || ended) { return; }
  vscode.postMessage({ type: "copy", sel: t, page, view: qview() || null, label: selLabel() });
}
$("copy").addEventListener("click", copy);
$("reload").addEventListener("click", () => invalidate(false));
$("rh").addEventListener("change", e => setDensity(+e.target.value));
$("zi").addEventListener("click", () => setZoom(Z + 0.1));
$("zo").addEventListener("click", () => setZoom(Z - 0.1));
$("zl").addEventListener("click", () => setZoom(1));
$("heat").addEventListener("click", () => {
  heatOn = !heatOn;
  $("heat").classList.toggle("on", heatOn);
  $("heat-scale").style.display = heatOn ? "" : "none";
  render();
});
$("heat-scale").addEventListener("change", e => { heatMode = e.target.value; render(); });
$("split").classList.toggle("on", split);
$("split").addEventListener("click", () => {
  split = !split;
  $("split").classList.toggle("on", split);
  renderTools();
  saveLayout();
});
for (const b of document.querySelectorAll("button[data-plot]")) {
  b.addEventListener("click", () => {
    if (b.dataset.code) { vscode.postMessage({ type: "plot", code: b.dataset.code }); }
  });
}

/** 右クリックメニュー（拡張から届く） */
function onMenu(m) {
  if (!info) { return; }
  const c = typeof m.col === "number" ? m.col : (sel ? sel.fc : 0);
  const r = typeof m.row === "number" ? m.row : (sel ? sel.fr : 0);
  switch (m.cmd) {
    case "colAutoFit": fitCols(colTargets(c)); break;
    case "colReset": setColWidths(colTargets(c), cols.base); break;
    case "colResetAll": resetAllCols(); break;
    case "rowAutoFit": fitRows(visibleRowsOf(rowTargets(r)), false); break;
    case "rowReset": setRowHeights(rowTargets(r), rows.base); break;
    case "rowResetAll": keepTopLeft(() => rows.clear()); break;
    case "freezeCols": freezeAt("col", c + 1); break;     // この列まで（0〜c）を固定
    case "freezeRows": freezeAt("row", r + 1); break;
    case "unfreeze": frozenR = 0; frozenC = 0; render(); break;
    case "copyViewExpr":
      if (view) { vscode.postMessage({ type: "clip", text: viewExpr(EXPR, info), label: "表示の式" }); }
      break;
  }
}

window.addEventListener("message", e => {
  const m = e.data;
  if (!m) { return; }
  if (m.type === "result") { onResult(m.reqId, m.res); }
  else if (m.type === "refresh") {
    if (!ended) {
      invalidate(false);
      if (stat && (stat.state === "done" || stat.state === "busy")) { selSeq++; autoStats(); }
      inspect();
    }
  }
  else if (m.type === "menu") { onMenu(m); }
  else if (m.type === "ended") {
    ended = true; renderFoot(); renderTools();
    if (!info) { showOverlay("セッションが終了しました"); }
  }
});
grid.style.setProperty("--z", String(Z));
$("zl").textContent = Math.round(Z * 100) + "%";
$("rh").value = String(rows.base);
applyInsp();
showOverlay("読み込み中…");
request(0, 0);
</script></body></html>`;
}
