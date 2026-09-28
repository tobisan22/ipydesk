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
 */
import * as vscode from "vscode";
import { plotCode, selectionExpr } from "./varCode";

export interface VarQuery {
  op: "block" | "copy";
  expr: string;
  r0: number; r1: number; c0: number; c1: number;
  page?: number[];
}

export interface VariableEditorHost {
  /** Python へ問い合わせる（ipydesk.varview.handle の答えが返る） */
  query(sid: number, q: VarQuery): Promise<any>;
  /** コードをセッションで実行する（プロット） */
  run(sid: number, code: string): void;
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
  ) {
    this.panel = vscode.window.createWebviewPanel(
      VariableEditor.viewType, title, { viewColumn: column, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true });
    this.panel.iconPath = new vscode.ThemeIcon("table");
    this.panel.webview.html = html(this.panel.webview.cspSource, expr);
    this.panel.webview.onDidReceiveMessage(m => this.onMessage(m));
    this.panel.onDidDispose(() => host.closed(this));
  }

  private post(m: unknown) { void this.panel.webview.postMessage(m); }

  private async onMessage(m: any) {
    switch (m?.type) {
      case "query": {
        try {
          const res = await this.host.query(this.sid, { ...m.q, expr: this.expr });
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
          const res = await this.host.query(this.sid, { op: "copy", expr: this.expr, ...m.sel, page: m.page });
          if (!res?.ok) { throw new Error(res?.error ?? "取得できませんでした"); }
          await vscode.env.clipboard.writeText(res.text);
          vscode.window.setStatusBarMessage(`IPyDesk: ${m.label} をコピーしました`, 2000);
        } catch (e) {
          vscode.window.showErrorMessage(
            `IPyDesk: コピーに失敗しました — ${e instanceof Error ? e.message : String(e)}`);
        }
        break;
      }
    }
  }

  /** 変数が変わったかもしれない（実行・ステップの後）。見えている範囲を取り直させる */
  refresh() { this.post({ type: "refresh" }); }

  /** セッションが終わった */
  ended() { this.post({ type: "ended" }); }

  reveal() { this.panel.reveal(undefined, false); }
}

function nonce(): string {
  let s = "";
  const c = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) { s += c.charAt(Math.floor(Math.random() * c.length)); }
  return s;
}

