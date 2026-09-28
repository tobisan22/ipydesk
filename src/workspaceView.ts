/**
 * ワークスペースビュー（MATLAB の「ワークスペース」）
 *
 * Python 側（ipydesk.workspace）が .vscode/py_workspace.json に書いた変数一覧を、
 * アクティビティバーの IPyDesk → WORKSPACE に表で出す。
 *  - 実行後 / プロンプトで打った後 : IPython の名前空間（Base）
 *  - ブレークポイントで停止中      : そのフレームのローカル変数
 * このビューは表示だけ。変数の中身を取りに Python へ問い合わせることはしない。
 * 配列・表をダブルクリック（または右クリック →「Variable Editor で開く」）すると、
 * Variable Editor で開く（中身の問い合わせは Variable Editor が行う）。
 */
import * as vscode from "vscode";

export const WORKSPACE_NAME = "py_workspace.json";   // Python → 拡張 : 変数一覧

export interface WsVar {
  name: string;
  value: string;
  size: string;
  cls: string;
  mark?: "" | "new" | "chg";
  open?: boolean;          // Variable Editor で開ける（配列・表・list）
  kids?: WsVar[];
  more?: number;
}

export interface WsData {
  seq: number;
  scope: string;
  stopped: boolean;
  where: string | null;
  vars: WsVar[];
}

export class WorkspaceViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "ipydesk.workspace";
  private view?: vscode.WebviewView;
  private data: WsData | null = null;
  private session?: string;
  /** 変数を Variable Editor で開く（ダブルクリック） */
  onOpen?: (expr: string) => void;

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = html(view.webview.cspSource);
    view.webview.onDidReceiveMessage(m => {
      if (m?.type === "ready") { this.post(); }
      if (m?.type === "open" && typeof m.expr === "string") { this.onOpen?.(m.expr); }
    });
    // 非表示の間に来た更新は捨てているので、見えた時点の最新を送り直す
    view.onDidChangeVisibility(() => { if (view.visible) { this.post(); } });
    view.onDidDispose(() => { this.view = undefined; });
    this.post();
  }

  /** null はセッションなし。session はセッションが複数あるときの表示名（"IPyDesk 2" など） */
  update(data: WsData | null, session?: string) {
    this.data = data;
    this.session = session;
    this.post();
  }

  private post() {
    const v = this.view;
    if (!v) { return; }
    const scope = this.data
      ? (this.data.stopped ? `⏸ ${this.data.scope}` : this.data.scope)
      : undefined;
    v.description = [this.session, scope].filter(Boolean).join(" · ") || undefined;
    if (v.visible) { void v.webview.postMessage({ type: "data", data: this.data }); }
  }
}

function nonce(): string {
  let s = "";
  const c = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) { s += c.charAt(Math.floor(Math.random() * c.length)); }
  return s;
}

