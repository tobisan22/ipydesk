/**
 * Notes ビュー（セクションで区切れるメモ帳）
 *
 * アクティビティバーの IPyDesk → NOTES に、メモをセクションごとに出す。
 *  - 保存先はユーザー単位（拡張の globalStorage の notes.md）。どのフォルダを開いても同じメモが出る
 *  - notes.md は Markdown。`## 名前` の行がセクションの区切り（コードブロック ``` の中の ## は区切りにしない）
 *    最初の `##` より前に書いた分は「名前なし」のセクションとして出す
 *  - セクションごとに: 名前の変更 / 折りたたみ / 本文のコピー / 削除
 *    折りたたみの状態は globalState に保存する（notes.md には書かない）
 *  - 入力すると自動で保存する（保存ボタンは無い）
 *  - VS Code を複数ウィンドウで開いていても、ほかのウィンドウで書いた内容がそのまま反映される
 *    （notes.md を監視して読み直す。同時に書いた場合は後から保存した方が残る）
 *  - 「IPyDesk: Open Notes File」で notes.md をエディタで開いて編集することもできる
 *  - 「IPyDesk: Add Selection to Notes」でエディタの選択範囲（無ければ現在行）を追記する
 *    追記先は、Notes で最後に入力したセクション（無ければ最後のセクション）
 *  - セクションは見出し左の ⋮⋮ をドラッグ、または Alt+↑/↓ で並べ替えられる
 *  - デフォルトのメモ（拡張に同梱した resources/default-notes.md）を、まだ入れたことのないものだけ notes.md に入れる
 *    入れた後は普通のセクションと同じで、削除してもまた入ることはない（拡張の更新で増えた分は入る）
 *    「IPyDesk: Restore Default Notes」で、消したデフォルトのセクションだけを末尾に戻せる（同じ名前があれば足さない）
 */
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

export const NOTES_NAME = "notes.md";
const FOLDED_KEY = "ipydesk.notesFolded";
const SEEDED_KEY = "ipydesk.notesSeeded";   // 入れたことのあるデフォルトのメモの名前（string[]）

interface Section { name: string | null; body: string }