export function html(cspSource: string, expr: string): string {
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
  .tools { display: flex; gap: 4px; margin-left: auto; flex-wrap: wrap; }
  button { display: inline-flex; align-items: center; gap: 4px; padding: 3px 9px; border-radius: 2px;
           border: 1px solid var(--vscode-button-border, transparent); cursor: pointer; font: inherit;
           color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: .4; cursor: default; }
  .sep { width: 1px; align-self: stretch; background: var(--vscode-panel-border, #8884); margin: 0 2px; }
  #grid { position: relative; flex: 1; overflow: auto; outline: none;
          font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
  #spacer { position: absolute; top: 0; left: 0; width: 1px; height: 1px; }
  .c, .h { position: absolute; box-sizing: border-box; height: 22px; line-height: 21px; padding: 0 6px;
           white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
           border-right: 1px solid var(--vscode-editorGroup-border, #8883);
           border-bottom: 1px solid var(--vscode-editorGroup-border, #8883); cursor: cell; user-select: none; }
  .c.num { text-align: right; }
  .c.sel { background: var(--vscode-editor-selectionBackground); }
  .c.cur { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .c.wait { color: var(--vscode-descriptionForeground); }
  .h { background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
       color: var(--vscode-descriptionForeground); z-index: 2; text-align: center; cursor: default; }
  .h.row { text-align: right; cursor: e-resize; }
  .h.col { cursor: s-resize; }
  .h.hl { color: var(--vscode-foreground); background: var(--vscode-list-inactiveSelectionBackground); }
  .h.corner { z-index: 3; cursor: pointer; }
  .foot { display: flex; gap: 12px; padding: 4px 10px; font-size: 12px; min-height: 18px;
          color: var(--vscode-descriptionForeground);
          border-top: 1px solid var(--vscode-panel-border, #8884); }
  .foot code { font-family: var(--vscode-editor-font-family); color: var(--vscode-foreground); }
  .foot .err { color: var(--vscode-errorForeground); }
  .overlay { position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
             padding: 20px; text-align: center; line-height: 1.7; z-index: 5;
             color: var(--vscode-descriptionForeground); background: var(--vscode-editor-background); }
</style></head><body>
<div class="bar">
  <div class="title"><span class="expr" id="expr"></span><span class="meta" id="meta">読み込み中…</span></div>
  <div class="pages" id="pages"></div>
  <div class="tools">
    <button class="primary" data-plot="line" title="選択範囲を折れ線で描く（列ごとに 1 本）">📈 Plot</button>
    <button data-plot="xy" title="1 列目を X、残りの列を Y にして描く">X–Y</button>
    <button data-plot="scatter" title="2 列を選んで、1 列目を X・2 列目を Y にした散布図">Scatter</button>
    <button data-plot="hist" title="選択範囲のヒストグラム">Hist</button>
    <button data-plot="image" title="選択範囲を画像（カラーマップ）として描く">Image</button>
    <span class="sep"></span>
    <button id="copy" title="選択範囲をタブ区切りでコピー（Ctrl+C）。Excel にそのまま貼れます">Copy</button>
    <button id="reload" title="最新の値を読み直す">⟳</button>
  </div>
</div>
<div id="grid" tabindex="0"><div id="spacer"></div><div id="layer"></div>
  <div class="overlay" id="overlay"></div></div>
<div class="foot" id="foot"></div>
<script nonce="${n}">
const vscode = acquireVsCodeApi();
const EXPR = ${JSON.stringify(expr).replace(/</g, "\\u003c")};
${selectionExpr.toString()}
${plotCode.toString()}

const RH = 22, HH = 22;          // 行の高さ・列見出しの高さ
const BR = 100, BC = 25;         // 問い合わせる単位（行・列）
let CW = 96, RW = 56;            // 列の幅・行見出しの幅
let info = null, scope = "";
let page = [];
let gen = 0;                     // 変数が変わるたびに増やす（古い答えを見分ける）
const cache = new Map();         // "br,bc" → { gen, r0, c0, cells, rowLabels, colLabels }
const pending = new Map();       // reqId → { key, gen }
const failed = new Map();        // key → gen（同じ世代では問い合わせ直さない）
let reqSeq = 0;
let sel = null;                  // { ar, ac, fr, fc }（両端を含む。a = 起点、f = 動かす端）
let drag = null;                 // "cell" | "row" | "col"
let ended = false, lastError = "";
const $ = id => document.getElementById(id);
const grid = $("grid"), layer = $("layer");
$("expr").textContent = EXPR;
const esc = s => String(s ?? "").replace(/[&<>"]/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const NUM_RE = /^[-+]?(\\d[\\d.]*(e[-+]?\\d+)?|\\.\\d+|Inf|NaN)([-+][\\d.]+(e[-+]?\\d+)?j)?$/i;

function request(br, bc) {
  const key = br + "," + bc;
  const c = cache.get(key);
  if (c && c.gen === gen) { return; }
  if (failed.get(key) === gen) { return; }
  for (const p of pending.values()) { if (p.key === key && p.gen === gen) { return; } }
  const reqId = ++reqSeq;
  pending.set(reqId, { key, gen });
  vscode.postMessage({ type: "query", reqId,
    q: { op: "block", r0: br * BR, r1: br * BR + BR, c0: bc * BC, c1: bc * BC + BC, page } });
}

function onResult(reqId, res) {
  const p = pending.get(reqId);
  if (!p) { return; }
  pending.delete(reqId);
  if (!res || !res.ok) {
    failed.set(p.key, p.gen);
    lastError = (res && res.error) || "取得できませんでした";
    if (!info) { showOverlay(esc(lastError)); }
    renderFoot();
    return;
  }
  lastError = "";
  scope = res.scope || "";
  setInfo(res.info);
  if (info.labels && res.block.rowLabels) {   // 行ラベル（日時など）が切れないよう、幅を広げる（狭めはしない）
    const len = Math.max(0, ...res.block.rowLabels.map(x => String(x).length));
    const w = Math.min(200, 14 + 8 * len);
    if (w > RW) { RW = w; $("spacer").style.width = (RW + info.cols * CW) + "px"; }
  }
  if (p.gen === gen) {
    cache.set(p.key, { gen: p.gen, ...res.block });
  } else if (!cache.has(p.key)) {
    cache.set(p.key, { gen: p.gen, ...res.block });   // 古くても空よりはよい（すぐ取り直す）
  }
  hideOverlay();
  render();
}

function setInfo(i) {
  const shapeChanged = !info || info.rows !== i.rows || info.cols !== i.cols
    || info.kind !== i.kind || JSON.stringify(info.pages) !== JSON.stringify(i.pages);
  info = i;
  if (!shapeChanged) { renderMeta(); return; }
  CW = i.kind === "dataframe" ? 110 : 96;
  RW = Math.max(48, 14 + 8 * String(Math.max(0, i.rows - 1)).length);
  if (i.labels) { RW = Math.max(RW, 72); }
  page = i.pages.map((n, k) => Math.max(0, Math.min(page[k] || 0, n - 1)));
  renderPages();
  if (sel) {   // 形が変わっても選択は範囲内に収める
    const cl = (v, n) => Math.max(0, Math.min(v, n - 1));
    if (i.rows === 0 || i.cols === 0) { sel = null; }
    else { sel = { ar: cl(sel.ar, i.rows), ac: cl(sel.ac, i.cols), fr: cl(sel.fr, i.rows), fc: cl(sel.fc, i.cols) }; }
  }
  $("spacer").style.width = (RW + i.cols * CW) + "px";
  $("spacer").style.height = (HH + i.rows * RH) + "px";
  renderMeta();
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
});

function norm() {
  if (!info || info.rows === 0 || info.cols === 0) { return null; }
  if (!sel) { return null; }
  return { r0: Math.min(sel.ar, sel.fr), r1: Math.max(sel.ar, sel.fr) + 1,
           c0: Math.min(sel.ac, sel.fc), c1: Math.max(sel.ac, sel.fc) + 1 };
}
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
  if (!info.labels) { return String(r); }
  for (const e of cache.values()) {
    if (r >= e.r0 && r < e.r1 && e.rowLabels) { return e.rowLabels[r - e.r0]; }
  }
  return "";
}
function colLabel(c) {
  if (!info.labels) { return String(c); }
  for (const e of cache.values()) {
    if (c >= e.c0 && c < e.c1 && e.colLabels) { return e.colLabels[c - e.c0]; }
  }
  return "";
}

let raf = 0;
function render() {
  if (raf) { return; }
  raf = requestAnimationFrame(() => { raf = 0; draw(); });
}

function draw() {
  if (!info) { return; }
  const st = grid.scrollTop, sl = grid.scrollLeft, h = grid.clientHeight, w = grid.clientWidth;
  const rA = Math.max(0, Math.floor(st / RH)), rB = Math.min(info.rows, Math.ceil((st + h - HH) / RH) + 1);
  const cA = Math.max(0, Math.floor(sl / CW)), cB = Math.min(info.cols, Math.ceil((sl + w - RW) / CW) + 1);
  for (let br = Math.floor(rA / BR); br * BR < rB; br++) {
    for (let bc = Math.floor(cA / BC); bc * BC < cB; bc++) { request(br, bc); }
  }
  const s = norm();
  const inSel = (r, c) => s && r >= s.r0 && r < s.r1 && c >= s.c0 && c < s.c1;
  let out = "";
  for (let r = rA; r < rB; r++) {
    const top = HH + r * RH;
    for (let c = cA; c < cB; c++) {
      const v = cellOf(r, c);
      const cls = "c" + (v !== undefined && NUM_RE.test(v) ? " num" : "") + (v === undefined ? " wait" : "")
        + (inSel(r, c) ? " sel" : "") + (sel && sel.fr === r && sel.fc === c ? " cur" : "");
      out += '<div class="' + cls + '" data-r="' + r + '" data-c="' + c + '" style="top:' + top
        + 'px;left:' + (RW + c * CW) + 'px;width:' + CW + 'px" title="' + esc(v ?? "") + '">'
        + (v === undefined ? "…" : esc(v)) + "</div>";
    }
  }
  for (let c = cA; c < cB; c++) {       // 列見出し（上に張り付く）
    const hl = s && c >= s.c0 && c < s.c1;
    const lab = colLabel(c);
    out += '<div class="h col' + (hl ? " hl" : "") + '" data-r="-1" data-c="' + c + '" style="top:' + st
      + 'px;left:' + (RW + c * CW) + 'px;width:' + CW + 'px" title="' + esc(lab) + '">' + esc(lab) + "</div>";
  }
  for (let r = rA; r < rB; r++) {       // 行見出し（左に張り付く）
    const hl = s && r >= s.r0 && r < s.r1;
    const lab = rowLabel(r);
    out += '<div class="h row' + (hl ? " hl" : "") + '" data-r="' + r + '" data-c="-1" style="top:'
      + (HH + r * RH) + 'px;left:' + sl + 'px;width:' + RW + 'px" title="' + esc(lab) + '">' + esc(lab) + "</div>";
  }
  out += '<div class="h corner" data-r="-1" data-c="-1" title="すべて選択（Ctrl+A）" style="top:' + st
    + 'px;left:' + sl + 'px;width:' + RW + 'px"></div>';
  layer.innerHTML = out;
  // 見えていない古い範囲は捨てる（メモリを使い続けないように）
  if (cache.size > 120) {
    for (const [k, e] of cache) {
      if (e.r1 < rA - 2 * BR || e.r0 > rB + 2 * BR || e.c1 < cA - 2 * BC || e.c0 > cB + 2 * BC) { cache.delete(k); }
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

function renderFoot() {
  const f = $("foot");
  if (ended) { f.innerHTML = '<span class="err">セッションが終了しました</span>'; return; }
  let h = "";
  if (info) {
    const t = norm();
    h += t ? "選択 " + (t.r1 - t.r0) + "×" + (t.c1 - t.c0) + "  <code>" + esc(selLabel()) + "</code>"
           : "選択なし（プロット・コピーは全体）";
  }
  if (lastError) { h += '  <span class="err">' + esc(lastError) + "</span>"; }
  f.innerHTML = h;
}

function renderTools() {
  const t = target();
  for (const b of document.querySelectorAll("button[data-plot]")) {
    const code = info && t && !ended ? plotCode(b.dataset.plot, EXPR, info, t, page) : null;
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

// ---- 選択 ----
function hit(ev) {
  const rect = grid.getBoundingClientRect();
  const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
  const r = y < HH ? -1 : Math.floor((y - HH + grid.scrollTop) / RH);
  const c = x < RW ? -1 : Math.floor((x - RW + grid.scrollLeft) / CW);
  return { r: Math.min(r, info.rows - 1), c: Math.min(c, info.cols - 1) };
}
layer.addEventListener("mousedown", ev => {
  if (!info || ev.button !== 0) { return; }
  const d = ev.target.closest("[data-r]");
  if (!d) { return; }
  ev.preventDefault();
  grid.focus();
  const r = +d.dataset.r, c = +d.dataset.c;
  const last = { r: info.rows - 1, c: info.cols - 1 };
  if (r < 0 && c < 0) { sel = { ar: 0, ac: 0, fr: last.r, fc: last.c }; drag = null; }
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
  render();
});
window.addEventListener("mousemove", ev => {
  if (!drag || !info || !sel || !(ev.buttons & 1)) { drag = null; return; }
  const p = hit(ev);
  // 端まで来たらスクロールしながら広げる
  const rect = grid.getBoundingClientRect();
  if (ev.clientY > rect.bottom - 10) { grid.scrollTop += RH; }
  if (ev.clientY < rect.top + HH + 4) { grid.scrollTop -= RH; }
  if (ev.clientX > rect.right - 10) { grid.scrollLeft += CW / 2; }
  if (ev.clientX < rect.left + RW + 4) { grid.scrollLeft -= CW / 2; }
  if (drag !== "col") { sel.fr = Math.max(0, p.r); }
  if (drag !== "row") { sel.fc = Math.max(0, p.c); }
  render();
});
window.addEventListener("mouseup", () => { drag = null; });

function scrollToCell(r, c) {
  const top = r * RH, left = c * CW;
  const h = grid.clientHeight - HH, w = grid.clientWidth - RW;
  if (top < grid.scrollTop) { grid.scrollTop = top; }
  else if (top + RH > grid.scrollTop + h) { grid.scrollTop = top + RH - h; }
  if (left < grid.scrollLeft) { grid.scrollLeft = left; }
  else if (left + CW > grid.scrollLeft + w) { grid.scrollLeft = left + CW - w; }
}

grid.addEventListener("keydown", ev => {
  if (!info || info.rows === 0 || info.cols === 0) { return; }
  const ctrl = ev.ctrlKey || ev.metaKey;
  if (ctrl && ev.key.toLowerCase() === "a") {
    sel = { ar: 0, ac: 0, fr: info.rows - 1, fc: info.cols - 1 }; ev.preventDefault(); render(); return;
  }
  if (ctrl && ev.key.toLowerCase() === "c") { ev.preventDefault(); copy(); return; }
  const pageRows = Math.max(1, Math.floor((grid.clientHeight - HH) / RH) - 1);
  const mv = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1],
               PageUp: [-pageRows, 0], PageDown: [pageRows, 0] }[ev.key];
  let r, c;
  const cur = sel || { ar: 0, ac: 0, fr: 0, fc: 0 };
  if (mv) {
    r = cur.fr + mv[0]; c = cur.fc + mv[1];
    if (ctrl) { if (mv[0]) { r = mv[0] < 0 ? 0 : info.rows - 1; } if (mv[1]) { c = mv[1] < 0 ? 0 : info.cols - 1; } }
  } else if (ev.key === "Home") { r = ctrl ? 0 : cur.fr; c = 0; }
  else if (ev.key === "End") { r = ctrl ? info.rows - 1 : cur.fr; c = info.cols - 1; }
  else if (ev.key === "Escape") { sel = null; render(); return; }
  else { return; }
  ev.preventDefault();
  r = Math.max(0, Math.min(r, info.rows - 1)); c = Math.max(0, Math.min(c, info.cols - 1));
  sel = ev.shiftKey && sel ? { ...sel, fr: r, fc: c } : { ar: r, ac: c, fr: r, fc: c };
  scrollToCell(r, c);
  render();
});
grid.addEventListener("scroll", render);
new ResizeObserver(render).observe(grid);

function copy() {
  const t = target();
  if (!t || ended) { return; }
  vscode.postMessage({ type: "copy", sel: t, page, label: selLabel() });
}
$("copy").addEventListener("click", copy);
$("reload").addEventListener("click", () => invalidate(false));
for (const b of document.querySelectorAll("button[data-plot]")) {
  b.addEventListener("click", () => {
    if (b.dataset.code) { vscode.postMessage({ type: "plot", code: b.dataset.code }); }
  });
}

window.addEventListener("message", e => {
  const m = e.data;
  if (!m) { return; }
  if (m.type === "result") { onResult(m.reqId, m.res); }
  else if (m.type === "refresh") { if (!ended) { invalidate(false); } }
  else if (m.type === "ended") {
    ended = true; renderFoot(); renderTools();
    if (!info) { showOverlay("セッションが終了しました"); }
  }
});
showOverlay("読み込み中…");
request(0, 0);
</script></body></html>`;
}
