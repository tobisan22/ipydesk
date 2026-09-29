/**
 * Figure タブの中身。
 *
 * いちばん下に今の図（webagg の iframe。操作・ズーム・保存ができる）を置き、
 * その上に、描き直す前の姿（Python 側 ipydesk.fighist が残した PNG）を古い順に並べる。
 * 描き直すたびに下へ積み上がっていくので、上へスクロールすると前の図を見られる。
 *  - 履歴が無ければ、これまでどおり今の図がタブ全体に出る
 *  - いちばん下を見ていれば、新しい履歴が増えても今の図が見える位置にとどまる
 *  - 履歴の更新は postMessage で行い、iframe（今の図）は作り直さない
 */

/** py_figures.json（ipydesk.core.notify_figures）の形 */
export interface FigureInfo {
  url: string;
  figures: number[];
  labels?: { [num: string]: string };
  ids?: { [num: string]: string };      // figure の実体（close して同じ番号で作り直すと変わる）
  history?: { [num: string]: HistItem[] };
  current?: { [num: string]: { time: string; label: string } };
}

export interface HistItem {
  seq: number;
  file: string;      // セッションの通知ディレクトリからの相対パス（fighist/1_00003.png）
  time: string;
  label: string;
  w: number;         // 表示の幅・高さ（CSS px）
  h: number;
}

function nonce(): string {
  let s = "";
  const c = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) { s += c.charAt(Math.floor(Math.random() * c.length)); }
  return s;
}

export function figureHtml(base: string, num: number, cspSource: string): string {
  const n = nonce();
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; frame-src ${base}; img-src ${cspSource}; style-src 'unsafe-inline'; script-src 'nonce-${n}';">
<style>
  html, body { margin:0; padding:0; width:100%; height:100%; }
  body { overflow-x:hidden; overflow-y:auto; color: var(--vscode-foreground);
         font-family: var(--vscode-font-family); font-size: 12px; }
  #live { position:relative; height:100vh; display:flex; flex-direction:column; }
  #live iframe { flex:1; width:100%; border:0; display:block; }
  .bar { display:flex; align-items:center; gap:10px; padding:3px 10px; min-height:20px;
         color: var(--vscode-descriptionForeground);
         background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
         border-bottom: 1px solid var(--vscode-panel-border, #8884); }
  .bar .no { font-weight:600; color: var(--vscode-foreground); }
  .bar .lab { font-family: var(--vscode-editor-font-family); overflow:hidden;
              text-overflow:ellipsis; white-space:nowrap; min-width:0; }
  .bar .sp { flex:1; }
  .bar button { border:0; padding:1px 6px; border-radius:2px; cursor:pointer; font:inherit;
                color: var(--vscode-foreground); background: transparent; }
  .bar button:hover { background: var(--vscode-toolbar-hoverBackground, #8883); }
  #live .bar { position:sticky; top:0; }
  #live .bar .no { color: var(--vscode-charts-green, var(--vscode-foreground)); }
  .entry { border-bottom: 6px solid var(--vscode-editorGroup-border, #8884); }
  .entry img { display:block; max-width:100%; height:auto; margin:6px 10px; }
  [hidden] { display:none !important; }
</style>
</head><body>
<div id="hist"></div>
<div id="live">
  <div class="bar" id="livebar" hidden>
    <span class="no">現在</span><span id="livetime"></span><span class="lab" id="livelab"></span>
    <span class="sp"></span><span id="count"></span>
    <button id="top" title="いちばん古い図へ">⤒</button>
    <button id="clear" title="このタブの履歴を消す（今の図はそのまま）">履歴を消す</button>
  </div>
  <iframe id="fig" src="${base}/${num}"></iframe>
</div>
<script nonce="${n}">
const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"]/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
let first = true;
let shown = "";

function atBottom() {
  const el = document.scrollingElement;
  return el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
}

function show(items, current) {
  const key = JSON.stringify([items.map(i => i.seq), current]);
  if (key === shown) { return; }
  shown = key;
  const stick = first || atBottom();
  first = false;
  $("livebar").hidden = items.length === 0;
  $("livetime").textContent = current ? current.time : "";
  $("livelab").textContent = current ? current.label : "";
  $("livelab").title = current ? current.label : "";
  $("count").textContent = items.length ? "履歴 " + items.length + " 件（上へスクロール）" : "";
  let h = "";
  items.forEach((it, i) => {
    h += '<div class="entry"><div class="bar"><span class="no">#' + (i + 1) + '</span>'
      + '<span>' + esc(it.time) + '</span><span class="lab" title="' + esc(it.label) + '">' + esc(it.label) + '</span>'
      + '<span class="sp"></span><button data-copy="' + esc(it.file) + '" title="この図を画像としてコピー">📋</button></div>'
      + '<img src="' + esc(it.src) + '" width="' + it.w + '" height="' + it.h + '" alt="Figure 履歴 #' + (i + 1) + '"></div>';
  });
  $("hist").innerHTML = h;
  // 今の図が見えていたら、履歴が増えても今の図が見える位置に置く（画像は大きさを先に決めてあるので即座に確定する）
  if (stick) { document.scrollingElement.scrollTop = document.scrollingElement.scrollHeight; }
}

$("hist").addEventListener("click", e => {
  const b = e.target.closest("button[data-copy]");
  if (b) { vscode.postMessage({ type: "copyImage", file: b.dataset.copy }); }
});
$("clear").addEventListener("click", () => vscode.postMessage({ type: "clearHistory" }));
$("top").addEventListener("click", () => { document.scrollingElement.scrollTop = 0; });
window.addEventListener("message", e => {
  const m = e.data;
  if (m && m.type === "history") { show(m.items || [], m.current); }
  // figure が作り直された（plt.close → 同じ番号で作成）。古い figure に繋がったままなので読み直す
  if (m && m.type === "reload") { const f = $("fig"); f.src = f.getAttribute("src"); }
});
vscode.postMessage({ type: "ready" });
</script>
</body></html>`;
}