export class NotesViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = "ipydesk.notes";
  private view?: vscode.WebviewView;
  private text: string;
  private readonly dir: string;
  readonly file: string;
  private saveTimer?: NodeJS.Timeout;
  private watchTimer?: NodeJS.Timeout;
  private watcher?: fs.FSWatcher;
  /** 自分が最後に書いた内容（監視で自分の書き込みを読み直さないため） */
  private written?: string;

  /**
   * @param storage  保存先フォルダ（context.globalStorageUri）
   * @param state    折りたたみ状態などを置く場所（context.globalState）
   * @param defaults 同梱のデフォルトメモ（resources/default-notes.md）
   */
  constructor(storage: vscode.Uri, private readonly state: vscode.Memento,
              private readonly defaults: string) {
    this.dir = storage.fsPath;
    this.file = path.join(this.dir, NOTES_NAME);
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch { /* 書けなければ保存時に知らせる */ }
    this.text = readText(this.file);
    this.written = this.text;
    this.seed();
    this.watch();
  }

  /**
   * まだ入れたことのないデフォルトのメモを入れる（既にメモがあれば末尾に足す）。最初は折りたたんでおく
   * 入れたセクションの名前を覚えておき、次からは足さない（ユーザーが消したものは戻らない）。
   * 拡張の更新でデフォルトのメモが増えたときは、増えた分だけが入る。
   */
  private seed() {
    const d = readText(this.defaults);
    if (!d.trim()) { return; }
    const defs = notesLib.parseNotes(d).filter(s => s.name !== null);
    const prev = this.state.get<string[] | number>(SEEDED_KEY);
    // 旧形式（数字）: 最初の 3 つを入れた状態
    const seen = new Set(Array.isArray(prev) ? prev : prev ? [
      "matplotlib: subplots の基本", "matplotlib: 軸の範囲・目盛り", "外部 exe の実行（subprocess）"] : []);
    const add = defs.filter(s => !seen.has(s.name as string));
    if (add.length === 0) { return; }
    void this.state.update(SEEDED_KEY, [...seen, ...add.map(s => s.name as string)]);
    // 同じ名前のセクションを自分で作っていたら足さない
    const have = new Set(notesLib.parseNotes(this.text).map(s => s.name));
    const fresh = add.filter(s => !have.has(s.name));
    if (fresh.length) { this.addSections(fresh, true); }
  }

  /** デフォルトのセクションのうち、今のメモに無い名前のものを末尾に戻す */
  async restoreDefaults() {
    this.flush();
    const names = new Set(notesLib.parseNotes(this.text).map(s => s.name));
    const add = notesLib.parseNotes(readText(this.defaults)).filter(s => s.name !== null && !names.has(s.name));
    if (add.length === 0) {
      vscode.window.setStatusBarMessage("IPyDesk: デフォルトのメモはすべてあります", 3000);
      return;
    }
    if (this.view) {
      // 入力途中の内容を消さないよう、webview 側で足す（webview から edit が返る）
      void this.view.webview.postMessage({ type: "addSections", secs: add });
      this.view.show?.(true);
    } else {
      this.addSections(add, false);
      await vscode.commands.executeCommand(`${NotesViewProvider.viewType}.focus`);
    }
    vscode.window.setStatusBarMessage(
      `IPyDesk: デフォルトのメモを ${add.length} 件戻しました（${add.map(s => s.name).join("、")}）`, 4000);
  }

  /** ファイルの末尾にセクションを足して保存する（webview が無いとき用） */
  private addSections(add: Section[], fold: boolean) {
    const cur = notesLib.parseNotes(this.text);
    const merged = (cur.length === 1 && cur[0].name === null && !cur[0].body) ? add : [...cur, ...add];
    this.text = notesLib.serializeNotes(merged);
    this.write(this.text);
    if (fold) {
      const k = sectionKeys(merged);
      const folded = new Set(this.state.get<string[]>(FOLDED_KEY, []));
      merged.forEach((s, i) => { if (add.includes(s)) { folded.add(k[i]); } });
      void this.state.update(FOLDED_KEY, [...folded]);
    }
    this.post();
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = html(view.webview.cspSource);
    view.webview.onDidReceiveMessage(m => {
      if (m?.type === "ready") { this.post(); }
      if (m?.type === "edit" && typeof m.text === "string") {
        this.text = m.text;
        this.scheduleSave();
      }
      if (m?.type === "fold" && Array.isArray(m.keys)) {
        void this.state.update(FOLDED_KEY, m.keys.filter((k: unknown) => typeof k === "string"));
      }
      if (m?.type === "copy" && typeof m.text === "string") {
        void vscode.env.clipboard.writeText(m.text).then(() =>
          vscode.window.setStatusBarMessage(
            `IPyDesk: 「${m.name || "名前なし"}」をコピーしました`, 2500));
      }
    });
    view.onDidDispose(() => { this.view = undefined; });
  }

  /** notes.md をエディタで開く（未保存の入力を先に書き出す） */
  async openFile() {
    this.flush();
    if (!fs.existsSync(this.file)) { this.write(""); }
    await vscode.window.showTextDocument(vscode.Uri.file(this.file), { preview: false });
  }

  /** エディタの選択範囲（無ければ現在行）をメモに追記する */
  async addSelection() {
    const ed = vscode.window.activeTextEditor;
    if (!ed) {
      vscode.window.setStatusBarMessage("IPyDesk: 追記するエディタがありません", 3000);
      return;
    }
    const doc = ed.document;
    const parts: string[] = [];
    for (const sel of ed.selections) {
      const range = sel.isEmpty ? doc.lineAt(sel.active.line).range : sel;
      const body = doc.getText(range).replace(/\s+$/, "");
      if (!body) { continue; }
      const a = range.start.line + 1;
      const b = (sel.isEmpty || range.end.character > 0 ? range.end.line : range.end.line - 1) + 1;
      const where = path.basename(doc.fileName) + ":" + (a === b ? `${a}` : `${a}-${b}`);
      const lang = doc.languageId === "plaintext" ? "" : doc.languageId;
      parts.push(`<!-- ${stamp()}  ${where} -->\n\`\`\`${lang}\n${body}\n\`\`\``);
    }
    if (parts.length === 0) { return; }
    const chunk = parts.join("\n\n");
    if (this.view) {
      // 入力途中の内容を消さないよう、追記は webview 側で行う（webview から edit が返る）
      void this.view.webview.postMessage({ type: "append", chunk });
      this.view.show?.(true);
    } else {
      // ビューが無いときはファイルの末尾（＝最後のセクション）に足す
      this.text = joinChunk(this.text, chunk + "\n");
      this.write(this.text);
      await vscode.commands.executeCommand(`${NotesViewProvider.viewType}.focus`);
    }
  }

  dispose() {
    this.flush();
    this.watcher?.close();
    if (this.watchTimer) { clearTimeout(this.watchTimer); }
  }

  // ---- 保存 ----
  private scheduleSave() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); }
    this.saveTimer = setTimeout(() => this.flush(), 300);
  }

  private flush() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = undefined; }
    if (this.text !== this.written) { this.write(this.text); }
  }

  private write(text: string) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      // 上書き（rename しない）にして、ファイル監視が切れないようにする
      fs.writeFileSync(this.file, text, "utf8");
      this.written = text;
    } catch (e) {
      vscode.window.showErrorMessage(`IPyDesk: メモを保存できませんでした — ${String(e)}`);
    }
  }

  // ---- ほかのウィンドウ・エディタでの変更を拾う ----
  private watch() {
    try {
      this.watcher = fs.watch(this.dir, (_ev, name) => {
        if (name && name.toString() !== NOTES_NAME) { return; }
        // 1 回の保存で何度も通知が来るので少し待ってまとめて読む
        if (this.watchTimer) { clearTimeout(this.watchTimer); }
        this.watchTimer = setTimeout(() => this.reload(), 150);
      });
      this.watcher.on("error", () => { /* フォルダが消えた等。保存時に作り直す */ });
    } catch { /* 監視できなくてもメモ自体は使える */ }
  }

  private reload() {
    if (!fs.existsSync(this.file)) { return; }
    const t = readText(this.file);
    if (t === this.written || t === this.text) { this.written = t; return; }
    if (this.saveTimer) { return; }   // こちらで入力中: このあと自分の内容で上書きする
    this.text = t;
    this.written = t;
    this.post();
  }

  private post() {
    void this.view?.webview.postMessage({
      type: "text", text: this.text, folded: this.state.get<string[]>(FOLDED_KEY, []) });
  }
}