function html(cspSource: string): string {
  const n = nonce();
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${n}';">
<style>
  body { padding: 0; margin: 0; color: var(--vscode-foreground);
         font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
  .bar { display: flex; gap: 6px; padding: 4px 8px 6px; align-items: center; }
  .bar input { flex: 1; min-width: 0; padding: 3px 6px; border-radius: 2px;
         color: var(--vscode-input-foreground); background: var(--vscode-input-background);
         border: 1px solid var(--vscode-input-border, transparent); font: inherit; }
  .bar input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .where { padding: 2px 8px 4px; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .where.stopped { color: var(--vscode-debugIcon-pauseForeground, var(--vscode-charts-orange)); }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th { text-align: left; font-weight: normal; font-size: 11px; padding: 2px 6px;
       color: var(--vscode-descriptionForeground);
       border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, #8884)); }
  td { padding: 1px 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  tr.row:hover { background: var(--vscode-list-hoverBackground); }
  tr.row.sel { background: var(--vscode-list-inactiveSelectionBackground); }
  .mono { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
  .val { color: var(--vscode-descriptionForeground); }
  .sz  { color: var(--vscode-debugTokenExpression-number, var(--vscode-charts-green)); }
  .cls { color: var(--vscode-symbolIcon-classForeground, var(--vscode-charts-blue)); }
  .tw { display: inline-block; width: 12px; cursor: pointer; user-select: none; opacity: .8; }
  .kid td.nm { padding-left: 24px; }
  .op-ic { opacity: 0; margin-left: 5px; color: var(--vscode-textLink-foreground); cursor: pointer; }
  tr.row.op:hover .op-ic { opacity: .9; }
  .more td { color: var(--vscode-descriptionForeground); font-style: italic; padding-left: 24px; }
  .badge { display: inline-block; width: 6px; height: 6px; border-radius: 50%;
           margin-left: 5px; vertical-align: middle; }
  .badge.new { background: var(--vscode-charts-green); }
  .badge.chg { background: var(--vscode-charts-yellow); }
  .empty { padding: 10px 12px; color: var(--vscode-descriptionForeground); line-height: 1.6; }
  .legend { padding: 6px 10px; font-size: 11px; color: var(--vscode-descriptionForeground);
            display: flex; gap: 12px; flex-wrap: wrap; }
  col.c-name { width: 24%; } col.c-size { width: 14%; } col.c-cls { width: 28%; }
  @media (max-width: 300px) { .c-size, .sz { display: none; } col.c-cls { width: 32%; } }
</style></head><body>
<div class="bar"><input id="filter" placeholder="フィルター（名前・クラス）" spellcheck="false"></div>
<div id="where" class="where"></div>
<div id="list"></div>
<script nonce="${n}">
const vscode = acquireVsCodeApi();
const saved = vscode.getState() || {};
let data = null;
let filter = saved.filter || "";
let sel = null;
const open = new Set(saved.open || []);
const $ = id => document.getElementById(id);
$("filter").value = filter;

const esc = s => String(s ?? "").replace(/[&<>"]/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const save = () => vscode.setState({ filter, open: [...open] });

/** 展開した子の式: x[0] / d['k'] / obj.attr */
function kidExpr(parent, k) {
  if (k.startsWith("[")) { return parent + k; }
  if (/^[A-Za-z_]\\w*$/.test(k)) { return parent + "." + k; }
  return parent + "[" + k + "]";
}

function row(v, kid, parent) {
  const tw = v.kids ? (open.has(v.name) ? "▾" : "▸") : "";
  const mark = v.mark ? '<span class="badge ' + v.mark + '"></span>' : "";
  const expr = kid ? kidExpr(parent, v.name) : v.name;
  const tip = v.name + " = " + v.value + "\\n" + [v.size, v.cls].filter(Boolean).join("  ")
    + (v.open ? "\\n\\nダブルクリックで Variable Editor を開く" : "");
  const ctx = v.open ? ' data-vscode-context="' + esc(JSON.stringify(
    { webviewSection: "var", varExpr: expr, preventDefaultContextMenuItems: true })) + '"' : "";
  const ic = v.open ? '<span class="op-ic" data-open="1" title="Variable Editor で開く">⊞</span>' : "";
  return '<tr class="row' + (kid ? " kid" : "") + (v.open ? " op" : "") + (!kid && sel === v.name ? " sel" : "")
    + '" data-n="' + (kid ? "" : esc(v.name)) + '" data-x="' + (v.open ? esc(expr) : "")
    + '" title="' + esc(tip) + '"' + ctx + '>'
    + '<td class="nm mono">' + (kid ? "" : '<span class="tw">' + tw + "</span>") + esc(v.name) + mark + ic + "</td>"
    + '<td class="val mono">' + esc(v.value) + "</td>"
    + '<td class="sz mono">' + esc(v.size) + "</td>"
    + '<td class="cls">' + esc(v.cls) + "</td></tr>";
}

function render() {
  const where = $("where");
  if (!data) {
    where.textContent = "";
    $("list").innerHTML = '<div class="empty">IPyDesk のセッションがありません。<br>'
      + '.py を開いて F5 で実行すると、ここに変数が表示されます。</div>';
    return;
  }
  where.className = "where" + (data.stopped ? " stopped" : "");
  where.textContent = data.stopped ? "⏸ " + data.scope + " — " + data.where : data.scope;
  const f = filter.trim().toLowerCase();
  const vars = data.vars.filter(v => !f || (v.name + " " + v.cls).toLowerCase().includes(f));
  if (vars.length === 0) {
    $("list").innerHTML = '<div class="empty">' + (data.vars.length ? "一致する変数はありません" : "変数はありません") + "</div>";
    return;
  }
  let h = '<table><colgroup><col class="c-name"><col><col class="c-size"><col class="c-cls"></colgroup>'
    + '<thead><tr><th>名前</th><th>値</th><th class="c-size">サイズ</th><th>クラス</th></tr></thead><tbody>';
  for (const v of vars) {
    h += row(v, false);
    if (v.kids && open.has(v.name)) {
      for (const k of v.kids) { h += row(k, true, v.name); }
      if (v.more) { h += '<tr class="more"><td colspan="4">… 他 ' + v.more + " 件</td></tr>"; }
    }
  }
  h += "</tbody></table>";
  if (vars.some(v => v.mark)) {
    h += '<div class="legend"><span><span class="badge new"></span> 新規</span>'
      + '<span><span class="badge chg"></span> 直前の実行・ステップで変更</span></div>';
  }
  $("list").innerHTML = h;
}

$("filter").addEventListener("input", e => { filter = e.target.value; save(); render(); });
$("list").addEventListener("click", e => {
  const tr = e.target.closest("tr.row");
  if (!tr) { return; }
  if (e.target.closest(".op-ic") && tr.dataset.x) {   // ⊞ で開く
    vscode.postMessage({ type: "open", expr: tr.dataset.x });
    return;
  }
  // ダブルクリック: 配列・表なら Variable Editor で開く。それ以外で子があれば開閉。
  // 1 回目のクリックで表を描き直すため dblclick イベントは元の行に届かない。detail で判定する
  if (e.detail === 2 && !e.target.closest(".tw")) {
    if (tr.dataset.x) {
      vscode.postMessage({ type: "open", expr: tr.dataset.x });
      return;
    }
    const v = tr.dataset.n && data && data.vars.find(x => x.name === tr.dataset.n);
    if (v && v.kids) {
      open.has(v.name) ? open.delete(v.name) : open.add(v.name);
      save(); render();
    }
    return;
  }
  if (!tr.dataset.n) { return; }
  const n = tr.dataset.n;
  if (e.target.closest(".tw") && e.target.textContent) {
    open.has(n) ? open.delete(n) : open.add(n);
    save();
  }
  sel = n;
  render();
});
window.addEventListener("message", e => {
  if (e.data && e.data.type === "data") { data = e.data.data; render(); }
});
render();
vscode.postMessage({ type: "ready" });
</script></body></html>`;
}