function readText(file: string): string {
  try { return fs.readFileSync(file, "utf8"); } catch { return ""; }
}

function joinChunk(text: string, chunk: string): string {
  if (!text) { return chunk; }
  return text + (text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n") + chunk;
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function nonce(): string {
  let s = "";
  const c = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) { s += c.charAt(Math.floor(Math.random() * c.length)); }
  return s;
}

/**
 * webview 内で使うセクションの分割・結合（webview にそのまま埋め込む。テストからも使う）
 *  parseNotes("## A\n\nbody\n\n## B\n") → [{name:"A", body:"body"}, {name:"B", body:""}]
 *  name が null のセクションは、最初の ## より前の部分（見出しなし）
 */
export const SECTION_JS = String.raw`
function trimBlank(s) {
  s = s.replace(/^(?:[ \t]*\n)+/, "").replace(/(?:\n[ \t]*)+$/, "");
  return /^[ \t]*$/.test(s) ? "" : s;
}
function parseNotes(t) {
  const lines = t.replace(/\r\n/g, "\n").split("\n");
  const raw = [];
  let cur = { name: null, lines: [] };
  let fence = null;
  for (const ln of lines) {
    const f = /^\s*(` + "```" + String.raw`|~~~)/.exec(ln);
    if (f) { fence = fence === null ? f[1] : (fence === f[1] ? null : fence); cur.lines.push(ln); continue; }
    const m = fence === null ? /^##(?:[ \t]+(.*?))?[ \t]*$/.exec(ln) : null;
    if (m) { raw.push(cur); cur = { name: m[1] || "", lines: [] }; continue; }
    cur.lines.push(ln);
  }
  raw.push(cur);
  const out = raw.map(s => ({ name: s.name, body: trimBlank(s.lines.join("\n")) }));
  if (out.length > 1 && out[0].name === null && out[0].body === "") { out.shift(); }
  return out;
}
function serializeNotes(secs) {
  const parts = [];
  for (const s of secs) {
    if (s.name === null) { if (s.body) { parts.push(s.body); } continue; }
    parts.push("## " + s.name + (s.body ? "\n\n" + s.body : ""));
  }
  return parts.length ? parts.join("\n\n") + "\n" : "";
}
/** 折りたたみ状態のキー: 名前 + 同名の何番目か（並べ替え・名前の変更をしても、なるべく同じセクションを指す） */
function sectionKeys(secs) {
  const seen = {};
  return secs.map(s => {
    const nm = s.name === null ? "\u0000" : s.name;
    seen[nm] = (seen[nm] || 0) + 1;
    return nm + "\u0001" + seen[nm];
  });
}
`;

/** 拡張側でも同じ関数を使う（webview と分割・結合の規則がずれないように） */
const notesLib = new Function(SECTION_JS + "return { parseNotes, serializeNotes, sectionKeys };")() as {
  parseNotes(t: string): Section[];
  serializeNotes(s: Section[]): string;
  sectionKeys(s: Section[]): string[];
};
const sectionKeys = notesLib.sectionKeys;

function html(cspSource: string): string {
  const n = nonce();
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${n}';">
<style>
  body { padding: 0 0 12px; margin: 0; color: var(--vscode-foreground);
         font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
  .tb { display: flex; gap: 4px; padding: 4px 8px; align-items: center; position: sticky; top: 0; z-index: 1;
        background: var(--vscode-sideBar-background); }
  .tb button { padding: 2px 8px; border: none; border-radius: 2px; cursor: pointer; font: inherit;
        color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  .tb button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .tb .st { margin-left: auto; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .sec { border-top: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, #8884)); }
  .hd { display: flex; align-items: center; gap: 2px; padding: 2px 4px 2px 2px; min-height: 22px; }
  .hd:hover { background: var(--vscode-list-hoverBackground); }
  .gr { width: 12px; flex: none; text-align: center; cursor: grab; user-select: none;
        font-size: 10px; letter-spacing: -2px; opacity: 0; color: var(--vscode-descriptionForeground); }
  .hd:hover .gr { opacity: .8; }
  .sec.dragging { opacity: .45; }
  .sec.drop-before { box-shadow: inset 0 2px 0 var(--vscode-focusBorder); }
  .sec.drop-after  { box-shadow: inset 0 -2px 0 var(--vscode-focusBorder); }
  .tw { width: 14px; flex: none; text-align: center; cursor: pointer; user-select: none; opacity: .8; }
  .nm { flex: 0 1 auto; min-width: 40px; max-width: 100%; padding: 1px 4px; border-radius: 2px; font: inherit;
        font-weight: 600; color: inherit; background: transparent; border: 1px solid transparent; }
  .nm:hover { border-color: var(--vscode-input-border, #8886); }
  .nm:focus { outline: none; border-color: var(--vscode-focusBorder);
        background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
  .nm::placeholder { color: var(--vscode-descriptionForeground); font-weight: normal; font-style: italic; }
  .pv { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; cursor: pointer;
        font-size: 11px; color: var(--vscode-descriptionForeground); padding-left: 4px; }
  .ic { flex: none; width: 22px; height: 20px; padding: 0; border: none; border-radius: 3px; cursor: pointer;
        background: transparent; color: var(--vscode-icon-foreground, inherit); opacity: .55; font-size: 12px; }
  .hd:hover .ic { opacity: .9; }
  .ic:hover { background: var(--vscode-toolbar-hoverBackground, #8883); opacity: 1; }
  .ic.armed { opacity: 1; color: var(--vscode-errorForeground); }
  .ic.done { opacity: 1; color: var(--vscode-charts-green); }
  textarea { display: block; width: calc(100% - 16px); margin: 0 8px 6px; padding: 5px 8px; resize: none;
        box-sizing: border-box; border-radius: 2px; tab-size: 4; overflow: hidden; min-height: 2.8em;
        color: var(--vscode-input-foreground); background: var(--vscode-input-background);
        border: 1px solid var(--vscode-input-border, transparent);
        font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size);
        line-height: 1.45; }
  textarea:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  textarea::placeholder { color: var(--vscode-input-placeholderForeground); }
  .sec.folded textarea { display: none; }
  .sec:not(.folded) .pv { visibility: hidden; }
  .help { padding: 8px 12px; font-size: 11px; line-height: 1.6; color: var(--vscode-descriptionForeground); }
</style></head><body>
<div class="tb">
  <button id="add" title="末尾に新しいセクションを追加">＋ セクション</button>
  <button id="foldAll" title="すべて折りたたむ / すべて展開">⇕</button>
  <span id="st" class="st"></span>
</div>
<div id="secs"></div>
<div class="help">自動で保存され、どのフォルダを開いても同じメモが出ます。<br>
⋮⋮ をドラッグ（または Alt+↑ / Alt+↓）でセクションを並べ替えられます。<br>
エディタで選択して右クリック →「IPyDesk: Add Selection to Notes」で、最後に書いたセクションへ追記できます。</div>
<script nonce="${n}">
${SECTION_JS}
const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);
let secs = [{ name: null, body: "", folded: false }];
let timer = null;
let lastFocus = -1;

let dragFrom = -1;
const keys = () => sectionKeys(secs);
function sendFold() {
  const k = keys();
  vscode.postMessage({ type: "fold", keys: k.filter((_, i) => secs[i].folded) });
}

// ---- 保存 ----
function send() {
  if (timer) { clearTimeout(timer); timer = null; }
  vscode.postMessage({ type: "edit", text: serializeNotes(secs) });
  $("st").textContent = "保存済み";
}
function edited(now) {
  $("st").textContent = "入力中…";
  if (timer) { clearTimeout(timer); }
  timer = setTimeout(send, now ? 0 : 400);
}

// ---- 表示 ----
const esc = s => String(s ?? "").replace(/[&<>"]/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
// 折りたたみ時の 1 行プレビュー（コードブロックの区切り・HTML コメントは飛ばす）
const preview = b => {
  const l = b.split("\\n").map(x => x.trim()).find(x => x && !/^(\`\`\`|~~~|<!--)/.test(x));
  return l || "";
};
// 名前の欄の幅を中身に合わせる（全角は 1em、半角は約 0.6em）
const nameWidth = s => {
  let w = 0;
  for (const c of String(s || "名前なし")) { w += c.charCodeAt(0) > 0xff ? 1 : 0.6; }
  return "calc(" + Math.max(3, w).toFixed(1) + "em + 12px)";
};
function fit(ta) { ta.style.height = "auto"; ta.style.height = (ta.scrollHeight + 2) + "px"; }
const fitAll = () => document.querySelectorAll("textarea").forEach(fit);
const secEl = i => document.querySelector('.sec[data-i="' + i + '"]');

function render() {
  // 再描画してもフォーカスとカーソル位置を保つ
  const ae = document.activeElement;
  const sec = ae && ae.closest ? ae.closest(".sec") : null;
  const keep = sec ? { i: +sec.dataset.i, cls: ae.classList[0], a: ae.selectionStart, b: ae.selectionEnd } : null;
  let h = "";
  secs.forEach((s, i) => {
    h += '<div class="sec' + (s.folded ? " folded" : "") + '" data-i="' + i + '">'
      + '<div class="hd">'
      + '<span class="gr" draggable="true" title="ドラッグで並べ替え（Alt+↑ / Alt+↓ でも移動）">⋮⋮</span>'
      + '<span class="tw" title="折りたたむ / 展開">' + (s.folded ? "▸" : "▾") + "</span>"
      + '<input class="nm" spellcheck="false" style="width:' + nameWidth(s.name) + '" value="' + esc(s.name ?? "")
      + '" placeholder="名前なし" title="クリックして名前を変更">'
      + '<span class="pv" title="クリックで展開">' + esc(preview(s.body)) + "</span>"
      + '<button class="ic cp" title="本文をコピー（Shift+クリックで見出しも含める）">⧉</button>'
      + '<button class="ic del" title="セクションを削除">✕</button>'
      + "</div>"
      + '<textarea class="bd" spellcheck="false" placeholder="メモ…">' + esc(s.body) + "</textarea>"
      + "</div>";
  });
  $("secs").innerHTML = h;
  fitAll();
  if (keep && secs[keep.i]) {
    const el = secEl(keep.i)?.querySelector("." + keep.cls);
    if (el && el.offsetParent !== null) {
      el.focus();
      try { el.setSelectionRange(keep.a, keep.b); } catch (e) { /* noop */ }
    }
  }
}

const idx = el => { const s = el.closest(".sec"); return s ? +s.dataset.i : -1; };
function toggle(i) { secs[i].folded = !secs[i].folded; render(); sendFold(); }

/** セクションを from から to の位置へ動かす */
function move(from, to, focusCls) {
  if (to < 0 || to >= secs.length || from === to) { return; }
  const [s] = secs.splice(from, 1);
  secs.splice(to, 0, s);
  // 見出しなしのセクションが 2 番目以降に来たら、前のセクションに混ざらないよう空の見出しを付ける
  secs.forEach((x, i) => { if (i > 0 && x.name === null) { x.name = ""; } });
  if (lastFocus === from) { lastFocus = to; }
  else if (lastFocus > from && lastFocus <= to) { lastFocus--; }
  else if (lastFocus < from && lastFocus >= to) { lastFocus++; }
  render();
  if (focusCls) {
    const el = secEl(to).querySelector("." + focusCls);
    if (el && el.offsetParent !== null) { el.focus(); }
  }
  secEl(to).scrollIntoView({ block: "nearest" });
  sendFold(); edited(true);
}

// ---- ドラッグで並べ替え（⋮⋮ をつかむ）----
function clearDrop() {
  document.querySelectorAll(".drop-before, .drop-after, .dragging")
    .forEach(el => el.classList.remove("drop-before", "drop-after", "dragging"));
}
$("secs").addEventListener("dragstart", e => {
  if (!e.target.classList || !e.target.classList.contains("gr")) { return; }
  dragFrom = idx(e.target);
  const sec = secEl(dragFrom);
  sec.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", "");
  e.dataTransfer.setDragImage(sec.querySelector(".hd"), 12, 10);
});
$("secs").addEventListener("dragover", e => {
  if (dragFrom < 0) { return; }
  const sec = e.target.closest(".sec");
  if (!sec) { return; }
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  const r = sec.getBoundingClientRect();
  const after = e.clientY > r.top + Math.min(r.height / 2, 30);
  document.querySelectorAll(".drop-before, .drop-after")
    .forEach(el => { if (el !== sec) { el.classList.remove("drop-before", "drop-after"); } });
  sec.classList.toggle("drop-after", after);
  sec.classList.toggle("drop-before", !after);
});
$("secs").addEventListener("drop", e => {
  if (dragFrom < 0) { return; }
  e.preventDefault();
  const sec = e.target.closest(".sec");
  const from = dragFrom;
  dragFrom = -1;
  if (!sec) { clearDrop(); return; }
  let to = +sec.dataset.i + (sec.classList.contains("drop-after") ? 1 : 0);
  if (from < to) { to--; }
  clearDrop();
  move(from, to);
});
$("secs").addEventListener("dragend", () => { dragFrom = -1; clearDrop(); });

// ---- 操作 ----
$("secs").addEventListener("input", e => {
  const t = e.target, i = idx(t);
  if (i < 0) { return; }
  if (t.classList.contains("bd")) {
    secs[i].body = t.value;
    lastFocus = i;
    fit(t);
    secEl(i).querySelector(".pv").textContent = preview(t.value);
  } else if (t.classList.contains("nm")) {
    const v = t.value.replace(/[\\r\\n]+/g, " ");
    t.style.width = nameWidth(v);
    // 見出しなしのセクションは、名前を入れたときに見出しを付ける（空に戻したら見出しなしに戻す）
    const headless = secs[i].name === null || (i === 0 && secs[i].wasHeadless);
    if (secs[i].name === null) { secs[i].wasHeadless = true; }
    secs[i].name = (v === "" && headless) ? null : v;
    if (secs[i].folded) { sendFold(); }
  }
  edited();
});
$("secs").addEventListener("focusin", e => {
  if (e.target.classList.contains("bd")) { lastFocus = idx(e.target); }
});
$("secs").addEventListener("focusout", () => { if (timer) { send(); } });
$("secs").addEventListener("keydown", e => {
  const t = e.target;
  // Alt+↑ / Alt+↓ でセクションを上下に移動
  if (e.altKey && !e.ctrlKey && !e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    e.preventDefault();
    const i = idx(t);
    if (i >= 0) { move(i, i + (e.key === "ArrowUp" ? -1 : 1), t.classList[0]); }
    return;
  }
  // 名前で Enter → 本文へ
  if (t.classList.contains("nm") && e.key === "Enter") {
    e.preventDefault();
    const i = idx(t);
    if (secs[i].folded) { toggle(i); }
    secEl(i).querySelector("textarea").focus();
  }
  // 本文の Tab は字下げ（Shift+Tab は通常どおりフォーカス移動）
  if (t.classList.contains("bd") && e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    if (!document.execCommand("insertText", false, "    ")) {
      t.setRangeText("    ", t.selectionStart, t.selectionEnd, "end");
      t.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }
});
$("secs").addEventListener("click", e => {
  const t = e.target, i = idx(t);
  if (i < 0) { return; }
  if (t.classList.contains("tw") || t.classList.contains("pv")) { toggle(i); return; }
  if (t.classList.contains("cp")) {
    const s = secs[i];
    const text = e.shiftKey && s.name !== null ? "## " + s.name + (s.body ? "\\n\\n" + s.body : "") : s.body;
    vscode.postMessage({ type: "copy", text, name: s.name });
    t.classList.add("done"); t.textContent = "✓";
    setTimeout(() => { t.classList.remove("done"); t.textContent = "⧉"; }, 1200);
    return;
  }
  if (t.classList.contains("del")) {
    // 本文があるときは 2 回クリックで削除（webview では確認ダイアログを出せない）
    if (secs[i].body.trim() && !t.classList.contains("armed")) {
      t.classList.add("armed"); t.textContent = "?"; t.title = "もう一度クリックで削除";
      setTimeout(() => { t.classList.remove("armed"); t.textContent = "✕"; t.title = "セクションを削除"; }, 2500);
      return;
    }
    secs.splice(i, 1);
    if (secs.length === 0) { secs.push({ name: null, body: "", folded: false }); }
    if (lastFocus === i) { lastFocus = -1; } else if (lastFocus > i) { lastFocus--; }
    render(); sendFold(); edited(true);
  }
});
$("secs").addEventListener("dblclick", e => {
  if (e.target.classList.contains("hd")) { toggle(idx(e.target)); }
});
$("add").addEventListener("click", () => {
  // 空の「名前なし」だけのときは、それを置き換える
  if (secs.length === 1 && secs[0].name === null && !secs[0].body) { secs = []; }
  secs.push({ name: "セクション " + (secs.filter(s => s.name !== null).length + 1), body: "", folded: false });
  render();
  const nm = secEl(secs.length - 1).querySelector(".nm");
  nm.scrollIntoView({ block: "nearest" }); nm.focus(); nm.select();
  edited(true);
});
$("foldAll").addEventListener("click", () => {
  const fold = secs.some(s => !s.folded);
  secs.forEach(s => { s.folded = fold; });
  render(); sendFold();
});
window.addEventListener("resize", fitAll);

window.addEventListener("message", e => {
  const m = e.data;
  if (!m) { return; }
  if (m.type === "text") {
    if (timer) { return; }          // 入力中はこちらを優先（このあと保存で上書きする）
    const folded = new Set(m.folded || []);
    secs = parseNotes(m.text).map(s => ({ name: s.name, body: s.body, folded: false }));
    keys().forEach((k, i) => { secs[i].folded = folded.has(k); });
    if (lastFocus >= secs.length) { lastFocus = -1; }
    render();
  }
  if (m.type === "addSections" && Array.isArray(m.secs)) {
    if (secs.length === 1 && secs[0].name === null && !secs[0].body) { secs = []; }
    const first = secs.length;
    for (const s of m.secs) { secs.push({ name: s.name, body: s.body, folded: true }); }
    render(); sendFold(); edited(true);
    secEl(first)?.scrollIntoView({ block: "start" });
  }
  if (m.type === "append") {
    const i = lastFocus >= 0 && lastFocus < secs.length ? lastFocus : secs.length - 1;
    const s = secs[i];
    s.body = s.body ? s.body.replace(/\\s+$/, "") + "\\n\\n" + m.chunk : m.chunk;
    if (s.folded) { s.folded = false; sendFold(); }
    render();
    const ta = secEl(i).querySelector("textarea");
    ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.scrollIntoView({ block: "end" });
    edited(true);
  }
});
render();
vscode.postMessage({ type: "ready" });
</script></body></html>`;
}
