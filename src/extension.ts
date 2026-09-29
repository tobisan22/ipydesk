/**
 * IPyDesk — MATLAB ライクな Python 実行環境
 *
 *  - エディタの赤丸を .vscode/py_breakpoints.json に書き出す（Python 側が読む）
 *  - F5 で IPython セッションを起動 / 2回目以降は同セッションへ %ipydesk を送る
 *  - # %% で区切ったセル / 選択範囲 / 現在行を、同セッションへ %ipydesk_cell で送る
 *  - Python 側が書く .vscode/py_debug_state.json を監視して停止行をハイライト
 *  - 停止中は F5/F10/F11 などを pdb コマンドとしてターミナルへ送る
 *  - Python 側が書く .vscode/py_figures.json を監視して figure ごとにタブを開く
 *    （描き直した図の前の姿は、同じタブの上側に履歴として積み上がる）
 *  - Figure タブの 📋 で、その figure の PNG を Windows のクリップボードへ入れる
 *  - Python 側が書く .vscode/py_workspace.json を監視してワークスペースビューに変数を出す
 *  - Variable Editor: 配列・表を表形式で開き、選択範囲をプロットする（py_varreq_* で問い合わせ）
 *  - Open Desk: コード・図・変数・コンソールを MATLAB 風の配置に並べる
 *
 * 複数セッション:
 *  - セッションごとに専用ターミナル（IPyDesk, IPyDesk 2, …）と通知ディレクトリ
 *    .vscode/py_sessions/<番号>/ を持つ。赤丸 JSON だけは .vscode/ 直下を共有する
 *  - F5 / セル実行は「アクティブなセッション」へ送る。そこがコード実行中なら、
 *    空いている別セッション、それも無ければ新しいセッションで実行する
 *  - ターミナルを切り替えると、そのセッションがアクティブになる（ワークスペースビューも追従）
 *
 * エラー時の停止:
 *  - F5 / セル実行はエラーで止まらない（トレースバックだけ出す）。Python がエラーを
 *    py_session.json で知らせてくるので、ステータスバーに ⚠ を出し、押すと %ipydesk_pm で
 *    その行に入る（IPyDesk: Debug Last Error）
 *  - Alt+F5（IPyDesk: Run (Stop on Error)）は、その場でエラーの行に止まる（--pm）
 */
import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as http from "http";
import { execFile } from "child_process";
import { WORKSPACE_NAME, WorkspaceViewProvider, WsData } from "./workspaceView";
import { VariableEditor, VarQuery } from "./variableEditor";
import { FigureInfo, figureHtml } from "./figurePanel";

const BP_NAME = "py_breakpoints.json";
const STATE_NAME = "py_debug_state.json";
const SESSION_NAME = "py_session.json";
const FIGURES_NAME = "py_figures.json";
const SAVE_REQUEST_NAME = "py_save_request.json";   // Python → 拡張 : 保存ダイアログ要求
const SESSIONS_DIR = "py_sessions";                 // .vscode/py_sessions/<番号>/ にセッション別の通知
const FIG_CLOSE_PREFIX = "py_figclose_";            // 拡張 → Python : 利用者が閉じた Figure タブ
const VAR_REQ_PREFIX = "py_varreq_";                // 拡張 → Python : Variable Editor の問い合わせ
const VAR_RES_PREFIX = "py_varres_";                // Python → 拡張 : その答え
const VAR_TIMEOUT_MS = 5000;

// ipydesk 本体は同梱するが、これらは利用者の Python に入っている必要がある
const REQUIRED_MODULES = [
  { mod: "IPython", pip: "ipython" },
  { mod: "ipdb", pip: "ipdb" },
  { mod: "matplotlib", pip: "matplotlib" },
  { mod: "tornado", pip: "tornado" },
];

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function vscodeDir(): string | undefined {
  const root = workspaceRoot();
  return root ? path.join(root, ".vscode") : undefined;
}

function removeQuiet(p: string) {
  try { fs.unlinkSync(p); } catch { /* ignore */ }
}

// ---- 拡張の動作ログ（不具合報告用。セッション起動のたびに書き直される） ------------
const EXT_LOG_NAME = "py_ext_log.txt";

function extLogPath(): string | undefined {
  const dir = vscodeDir();
  return dir ? path.join(dir, EXT_LOG_NAME) : undefined;
}

function extLog(msg: string) {
  const p = extLogPath();
  if (!p) { return; }
  const d = new Date();
  const t = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
    + `:${String(d.getSeconds()).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`;
  try { fs.appendFileSync(p, `${t}  ${msg}\n`, "utf8"); } catch { /* ignore */ }
}

// ---- figure 画像のクリップボードコピー ---------------------------------------
/** webagg から画像を取得する（拡張ホストは Node なので CORS の制約を受けない） */
function fetchUrl(url: string, timeoutMs = 5000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} (${url})`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () =>
      req.destroy(new Error(`webagg (${url}) への接続がタイムアウトしました`)));
  });
}

// VS Code の clipboard API はテキスト専用なので、画像は PowerShell 経由で入れる。
//  -STA        : クリップボード API は STA スレッドを要求する
//  環境変数渡し : 日本語やスペースを含むパスのクォート崩れを避ける
const CLIP_PS =
  "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; " +
  "$i=[System.Drawing.Image]::FromFile($env:IPYDESK_CLIP_PNG); " +
  "[System.Windows.Forms.Clipboard]::SetImage($i); $i.Dispose()";

function setClipboardImage(pngPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-STA", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", CLIP_PS],
      { env: { ...process.env, IPYDESK_CLIP_PNG: pngPath }, windowsHide: true },
      (err, _stdout, stderr) => {
        if (err) { reject(new Error(stderr?.trim() || err.message)); } else { resolve(); }
      },
    );
  });
}

// ---- 赤丸の書き出し ----------------------------------------------------------
function dumpBreakpoints() {
  const dir = vscodeDir();
  if (!dir) { return; }
  const bps = vscode.debug.breakpoints
    .filter((b): b is vscode.SourceBreakpoint => b instanceof vscode.SourceBreakpoint)
    .filter(b => b.location.uri.fsPath.endsWith(".py"))
    .map(b => ({
      file: b.location.uri.fsPath,
      line: b.location.range.start.line + 1,   // 0-based → 1-based
      enabled: b.enabled,
      condition: b.condition ?? null,
    }));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, BP_NAME), JSON.stringify(bps, null, 2), "utf8");
}

// ---- セル（`# %%` / `#%%` 区切り）---------------------------------------------
// MATLAB の %% セクションにあたるもの。Jupyter / VS Code の慣習に合わせて
// コメント形式の `# %%` を区切りとして扱う。
const CELL_RE = /^\s*#\s*%%/;

// 区切りの走査はカーソル移動のたびに走るので、版ごとに結果を覚えておく
const markerCache = new WeakMap<vscode.TextDocument, { version: number; marks: number[] }>();

/** セル区切り行（0 始まり）の一覧 */
function cellMarkers(doc: vscode.TextDocument): number[] {
  const hit = markerCache.get(doc);
  if (hit && hit.version === doc.version) { return hit.marks; }
  const marks: number[] = [];
  for (let i = 0; i < doc.lineCount; i++) {
    if (CELL_RE.test(doc.lineAt(i).text)) { marks.push(i); }
  }
  markerCache.set(doc, { version: doc.version, marks });
  return marks;
}

/**
 * line（0 始まり）を含むセルの範囲を、1 始まり・両端含みで返す。
 * 区切りが 1 つも無ければファイル全体が 1 セル。
 */
function cellAt(doc: vscode.TextDocument, line: number): { start: number; end: number } {
  const marks = cellMarkers(doc);
  let start = 0;
  for (const m of marks) {
    if (m > line) { break; }
    start = m;
  }
  const next = marks.find(m => m > line);
  return { start: start + 1, end: (next === undefined ? doc.lineCount - 1 : next - 1) + 1 };
}

export function activate(context: vscode.ExtensionContext) {
  // ---- 状態 ----
  type Stop = { file: string; line: number };
  interface Session {
    id: number;                                    // 1, 2, 3, …（空いている最小の番号）
    name: string;                                  // ターミナル名 "IPyDesk" / "IPyDesk 2"
    dir: string;                                   // .vscode/py_sessions/<id>
    terminal: vscode.Terminal;
    stopped?: Stop;                                // ブレークポイントで停止中の位置
    figures: Map<number, vscode.WebviewPanel>;     // figure 番号 → タブ
    figInfo?: FigureInfo;                          // 最後に読んだ py_figures.json
    histCut: Map<number, number>;                  // 「履歴を消す」を押した時点の seq（これ以前は出さない）
    figIds: Map<number, string>;                   // タブが繋がっている figure の実体（py_figures.json の ids）
    closedIds: Set<string>;                        // タブを閉じた figure の実体（Python が閉じるまで開き直さない）
    ws: WsData | null;                             // 最後に受け取った変数一覧
    error?: ErrInfo;                               // 直前の実行のエラー（次の実行で消える）
    lastUsed: number;
  }
  type ErrInfo = { type: string; where: string | null };
  const sessions = new Map<number, Session>();
  let activeId: number | undefined;
  let activeFigure: { sid: number; num: number } | undefined;   // 最後にフォーカスされた figure

  const active = (): Session | undefined =>
    activeId === undefined ? undefined : sessions.get(activeId);
  const byTerminal = (t: vscode.Terminal | undefined) =>
    t ? [...sessions.values()].find(s => s.terminal === t) : undefined;
  /** 通知ファイルの URI から、それを書いたセッションを引く */
  const byUri = (uri: vscode.Uri) => {
    const dir = path.dirname(uri.fsPath).toLowerCase();
    return [...sessions.values()].find(s => s.dir.toLowerCase() === dir);
  };
  /** 直前のエラーに入れるセッション。アクティブなものを優先し、無ければ直近に使ったもの */
  const errorSession = (): Session | undefined => {
    const a = active();
    if (a?.error) { return a; }
    return [...sessions.values()].filter(s => s.error)
      .sort((x, y) => y.lastUsed - x.lastUsed)[0];
  };

  // ---- ワークスペースビュー ----
  const workspaceView = new WorkspaceViewProvider();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(WorkspaceViewProvider.viewType, workspaceView));

  const config = () => vscode.workspace.getConfiguration("ipydesk");

  // ---- 図の表示先 ----
  //  tab    : webagg + figure ごとに VS Code のタブを自動で開く（既定）
  //  manual : webagg だがタブは自動で開かない（📈 で開く）
  //  window : Qt / Tk の別ウィンドウ。webagg サーバーは起動しない
  //  none   : 表示しない（Agg）。webagg サーバーもポートも使わない
  type FigureDisplay = "tab" | "manual" | "window" | "none";

  /** ユーザーが明示的に設定した値だけを拾う（既定値は無視する） */
  const explicitly = <T>(key: string): T | undefined => {
    const i = config().inspect<T>(key);
    return i?.workspaceFolderValue ?? i?.workspaceValue ?? i?.globalValue;
  };

  const figureDisplay = (): FigureDisplay => {
    const v = explicitly<FigureDisplay>("figureDisplay");
    if (v) { return v; }
    // 旧 ipydesk.autoOpenFigures: false との下位互換
    if (explicitly<boolean>("autoOpenFigures") === false) { return "manual"; }
    return config().get<FigureDisplay>("figureDisplay", "tab");
  };

  /** タブに出るモードか（webagg を使うか） */
  const figuresInTabs = () => {
    const d = figureDisplay();
    return d === "tab" || d === "manual";
  };

  // タブに出ないモードでは Figure タブ関連の UI を隠す。
  // 未設定＝false として評価されるよう、否定形のキーにしてある。
  const updateFigureTabsContext = () =>
    vscode.commands.executeCommand(
      "setContext", "ipydesk.noFigureTabs", !figuresInTabs());

  const setStopped = (v: boolean) =>
    vscode.commands.executeCommand("setContext", "ipydesk.stopped", v);

  // ---- ステータスバー ----
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  // 直前の実行がエラーで終わったセッションがあれば、そこへ入るボタンを出す
  const errStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  errStatus.command = "ipydesk.debugLastError";
  errStatus.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
  context.subscriptions.push(status, errStatus);

  const updateStatus = () => {
    const a = active();
    const n = sessions.size;
    if (a?.stopped) {
      status.text = `$(debug-pause) ${a.name}: ${path.basename(a.stopped.file)}:${a.stopped.line}`;
      status.tooltip = "ブレークポイントで停止中（クリックで続行）";
      status.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      status.command = "ipydesk.continue";
      status.show();
    } else if (a) {
      status.text = n > 1 ? `$(terminal) ${a.name}（${n} セッション）` : "$(terminal) IPyDesk session";
      status.tooltip = "IPython セッション稼働中（クリックでセッションを切り替え）";
      status.backgroundColor = undefined;
      status.command = "ipydesk.selectSession";
      status.show();
    } else {
      status.hide();
    }
    const e = errorSession();
    if (e && !e.stopped) {
      const where = e.error!.where ? ` (${e.error!.where})` : "";
      errStatus.text = `$(warning) ${e.error!.type}${where}`;
      errStatus.tooltip = `${sessions.size > 1 ? e.name + ": " : ""}`
        + "エラーで終了しました。クリックでエラーの行に入ります（IPyDesk: Debug Last Error）";
      errStatus.show();
    } else {
      errStatus.hide();
    }
  };

  // ---- 停止行ハイライト ----
  const decoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("editor.stackFrameHighlightBackground"),
    overviewRulerColor: new vscode.ThemeColor("editor.stackFrameHighlightBackground"),
    overviewRulerLane: vscode.OverviewRulerLane.Full,
  });
  context.subscriptions.push(decoration);

  // 停止中のセッションが複数あれば、その全部の停止行をハイライトする
  const applyHighlight = () => {
    const stops = [...sessions.values()].map(s => s.stopped).filter((x): x is Stop => !!x);
    for (const ed of vscode.window.visibleTextEditors) {
      const f = ed.document.uri.fsPath.toLowerCase();
      ed.setDecorations(decoration, stops
        .filter(st => st.file.toLowerCase() === f)
        .map(st => new vscode.Range(st.line - 1, 0, st.line - 1, 0)));
    }
  };

  /** アクティブセッションが変わった・状態が変わったときに、表示をまとめて揃える */
  const refresh = () => {
    const a = active();
    setStopped(!!a?.stopped);
    workspaceView.update(a?.ws ?? null, a && sessions.size > 1 ? a.name : undefined);
    applyHighlight();
    updateStatus();
  };

  const setActive = (s: Session) => {
    s.lastUsed = Date.now();
    if (activeId === s.id) { return; }
    activeId = s.id;
    refresh();
  };

  // ---- セルの見た目 ----
  // 区切り線は MATLAB のセクション線にあたる。現在セルの強調はカーソル位置に追従する。
  const cellSeparator = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderWidth: "1px 0 0 0",
    borderStyle: "solid",
    borderColor: new vscode.ThemeColor("panel.border"),
  });
  const cellHighlight = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("editor.rangeHighlightBackground"),
  });
  context.subscriptions.push(cellSeparator, cellHighlight);

  const applyCellDecorations = () => {
    const show = config().get<boolean>("showCellDecorations", true);
    for (const ed of vscode.window.visibleTextEditors) {
      const marks = show && ed.document.languageId === "python"
        ? cellMarkers(ed.document) : [];
      // 1 行目の区切りに線を引くと画面の上端と重なるので、そこだけ引かない
      ed.setDecorations(cellSeparator,
        marks.filter(m => m > 0).map(m => new vscode.Range(m, 0, m, 0)));
      // 区切りが無いファイルは「全体が 1 セル」だが、全面を塗っても意味がないので強調しない
      const cell = marks.length > 0
        ? cellAt(ed.document, ed.selection.active.line) : undefined;
      ed.setDecorations(cellHighlight,
        cell ? [new vscode.Range(cell.start - 1, 0, cell.end - 1, 0)] : []);
    }
  };

  // ---- figure タブ ----
  // 拡張が自分で閉じたタブ（plt.close された・セッション終了）。利用者が閉じたタブと区別する
  const closingByExt = new WeakSet<vscode.WebviewPanel>();
  const disposeByExt = (p: vscode.WebviewPanel) => { closingByExt.add(p); p.dispose(); };
  const closeFigurePanels = (s: Session) => {
    for (const p of [...s.figures.values()]) { disposeByExt(p); }
    s.figures.clear();
  };

  /**
   * 利用者が Figure タブを閉じたら、その figure を Python 側でも閉じてもらう（MATLAB と同じ）。
   * 閉じないと figure が残り、次の通知でタブが開き直され、plt.plot もその図へ描き足してしまう。
   * Python は次のコマンドを実行する直前に py_figclose_*.json を読んで plt.close する
   */
  const requestFigureClose = (s: Session, num: number, id: string | undefined) => {
    if (sessions.get(s.id) !== s || !isAlive(s)) { return; }
    if (id) { s.closedIds.add(id); }
    try {
      const req = path.join(s.dir,
        `${FIG_CLOSE_PREFIX}${Date.now().toString(36)}_${num}.json`);
      fs.writeFileSync(req + ".tmp", JSON.stringify({ num, id: id ?? null }), "utf8");
      fs.renameSync(req + ".tmp", req);   // 書きかけを読ませない
      extLog(`FIG   Figure ${num} のタブが閉じられたので close を要求`);
    } catch (e) {
      extLog(`FIG   close 要求の書き出しに失敗: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const allFigurePanels = () =>
    [...sessions.values()].flatMap(s => [...s.figures].map(([num, p]) => ({ s, num, p })));

  // Figure タブが前面にあるかを自前のコンテキストキーで持つ。
  // 組み込みの activeWebviewPanelId は当環境で editor/title に効かなかったため
  // （ipydesk.stopped と同じ、この拡張で実績のある方式に揃える）。
  const updateFigureContext = () => {
    const anyActive = allFigurePanels().some(f => f.p.active);
    vscode.commands.executeCommand("setContext", "ipydesk.figureActive", anyActive);
  };

  // ---- エディタグループの使い分け ----
  // 「コードのグループ」と「Figure のグループ」を分けて扱う。
  //  - 停止行（赤丸・エラー）はコードのグループに出す。Figure 側に同じスクリプトを開かない
  //  - Figure タブは、既に Figure があるグループにまとめて開く
  //  - Figure を開いたせいでアクティブなグループが Figure 側へ移ったら、コード側へ戻す
  // 「図のグループ」には Variable Editor も並べる（どちらも実行結果を見る場所）
  const isFigureTab = (t: vscode.Tab) =>
    t.input instanceof vscode.TabInputWebview
    && (t.input.viewType.includes("ipydeskFigure") || t.input.viewType.includes(VariableEditor.viewType));
  const figureGroups = () =>
    vscode.window.tabGroups.all.filter(g => g.tabs.some(isFigureTab));
  const isFigureColumn = (col: vscode.ViewColumn | undefined) =>
    col !== undefined && figureGroups().some(g => g.viewColumn === col);

  // 最後に使ったコードのエディタ（Figure のグループにあるものは除く）
  let lastCode: { uri: vscode.Uri; column: vscode.ViewColumn } | undefined;
  const trackCodeEditor = (ed: vscode.TextEditor | undefined) => {
    if (!ed || ed.document.uri.scheme !== "file" || ed.viewColumn === undefined) { return; }
    if (isFigureColumn(ed.viewColumn)) { return; }
    lastCode = { uri: ed.document.uri, column: ed.viewColumn };
  };
  trackCodeEditor(vscode.window.activeTextEditor);
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(trackCodeEditor));

  /** 停止行を出すグループ: 最後に使ったコードのグループ → Figure の無いグループ → 1 列目 */
  const codeColumn = (): vscode.ViewColumn => {
    const groups = vscode.window.tabGroups.all;
    if (lastCode && groups.some(g => g.viewColumn === lastCode!.column)
      && !isFigureColumn(lastCode.column)) {
      return lastCode.column;
    }
    return groups.find(g => !g.tabs.some(isFigureTab))?.viewColumn ?? vscode.ViewColumn.One;
  };

  /**
   * 停止行（赤丸・エラー）を見せる。そのファイルがコード側で既に見えていれば、
   * タブは開かずにスクロールするだけ。見えていなければコードのグループに開く
   */
  const revealStop = async (stop: Stop) => {
    const range = new vscode.Range(stop.line - 1, 0, stop.line - 1, 0);
    const f = stop.file.toLowerCase();
    const visible = vscode.window.visibleTextEditors.find(e =>
      e.document.uri.fsPath.toLowerCase() === f && !isFigureColumn(e.viewColumn));
    if (visible) {
      visible.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      return;
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(stop.file));
    const ed = await vscode.window.showTextDocument(doc, {
      viewColumn: codeColumn(), preserveFocus: true, preview: false,
    });
    ed.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  };

  /** Figure タブを開くグループ: 既に Figure があればそこ、無ければコードの隣 */
  const figureColumn = (): vscode.ViewColumn =>
    figureGroups()[0]?.viewColumn ?? vscode.ViewColumn.Beside;

  // Figure を開いた・前に出した直後に Figure 側がアクティブになったら、それは
  // 利用者のクリックではなく自動で移ったもの。コードのエディタへ戻す
  const AUTO_ACTIVATE_MS = 800;
  let figureAutoUntil = 0;
  const markFigureOpened = () => { figureAutoUntil = Date.now() + AUTO_ACTIVATE_MS; };
  const restoreCodeGroup = (panel: vscode.WebviewPanel) => {
    if (Date.now() > figureAutoUntil || !lastCode) { return; }
    const code = lastCode;
    if (panel.viewColumn === code.column) { return; }
    const tabOpen = vscode.window.tabGroups.all.some(g => g.viewColumn === code.column
      && g.tabs.some(t => t.input instanceof vscode.TabInputText
        && t.input.uri.toString() === code.uri.toString()));
    if (!tabOpen) { return; }   // 閉じたファイルを開き直してまで戻さない
    figureAutoUntil = 0;
    void vscode.window.showTextDocument(code.uri, {
      viewColumn: code.column, preserveFocus: false, preview: false,
    });
  };

  /** タブの見出し。plt.figure("名前") の名前と、2 つ目以降のセッションならセッション名を添える */
  const figureTitle = (s: Session, num: number) => {
    const label = s.figInfo?.labels?.[String(num)];
    return `Figure ${num}${label ? `: ${label}` : ""}${s.id === 1 ? "" : ` (${s.name})`}`;
  };

  /** Figure タブへ履歴（描き直す前の姿）を送る */
  const postFigureHistory = (s: Session, num: number) => {
    const panel = s.figures.get(num);
    const info = s.figInfo;
    if (!panel || !info) { return; }
    const cut = s.histCut.get(num) ?? 0;
    const items = (info.history?.[String(num)] ?? []).filter(h => h.seq > cut).map(h => ({
      ...h, src: panel.webview.asWebviewUri(vscode.Uri.file(path.join(s.dir, h.file))).toString(),
    }));
    void panel.webview.postMessage({
      type: "history", items, current: items.length ? info.current?.[String(num)] : undefined,
    });
    const title = figureTitle(s, num);
    if (panel.title !== title) { panel.title = title; }
    // plt.close("all") などで同じ番号の figure が作り直されたら、タブを新しい figure に繋ぎ直す
    const id = info.ids?.[String(num)];
    const prev = s.figIds.get(num);
    if (id && prev && id !== prev) {
      extLog(`FIG   Figure ${num} が作り直されたのでタブを読み直す`);
      void panel.webview.postMessage({ type: "reload" });
    }
    if (id) { s.figIds.set(num, id); }
  };

  const openFigurePanel = (s: Session, base: string, num: number) => {
    markFigureOpened();
    const existing = s.figures.get(num);
    if (existing) { existing.reveal(undefined, true); return; }

    const panel = vscode.window.createWebviewPanel(
      "ipydeskFigure", figureTitle(s, num),
      { viewColumn: figureColumn(), preserveFocus: true },
      {
        enableScripts: true, retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(s.dir)],   // 履歴の PNG
      }
    );
    panel.webview.html = figureHtml(base, num, panel.webview.cspSource);
    panel.webview.onDidReceiveMessage(async m => {
      if (m?.type === "ready") {
        postFigureHistory(s, num);
      } else if (m?.type === "clearHistory") {
        const items = s.figInfo?.history?.[String(num)] ?? [];
        s.histCut.set(num, Math.max(0, ...items.map(h => h.seq)));
        postFigureHistory(s, num);
      } else if (m?.type === "copyImage" && typeof m.file === "string") {
        // 履歴の画像をコピーする。fighist/ の中のファイルだけを受け付ける
        const file = path.resolve(s.dir, m.file);
        if (!file.startsWith(path.join(s.dir, "fighist") + path.sep) || process.platform !== "win32") {
          vscode.window.showWarningMessage("IPyDesk: 画像のクリップボードコピーは Windows のみ対応です");
          return;
        }
        try {
          await setClipboardImage(file);
          vscode.window.setStatusBarMessage("IPyDesk: 履歴の図をコピーしました", 2000);
        } catch (e) {
          vscode.window.showErrorMessage(
            `IPyDesk: コピーに失敗しました — ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    });

    // 背面タブが空白になる問題は Python 側（ipydesk.webagg）で対処している。
    // ブラウザは canvas のリサイズで中身を捨てるため、resize には必ずフル画像を返す。
    panel.onDidChangeViewState(e => {
      if (e.webviewPanel.active) {
        activeFigure = { sid: s.id, num };
        restoreCodeGroup(e.webviewPanel);
      }
      updateFigureContext();
    });
    const id0 = s.figInfo?.ids?.[String(num)];
    if (id0) { s.figIds.set(num, id0); }   // 開いた時点の figure に繋がっている
    panel.onDidDispose(() => {
      if (!closingByExt.has(panel) && s.figures.get(num) === panel) {
        requestFigureClose(s, num, s.figIds.get(num) ?? s.figInfo?.ids?.[String(num)]);
        s.histCut.delete(num);
      }
      if (s.figures.get(num) === panel) { s.figures.delete(num); s.figIds.delete(num); }
      if (activeFigure?.sid === s.id && activeFigure.num === num) { activeFigure = undefined; }
      updateFigureContext();
    });
    s.figures.set(num, panel);
  };

  const readFigures = (s: Session | undefined): FigureInfo | undefined => {
    if (!s) { return undefined; }
    try {
      const info = JSON.parse(fs.readFileSync(path.join(s.dir, FIGURES_NAME), "utf8")) as FigureInfo;
      s.figInfo = info;
      return info;
    } catch {
      return undefined;
    }
  };

  /** セッションが webagg に使うポート（埋まっていれば Python 側が別のポートにずらす） */
  const portOf = (s: Session | undefined) =>
    config().get<number>("webaggPort", 8988) + ((s?.id ?? 1) - 1);
  const figureBase = (s: Session | undefined) =>
    readFigures(s)?.url ?? `http://127.0.0.1:${portOf(s)}`;

  // ---- 保存ダイアログ（ツールバーの Download を押すと Python が要求ファイルを書く） ----
  // webview は window.open もダウンロードもブロックするため、保存は拡張側で行う。
  const handleSaveRequest = async (reqUri: vscode.Uri) => {
    const s = byUri(reqUri);
    if (!s) { return; }
    const reqPath = reqUri.fsPath;
    let req: { figure: number; format: string };
    try {
      req = JSON.parse(fs.readFileSync(reqPath, "utf8"));
    } catch {
      return;
    }
    removeQuiet(reqPath);            // 一度きりの要求として消す
    const fmt = (req.format || "png").replace(/[^a-z0-9]/gi, "").toLowerCase() || "png";

    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(
        path.join(workspaceRoot() ?? os.homedir(), `figure${req.figure}.${fmt}`)),
      filters: { [fmt.toUpperCase()]: [fmt] },
    });
    if (!uri) { return; }
    const base = figureBase(s);
    try {
      const data = await fetchUrl(`${base}/${req.figure}/download.${fmt}`);
      fs.writeFileSync(uri.fsPath, data);
      vscode.window.setStatusBarMessage(
        `IPyDesk: ${path.basename(uri.fsPath)} を保存しました`, 2500);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      extLog(`SAVE  失敗: ${msg}`);
      vscode.window.showErrorMessage(`IPyDesk: 保存に失敗しました — ${msg}`);
    }
  };

  const syncFigurePanels = (s: Session, info: FigureInfo) => {
    s.figInfo = info;
    for (const n of info.figures) {
      // タブを閉じたが Python がまだ閉じていない figure は開き直さない
      const id = info.ids?.[String(n)];
      if (id && s.closedIds.has(id)) { continue; }
      openFigurePanel(s, info.url, n);
    }
    // Python が閉じ終えた figure は、閉じた印を消す（id は別の figure に使い回されうる）
    const alive = new Set(Object.values(info.ids ?? {}));
    for (const id of [...s.closedIds]) { if (!alive.has(id)) { s.closedIds.delete(id); } }
    for (const [n, p] of [...s.figures]) {         // plt.close された figure のタブは閉じる
      if (!info.figures.includes(n)) { disposeByExt(p); }
    }
    updateFigureHistory(s);
  };

  /** 開いている Figure タブの履歴と見出しだけを更新する（タブは開かない・前に出さない） */
  const updateFigureHistory = (s: Session) => {
    for (const n of s.figures.keys()) { postFigureHistory(s, n); }
  };

  // ---- セッション ----
  const readSession = (s: Session):
    { pid: number; busy?: boolean; error?: ErrInfo | null } | undefined => {
    try {
      return JSON.parse(fs.readFileSync(path.join(s.dir, SESSION_NAME), "utf8"));
    } catch {
      return undefined;
    }
  };
  /** Python のプロセスが生きているか（落ちてもターミナルは残るので exitStatus で見る） */
  const isAlive = (s: Session) => s.terminal.exitStatus === undefined;
  /**
   * コードを実行中か（ブレークポイントで停止中も Python から見れば実行中）。
   * 起動直後で py_session.json がまだ無いときも実行中とみなす
   * （起動と同時にスクリプトを流すので、そこへ重ねて送らない）
   */
  const isBusy = (s: Session) => readSession(s)?.busy ?? true;
  /** F5 / セル実行を受け付けられるか。停止中のセッションへ %ipydesk を送ると pdb に入ってしまう */
  const canTake = (s: Session) => isAlive(s) && !s.stopped && !isBusy(s);

  const nextId = () => {
    let id = 1;
    while (sessions.has(id)) { id++; }
    return id;
  };

  // セッションに渡す環境変数。
  //  IPYDESK_PORT  : 渡さないと Python は既定の 8988 で待ち受け、拡張だけが設定値の
  //               ポートを見にいって figure タブが空になる
  //  IPYDESK_MPL   : matplotlib バックエンド。ipydesk.figureDisplay から決まる。
  //               "auto" は Python 側が Qt → Tk → webagg の順に解決する
  //  PYTHONPATH : 同梱した ipydesk を pip install 無しで import できるようにする
  //  IPYDESK_SESSION_DIR : このセッションの通知ファイルの置き場所（セッションごとに別）
  //  IPYDESK_FIG_HISTORY : Figure タブに残す履歴の枚数（ipydesk.figureHistory）
  //  FOR_DISABLE_CONSOLE_CTRL_HANDLER : Intel Fortran ランタイム（conda の MKL 版
  //               numpy / scipy が読み込む libifcoremd.dll）が独自の Ctrl+C ハンドラを
  //               入れないようにする。入ると Ctrl+C で "forrtl: error (200)" を出して
  //               プロセスごと終了し、実行中のコマンドだけを止められない
  const sessionEnv = (id = 1, dir?: string): { [k: string]: string } => {
    const env: { [k: string]: string } = {
      FOR_DISABLE_CONSOLE_CTRL_HANDLER: "1",
      IPYDESK_PORT: String(config().get<number>("webaggPort", 8988) + id - 1),
      IPYDESK_FIG_HISTORY: String(Math.max(0, Math.floor(config().get<number>("figureHistory", 20)))),
      ...(dir ? { IPYDESK_SESSION_DIR: dir } : {}),
      IPYDESK_MPL: {
        tab: "webagg",
        manual: "webagg",
        none: "none",
        window: config().get<string>("windowBackend", "auto"),
      }[figureDisplay()],
    };
    if (config().get<boolean>("useBundledPython", true)) {
      const bundled = path.join(context.extensionPath, "python");
      if (fs.existsSync(bundled)) {
        const existing = process.env.PYTHONPATH;
        env.PYTHONPATH = existing ? `${bundled}${path.delimiter}${existing}` : bundled;
      } else {
        extLog(`SESSION 同梱 Python が見つからない: ${bundled}`);
      }
    }
    return env;
  };

  /**
   * 起動に使う Python を調べる。
   *
   * exe は解決済みの絶対パス。ターミナルでは必ずこれを使う。拡張ホストとターミナルでは
   * PATH が異なることがあり（conda / venv の自動アクティベート）、`python` のまま
   * 送ると「診断した処理系」と「実際に動く処理系」がずれて、依存は揃っているのに
   * ModuleNotFoundError になる。
   * ipydesk 自身も見る — 同梱版を PYTHONPATH で通しているので、ここが null なら
   * ターミナルは必ず `No module named ipydesk` で落ちる。
   */
  type Probe = { exe: string; missing: string[]; ipydesk: string | null };

  const PROBE_CODE = [
    "import json, sys",
    "import importlib.util as u",
    "def where(name):",
    "    try:",
    "        s = u.find_spec(name)",
    "    except Exception as e:",
    "        return '<error: %s>' % e",
    "    if s is None:",
    "        return None",
    "    return s.origin or next(iter(s.submodule_search_locations or []), None)",
    "print(json.dumps({",
    "    'exe': sys.executable,",
    "    'missing': [m for m in sys.argv[1:] if where(m) is None],",
    "    'ipydesk': where('ipydesk'),",
    "}))",
  ].join("\n");

  const probePython = (python: string, env: { [k: string]: string }):
    Promise<Probe | { error: string }> =>
    new Promise(resolve => {
      execFile(python, ["-c", PROBE_CODE, ...REQUIRED_MODULES.map(r => r.mod)],
        { env: { ...process.env, ...env }, windowsHide: true },
        (err, stdout, stderr) => {
          if (err) {
            resolve({ error: (stderr || err.message).trim() });
            return;
          }
          try {
            resolve(JSON.parse(stdout.trim().split(/\r?\n/).pop() ?? "") as Probe);
          } catch {
            resolve({ error: `診断出力を解釈できません: ${stdout.trim().slice(0, 200)}` });
          }
        });
    });

  const installDeps = (python: string, pkgs: string[], env: { [k: string]: string }) =>
    vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `IPyDesk: ${pkgs.join(", ")} をインストールしています…`,
      },
      () => new Promise<boolean>(resolve => {
        execFile(python, ["-m", "pip", "install", ...pkgs],
          { env: { ...process.env, ...env }, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
          (err, _stdout, stderr) => {
            if (err) {
              const msg = (stderr || err.message).trim();
              extLog(`DEPS  pip install 失敗: ${msg.slice(0, 400)}`);
              vscode.window.showErrorMessage(
                `IPyDesk: インストールに失敗しました — ${msg.split("\n").pop()?.slice(0, 200)}`);
              resolve(false);
              return;
            }
            extLog(`DEPS  pip install 成功: ${pkgs.join(", ")}`);
            resolve(true);
          });
      }));

  /** セッションを片付ける（ターミナルが閉じられた・再起動する） */
  const endSession = (s: Session) => {
    if (sessions.get(s.id) !== s) { return; }
    sessions.delete(s.id);
    closeFigurePanels(s);
    for (const v of varEditors) { if (v.sid === s.id) { v.ended(); } }
    try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (activeId === s.id) {
      // 直近に使っていた別のセッションをアクティブにする
      const next = [...sessions.values()].sort((a, b) => b.lastUsed - a.lastUsed)[0];
      activeId = next?.id;
    }
    refresh();
  };

  // cell を渡すと、起動直後にスクリプト全体ではなくその行範囲だけを実行する。
  // id を渡すとその番号で作る（再起動で同じ番号・同じターミナル名を引き継ぐ）
  // 起動は同時に 1 つまで。probe に 1〜2 秒かかるので、その間の F5 連打で
  // セッションが押した回数だけ増えないようにする
  let starting = false;
  const startSession = async (
    scriptPath?: string, cell?: { start: number; end: number }, id?: number, pm = false) => {
    if (starting) {
      vscode.window.setStatusBarMessage("IPyDesk: セッションを起動中です", 3000);
      return;
    }
    starting = true;
    try {
      await launchSession(scriptPath, cell, id, pm);
    } finally {
      starting = false;
    }
  };

  const launchSession = async (
    scriptPath?: string, cell?: { start: number; end: number }, id?: number, pm = false) => {
    // ほかのセッションが動いていればそのログは残す
    const lp = extLogPath();
    if (lp && sessions.size === 0) { try { fs.writeFileSync(lp, ""); } catch { /* ignore */ } }
    extLog("SESSION start");

    const vsdir = vscodeDir();
    if (!vsdir) {
      vscode.window.showWarningMessage("IPyDesk: フォルダを開いてから実行してください");
      return;
    }
    // 再起動で引き継ぐ番号が、片付けから起動までの間に使われていたら空いている番号へ
    const sid = id !== undefined && !sessions.has(id) ? id : nextId();
    const sdir = path.join(vsdir, SESSIONS_DIR, String(sid));
    const python = config().get<string>("pythonPath", "python");
    const bundled = config().get<boolean>("useBundledPython", true);
    const env = sessionEnv(sid, sdir);
    extLog(`SESSION #${sid} dir=${sdir}`);
    extLog(`SESSION pythonPath=${python} useBundledPython=${bundled}`);
    extLog(`SESSION figureDisplay=${figureDisplay()} IPYDESK_MPL=${env.IPYDESK_MPL}`);
    extLog(`SESSION PYTHONPATH=${env.PYTHONPATH ?? "(未設定)"}`);

    const probe = await probePython(python, env);
    if ("error" in probe) {
      extLog(`PROBE python を実行できない: ${probe.error.slice(0, 300)}`);
      vscode.window.showErrorMessage(
        `IPyDesk: Python を実行できません（${python}）。設定 ipydesk.pythonPath を確認してください`);
      return;
    }
    extLog(`PROBE exe=${probe.exe}`);
    extLog(`PROBE ipydesk=${probe.ipydesk ?? "(import できない)"}`);
    extLog(`PROBE 不足モジュール: ${probe.missing.join(", ") || "なし"}`);

    if (probe.missing.length > 0) {
      const pkgs = probe.missing.map(
        m => REQUIRED_MODULES.find(r => r.mod === m)?.pip ?? m);
      const pick = await vscode.window.showWarningMessage(
        `IPyDesk: 依存パッケージが不足しています（${pkgs.join(", ")}）`,
        "インストール", "あとで");
      if (pick === "インストール" && !await installDeps(probe.exe, pkgs, env)) {
        return;
      }
      // 「あとで」でもセッションは起動する。診断の誤検出で操作不能になるのを避けるため。
    }

    // ipydesk 本体が見えなければ、起動しても必ず ModuleNotFoundError で落ちる。
    // 心当たりを添えてここで止める（ターミナルの一瞬のエラーより分かりやすい）。
    if (!probe.ipydesk) {
      const hint = bundled
        ? `同梱版に PYTHONPATH が通っていません（${env.PYTHONPATH ?? "未設定"}）`
        : "設定 ipydesk.useBundledPython が false です。pip install -e ./python を実行するか true に戻してください";
      extLog(`PROBE 中止: ipydesk を import できない — ${hint}`);
      vscode.window.showErrorMessage(`IPyDesk: ipydesk を import できません — ${hint}`);
      return;
    }

    // 前セッションの残骸（強制終了時など）を掃除。.vscode/ 直下は単一セッション時代の置き場所
    for (const n of [SESSION_NAME, STATE_NAME, FIGURES_NAME, SAVE_REQUEST_NAME, WORKSPACE_NAME]) {
      removeQuiet(path.join(vsdir, n));
    }
    try { fs.rmSync(sdir, { recursive: true, force: true }); } catch { /* ignore */ }
    fs.mkdirSync(sdir, { recursive: true });

    // シェルを挟まず Python 自身をターミナルのプロセスにする。
    //  - 診断した処理系（probe.exe）と実際に動く処理系が必ず一致する
    //  - パスに空白があってもクォート（PowerShell の & 演算子）を気にしなくてよい
    //  - PowerShell プロファイルや conda の自動アクティベートが割り込まない
    // ターミナルへの sendText は pty 経由で IPython / ipdb の標準入力に届くので、
    // 停止中のコマンド送信や %ipydesk での再実行はこれまで通り動く。
    const args = [
      "-m", "ipydesk",
      ...(scriptPath ? [scriptPath] : []),
      ...(scriptPath && cell ? ["--cell", String(cell.start), String(cell.end)] : []),
      ...(scriptPath && pm ? ["--pm"] : []),
    ];
    extLog(`SESSION launch ${probe.exe} ${args.join(" ")}`);
    // isTransient: VS Code のターミナル永続化（terminal.integrated.enablePersistentSessions）
    // の対象から外す。外さないと、ウィンドウを閉じて開き直したときに VS Code が
    // 同じ shellPath / shellArgs でターミナルを復元し、前回のスクリプトが勝手に走る。
    const name = sid === 1 ? "IPyDesk" : `IPyDesk ${sid}`;
    const terminal = vscode.window.createTerminal({
      name, shellPath: probe.exe, shellArgs: args, env, isTransient: true,
    });
    const s: Session = {
      id: sid, name, dir: sdir, terminal, figures: new Map(), histCut: new Map(), figIds: new Map(), closedIds: new Set(), ws: null,
      lastUsed: Date.now(),
    };
    sessions.set(sid, s);
    activeId = sid;
    terminal.show(true);
    refresh();
  };

  /**
   * スクリプト / 行範囲を実行するセッションを選ぶ。
   *  1. アクティブなセッションが空いていればそこ
   *  2. 実行中なら、空いている別のセッション（直近に使ったもの）
   *  3. どれも実行中なら undefined（= 新しいセッションを起動する）
   */
  const pickSession = (): Session | undefined => {
    const a = active();
    if (a && canTake(a)) { return a; }
    return [...sessions.values()].filter(canTake).sort((x, y) => y.lastUsed - x.lastUsed)[0];
  };

  /**
   * 選んだセッションへ送る。forceNew なら必ず新しいセッションで実行する。
   * pm（Alt+F5）ならエラーの行で止まる。F5 / セル実行は止まらない
   */
  const dispatch = async (
    scriptPath: string, cell?: { start: number; end: number }, forceNew = false, pm = false) => {
    const a = active();
    const target = forceNew ? undefined : pickSession();
    if (!forceNew && a && target !== a && isAlive(a)) {
      vscode.window.setStatusBarMessage(
        `IPyDesk: ${a.name} は${a.stopped ? "停止中" : "実行中"}のため`
        + ` ${target?.name ?? "新しいセッション"} で実行します`, 4000);
    }
    if (!target) {
      await startSession(scriptPath, cell, undefined, pm);
      return;
    }
    setActive(target);
    target.error = undefined;   // 実行を始めた時点で前のエラーには入れなくなる
    updateStatus();
    target.terminal.show(true);
    const opt = pm ? "--pm " : "";
    target.terminal.sendText(cell
      ? `%ipydesk_cell ${opt}"${scriptPath}" ${cell.start} ${cell.end}`
      : `%ipydesk ${opt}"${scriptPath}"`);
  };

  // ---- 赤丸 ----
  dumpBreakpoints();
  context.subscriptions.push(vscode.debug.onDidChangeBreakpoints(dumpBreakpoints));

  // ---- セル / 選択範囲の実行 ----
  const pythonEditor = (): vscode.TextEditor | undefined => {
    const ed = vscode.window.activeTextEditor;
    trackCodeEditor(ed);
    if (!ed || ed.document.languageId !== "python") {
      vscode.window.showWarningMessage("IPyDesk: Python ファイルを開いてください");
      return undefined;
    }
    return ed;
  };

  /**
   * 行範囲（1 始まり・両端含む）を現在のセッションで実行する。
   * Python 側はファイルを読み直すので、送る前に必ず保存する。
   * 行番号をそのまま渡すため、赤丸も例外行もエディタの行と一致する。
   */
  const runRange = async (doc: vscode.TextDocument, start: number, end: number) => {
    await doc.save();
    await dispatch(doc.uri.fsPath, { start, end });   // 新規セッションなら起動と同時にその範囲を実行
  };

  /** カーソルを移し、そこが見えるようにスクロールする */
  const moveCursor = (ed: vscode.TextEditor, line: number) => {
    const pos = new vscode.Position(Math.min(line, ed.document.lineCount - 1), 0);
    ed.selection = new vscode.Selection(pos, pos);
    ed.revealRange(new vscode.Range(pos, pos),
      vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    applyCellDecorations();
  };

  const runCurrentCell = async (advance: boolean) => {
    const ed = pythonEditor();
    if (!ed) { return; }
    const cell = cellAt(ed.document, ed.selection.active.line);
    if (cellMarkers(ed.document).length === 0) {
      // 区切りが無いファイルは全体が 1 セル。黙って全部走ると驚くので一言出す。
      vscode.window.setStatusBarMessage(
        "IPyDesk: セル区切り（# %%）が無いのでファイル全体を実行します", 3000);
    }
    await runRange(ed.document, cell.start, cell.end);
    if (advance) { moveCursor(ed, cell.end); }   // 次のセルの先頭（= 区切り行）へ
  };

  const runSelectionOrLine = async () => {
    const ed = pythonEditor();
    if (!ed) { return; }
    const sel = ed.selection;
    if (!sel.isEmpty) {
      // 行頭で終わる選択（行全体をドラッグした形）は、その行を含めない
      const endLine = sel.end.character === 0 && sel.end.line > sel.start.line
        ? sel.end.line - 1 : sel.end.line;
      await runRange(ed.document, sel.start.line + 1, endLine + 1);
      return;
    }
    await runRange(ed.document, sel.active.line + 1, sel.active.line + 1);
    moveCursor(ed, sel.active.line + 1);   // 1 行ずつ試せるよう次の行へ
  };

  // ---- キーバインドの競合解消 ----
  // Ctrl+Enter / Shift+Enter は Jupyter 拡張（ms-toolsai.jupyter）や Python 拡張も
  // 使っている。拡張どうしの優先順位は選べず、後から読み込まれた方が勝つため、
  // 何もしないとインタラクティブウィンドウが開いてしまう。
  // ユーザーの keybindings.json は必ず拡張より優先されるので、そこに書き込む。
  const RIVAL_EXTENSIONS = ["ms-toolsai.jupyter", "ms-python.python"];
  const KEY_PROMPT_DONE = "ipydesk.keybindingPromptDone";
  const CELL_KEY_WHEN =
    "editorTextFocus && editorLangId == python"
    + " && !ipydesk.stopped && !inDebugMode && !suggestWidgetVisible";
  const CELL_KEY_RULES = [
    { key: "ctrl+enter", command: "ipydesk.runCell", when: CELL_KEY_WHEN },
    { key: "shift+enter", command: "ipydesk.runCellAndAdvance", when: CELL_KEY_WHEN },
    { key: "ctrl+shift+enter", command: "ipydesk.runSelection", when: CELL_KEY_WHEN },
  ];

  const keyRulesText = () =>
    CELL_KEY_RULES.map(r => "  " + JSON.stringify(r)).join(",\n");

  const installCellKeybindings = async () => {
    await vscode.commands.executeCommand("workbench.action.openGlobalKeybindingsFile");
    // コマンドの完了とエディタの切り替えは同期しないので、開き終わるまで少し待つ
    const isKeybindings = (e?: vscode.TextEditor) =>
      !!e && path.basename(e.document.uri.fsPath) === "keybindings.json";
    let ed = vscode.window.activeTextEditor;
    for (let i = 0; i < 20 && !isKeybindings(ed); i++) {
      await new Promise(r => setTimeout(r, 50));
      ed = vscode.window.activeTextEditor;
    }
    const doc = ed?.document;
    if (!ed || !doc || !isKeybindings(ed)) {
      await vscode.env.clipboard.writeText(keyRulesText());
      vscode.window.showWarningMessage(
        "IPyDesk: keybindings.json を開けませんでした。設定をクリップボードにコピーしたので、"
        + "「基本設定: キーボードショートカット (JSON)」を開いて貼り付けてください");
      return;
    }
    const text = doc.getText();
    if (text.includes("ipydesk.runCell")) {
      vscode.window.showInformationMessage("IPyDesk: セル実行のキー設定は既に追加されています");
      return;
    }
    const close = text.lastIndexOf("]");
    if (close < 0) {
      await vscode.env.clipboard.writeText(keyRulesText());
      vscode.window.showWarningMessage(
        "IPyDesk: keybindings.json の形が想定と違うため自動で追加できませんでした。"
        + "設定をクリップボードにコピーしたので、[ ] の中に貼り付けてください");
      return;
    }
    // 直前の要素があればカンマで続ける（コメントは判定から外す）
    const before = text.slice(0, close)
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const snippet = (/[}\]]\s*$/.test(before) ? ",\n" : "\n") + keyRulesText() + "\n";
    await ed.edit(b => b.insert(doc.positionAt(close), snippet));
    await doc.save();
    vscode.window.showInformationMessage(
      "IPyDesk: Ctrl+Enter / Shift+Enter / Ctrl+Shift+Enter を IPyDesk のセル実行に割り当てました");
  };

  /** Jupyter / Python 拡張が入っていれば、最初の1回だけ割り当てを提案する */
  const offerCellKeybindings = async () => {
    if (context.globalState.get<boolean>(KEY_PROMPT_DONE)) { return; }
    if (!RIVAL_EXTENSIONS.some(id => vscode.extensions.getExtension(id))) { return; }
    const pick = await vscode.window.showInformationMessage(
      "IPyDesk: Ctrl+Enter / Shift+Enter は Jupyter 拡張にも割り当てられていて、"
      + "そのままだとインタラクティブウィンドウが開きます。IPyDesk のセル実行を優先しますか？",
      "IPyDesk を優先", "あとで", "今後表示しない");
    if (pick === "IPyDesk を優先") {
      await installCellKeybindings();
      await context.globalState.update(KEY_PROMPT_DONE, true);
    } else if (pick === "今後表示しない") {
      await context.globalState.update(KEY_PROMPT_DONE, true);
    }
  };

  // ---- コマンド: 実行系 ----
  const runFile = (forceNew: boolean, pm = false) => async () => {
    trackCodeEditor(vscode.window.activeTextEditor);
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc || doc.languageId !== "python") {
      vscode.window.showWarningMessage("IPyDesk: Python ファイルを開いてください");
      return;
    }
    await doc.save();
    await dispatch(doc.uri.fsPath, undefined, forceNew, pm);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("ipydesk.run", runFile(false)),
    vscode.commands.registerCommand("ipydesk.runInNewSession", runFile(true)),
    vscode.commands.registerCommand("ipydesk.runStopOnError", runFile(false, true)),

    // 直前の実行のエラーの行に入る（F5 / セル実行はエラーで止まらないので、後から入る）
    vscode.commands.registerCommand("ipydesk.debugLastError", () => {
      const s = errorSession();
      if (!s) {
        vscode.window.showInformationMessage(
          "IPyDesk: 直前のエラーはありません（次の実行を始めると消えます）");
        return;
      }
      if (s.stopped || isBusy(s)) {
        vscode.window.showWarningMessage(`IPyDesk: ${s.name} は実行中のため入れません`);
        return;
      }
      setActive(s);
      s.terminal.show(true);
      s.terminal.sendText("%ipydesk_pm");
    }),

    vscode.commands.registerCommand("ipydesk.selectSession", async () => {
      if (sessions.size === 0) {
        vscode.window.showInformationMessage("IPyDesk: 稼働中のセッションはありません");
        return;
      }
      const items = [...sessions.values()].sort((a, b) => a.id - b.id).map(s => ({
        label: `${s.id === activeId ? "$(check) " : ""}${s.name}`,
        description: s.stopped
          ? `⏸ ${path.basename(s.stopped.file)}:${s.stopped.line}`
          : isBusy(s) ? "実行中" : "待機中",
        s,
      }));
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: "F5 / セル実行の送り先にするセッション",
      });
      if (pick) {
        setActive(pick.s);
        pick.s.terminal.show(true);
      }
    }),

    vscode.commands.registerCommand("ipydesk.runCell", () => runCurrentCell(false)),
    vscode.commands.registerCommand("ipydesk.runCellAndAdvance", () => runCurrentCell(true)),
    vscode.commands.registerCommand("ipydesk.runSelection", runSelectionOrLine),
    vscode.commands.registerCommand("ipydesk.useCellKeys", installCellKeybindings),

    // 空のセッションを 1 つ追加して、F5 の送り先にする。既存のセッションは変数も計算もそのまま残す。
    // スクリプトは実行しない（実行したければ続けて F5）。要らなくなったセッションはターミナルを閉じる。
    vscode.commands.registerCommand("ipydesk.newSession", async () => {
      await startSession();
    }),

    vscode.commands.registerCommand("ipydesk.openFigures", async () => {
      if (!figuresInTabs()) {
        vscode.window.showInformationMessage(
          figureDisplay() === "window"
            ? "IPyDesk: 設定 ipydesk.figureDisplay が window のため、図は別ウィンドウに出ています"
            : "IPyDesk: 設定 ipydesk.figureDisplay が none のため、図は表示されません");
        return;
      }
      const s = active();
      const info = readFigures(s);
      if (s && info && info.figures.length > 0) {
        syncFigurePanels(s, info);
        return;
      }
      // figure 情報が無い → webagg の一覧ページを Simple Browser で開く
      return vscode.commands.executeCommand(
        "simpleBrowser.api.open",
        vscode.Uri.parse(figureBase(s)),
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }
      );
    }),

    vscode.commands.registerCommand("ipydesk.copyFigure", async () => {
      if (process.platform !== "win32") {
        vscode.window.showWarningMessage("IPyDesk: 画像のクリップボードコピーは Windows のみ対応です");
        return;
      }
      // アイコンを押した時点でフォーカスされているタブを優先し、無ければ直近のものを使う
      const focused = allFigurePanels().find(f => f.p.active);
      const fig = focused ? { sid: focused.s.id, num: focused.num } : activeFigure;
      if (fig === undefined) {
        vscode.window.showWarningMessage("IPyDesk: コピーする Figure タブがありません");
        return;
      }
      const num = fig.num;
      const base = figureBase(sessions.get(fig.sid));
      const tmp = path.join(os.tmpdir(), `ipydesk-fig${num}-${Date.now()}.png`);
      try {
        const png = await fetchUrl(`${base}/${num}/download.png`);
        fs.writeFileSync(tmp, png);
        await setClipboardImage(tmp);
        vscode.window.setStatusBarMessage(`IPyDesk: Figure ${num} をコピーしました`, 2000);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        extLog(`COPY  失敗: ${msg}`);
        vscode.window.showErrorMessage(`IPyDesk: Figure ${num} のコピーに失敗しました — ${msg}`);
      } finally {
        removeQuiet(tmp);
      }
    }),
  );

  // ---- コマンド: 停止中の pdb 操作 ----
  // 送り先はアクティブなセッション。そこが停止していなければ、停止中の別のセッション
  const send = (cmd: string) => () => {
    const a = active();
    const s = a?.stopped ? a : [...sessions.values()].find(x => x.stopped) ?? a;
    (s?.terminal ?? vscode.window.activeTerminal)?.sendText(cmd);
  };
  context.subscriptions.push(
    vscode.commands.registerCommand("ipydesk.continue", send("c")),
    vscode.commands.registerCommand("ipydesk.stepOver", send("n")),
    vscode.commands.registerCommand("ipydesk.stepInto", send("s")),
    vscode.commands.registerCommand("ipydesk.stepOut",  send("r")),
    vscode.commands.registerCommand("ipydesk.stop",     send("q")),
    vscode.window.onDidCloseTerminal(t => {
      const s = byTerminal(t);
      if (s) { endSession(s); }
    }),
    // IPyDesk のターミナルを前に出したら、そのセッションを F5 の送り先にする
    vscode.window.onDidChangeActiveTerminal(t => {
      const s = byTerminal(t);
      if (s) { setActive(s); }
    }),
  );

  // ---- 停止位置の監視 ----
  // 止まったセッションをアクティブにする（F10 などがそのセッションへ届くように）
  const onStateChanged = async (uri: vscode.Uri) => {
    const s = byUri(uri);
    if (!s) { return; }
    try {
      const raw = await vscode.workspace.fs.readFile(uri);
      const stop: Stop = JSON.parse(Buffer.from(raw).toString("utf8"));
      s.stopped = stop;
      activeId = s.id;
      s.lastUsed = Date.now();
      refresh();
      await revealStop(stop);
    } catch {
      s.stopped = undefined;
      refresh();
    }
  };
  const onStateCleared = (uri: vscode.Uri) => {
    const s = byUri(uri);
    if (s) { s.stopped = undefined; refresh(); }
  };

  const sessionGlob = (name: string) => `**/.vscode/${SESSIONS_DIR}/*/${name}`;

  // py_session.json（busy / error）が変わったら、エラーの ⚠ を出し直す
  const onSessionFile = (uri: vscode.Uri) => {
    const s = byUri(uri);
    if (!s) { return; }
    const info = readSession(s);
    if (!info || info.busy) { return; }   // 実行中は前のエラーを出さない（ほぼ消えている）
    s.error = info.error ?? undefined;
    updateStatus();
  };
  const sessionWatcher = vscode.workspace.createFileSystemWatcher(sessionGlob(SESSION_NAME));
  sessionWatcher.onDidCreate(onSessionFile);
  sessionWatcher.onDidChange(onSessionFile);
  context.subscriptions.push(sessionWatcher);
  const stateWatcher = vscode.workspace.createFileSystemWatcher(sessionGlob(STATE_NAME));
  stateWatcher.onDidCreate(onStateChanged);
  stateWatcher.onDidChange(onStateChanged);
  stateWatcher.onDidDelete(onStateCleared);
  context.subscriptions.push(
    stateWatcher,
    vscode.window.onDidChangeVisibleTextEditors(applyHighlight),
  );

  // ---- figure タブの自動オープン ----
  const onFigures = async (uri: vscode.Uri) => {
    const s = byUri(uri);
    const info = readFigures(s);
    if (!s || !info) { return; }
    if (figureDisplay() === "tab") {
      syncFigurePanels(s, info);
    } else {
      updateFigureHistory(s);   // manual: 自動では開かないが、開いているタブの履歴は更新する
    }
  };
  const figWatcher = vscode.workspace.createFileSystemWatcher(sessionGlob(FIGURES_NAME));
  figWatcher.onDidCreate(onFigures);
  figWatcher.onDidChange(onFigures);
  context.subscriptions.push(figWatcher);

  // ---- 変数一覧の監視（ワークスペースビュー） ----
  // Python は一時ファイルからの置き換えで書くので、読めた時点の内容は常に完全。
  // それでも壊れていたら（手で消した等）その回は無視して次の更新を待つ。
  // 変数一覧はセッションごとに覚えておき、ビューにはアクティブなセッションの分だけ出す
  const onWorkspace = async (uri: vscode.Uri) => {
    const s = byUri(uri);
    if (!s) { return; }   // このウィンドウのセッションでなければ出さない
    try {
      const raw = await vscode.workspace.fs.readFile(uri);
      s.ws = JSON.parse(Buffer.from(raw).toString("utf8")) as WsData;
      if (s.id === activeId) { refresh(); }
      for (const v of varEditors) { if (v.sid === s.id) { v.refresh(); } }
    } catch { /* ignore */ }
  };
  const wsWatcher = vscode.workspace.createFileSystemWatcher(sessionGlob(WORKSPACE_NAME));
  wsWatcher.onDidCreate(onWorkspace);
  wsWatcher.onDidChange(onWorkspace);
  wsWatcher.onDidDelete(uri => {
    const s = byUri(uri);
    if (s) { s.ws = null; if (s.id === activeId) { refresh(); } }
  });
  context.subscriptions.push(wsWatcher);

  // ---- 保存要求の監視 ----
  const saveWatcher = vscode.workspace.createFileSystemWatcher(sessionGlob(SAVE_REQUEST_NAME));
  saveWatcher.onDidCreate(handleSaveRequest);
  saveWatcher.onDidChange(handleSaveRequest);
  context.subscriptions.push(saveWatcher);

  // ---- Variable Editor ----
  // 問い合わせはファイルで行う: py_varreq_<id>.json を書き、Python のスレッドが
  // py_varres_<id>.json に答える。プロンプト待ち・停止中・計算中のどれでも答えが返る
  const varEditors: VariableEditor[] = [];
  let varSeq = 0;

  const queryVar = async (sid: number, q: VarQuery): Promise<any> => {
    const s = sessions.get(sid);
    if (!s || !isAlive(s)) { throw new Error("セッションが終了しています"); }
    const id = `${Date.now().toString(36)}_${(varSeq++).toString(36)}`;
    const req = path.join(s.dir, `${VAR_REQ_PREFIX}${id}.json`);
    const res = path.join(s.dir, `${VAR_RES_PREFIX}${id}.json`);
    const tmp = req + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ id, ...q }), "utf8");
    fs.renameSync(tmp, req);       // 書きかけを読ませない
    const until = Date.now() + VAR_TIMEOUT_MS;
    for (let wait = 15; Date.now() < until; wait = Math.min(wait * 1.5, 100)) {
      await new Promise(r => setTimeout(r, wait));
      let text: string;
      try { text = fs.readFileSync(res, "utf8"); } catch { continue; }
      try {
        const data = JSON.parse(text);
        removeQuiet(res);
        return data;
      } catch { continue; }       // 置き換えの途中。次の周回で読む
    }
    removeQuiet(req);
    throw new Error("Python から応答がありません（古い ipydesk のセッションか、処理が詰まっています）");
  };

  /** Variable Editor のボタンから、コード（プロット）をセッションで実行する */
  const runInSession = (sid: number, code: string) => {
    const s = sessions.get(sid);
    if (!s || !isAlive(s)) {
      vscode.window.showWarningMessage("IPyDesk: セッションが終了しています");
      return;
    }
    // 停止中は pdb がそのフレームで実行する。実行中は入力が溜まるだけなので送らない
    if (!s.stopped && isBusy(s)) {
      vscode.window.showWarningMessage(`IPyDesk: ${s.name} は実行中のため、終わってからもう一度押してください`);
      return;
    }
    if (figureDisplay() === "none") {
      vscode.window.setStatusBarMessage(
        "IPyDesk: ipydesk.figureDisplay が none のため、図は表示されません", 4000);
    }
    s.lastUsed = Date.now();
    s.terminal.show(true);
    s.terminal.sendText(code);
  };

  const openVariable = (expr: string, s: Session | undefined = active()) => {
    expr = expr.trim();
    if (!expr) { return; }
    if (!s) {
      vscode.window.showInformationMessage(
        "IPyDesk: セッションがありません。F5 で実行してから開いてください");
      return;
    }
    const open = varEditors.find(v => v.sid === s.id && v.expr === expr);
    if (open) { open.reveal(); return; }
    const title = sessions.size > 1 || s.id !== 1 ? `${expr} (${s.name})` : expr;
    const ed = new VariableEditor(expr, s.id, title, figureColumn(), {
      query: queryVar,
      run: runInSession,
      closed: e => {
        const i = varEditors.indexOf(e);
        if (i >= 0) { varEditors.splice(i, 1); }
      },
    });
    varEditors.push(ed);
  };
  workspaceView.onOpen = expr => openVariable(expr);

  /** 開く変数を選ぶ。一覧に無い式（sim.state や d['k'] など）も打ち込める */
  const pickVariable = async () => {
    const s = active();
    if (!s) {
      vscode.window.showInformationMessage(
        "IPyDesk: セッションがありません。F5 で実行してから開いてください");
      return;
    }
    const vars = (s.ws?.vars ?? []).filter(v => v.open);
    const qp = vscode.window.createQuickPick<vscode.QuickPickItem>();
    qp.placeholder = "Variable Editor で開く変数（一覧に無い式も入力できます）";
    const base: vscode.QuickPickItem[] = vars.map(v => ({ label: v.name, description: `${v.size}  ${v.cls}` }));
    qp.items = base;
    qp.onDidChangeValue(val => {
      const t = val.trim();
      qp.items = t && !base.some(b => b.label === t)
        ? [{ label: t, description: "式として開く" }, ...base] : base;
    });
    qp.onDidAccept(() => {
      const pick = qp.selectedItems[0]?.label ?? qp.value;
      qp.hide();
      openVariable(pick, s);
    });
    qp.onDidHide(() => qp.dispose());
    qp.show();
  };

  context.subscriptions.push(
    // 引数: 式の文字列 / ワークスペースビューの右クリック（{ varExpr }）/ 無し（一覧から選ぶ）
    vscode.commands.registerCommand("ipydesk.openVariable", (arg?: unknown) => {
      if (typeof arg === "string") { return openVariable(arg); }
      const x = (arg as { varExpr?: unknown } | undefined)?.varExpr;
      if (typeof x === "string") { return openVariable(x); }
      return pickVariable();
    }),
  );

  // ---- Open Desk: MATLAB 風の配置 ----
  //  ┌──────────┬────────────────┬───────────────┐
  //  │Workspace │ コード          │ Figure /       │
  //  │（サイド  │                │ Variable Editor │
  //  │  バー）  ├────────────────┴───────────────┤
  //  │          │ IPyDesk コンソール（パネル）       │
  //  └──────────┴────────────────────────────────┘
  const openDesk = async () => {
    // コマンドウィンドウにあたるセッションが無ければ、空のセッションを起動する
    if (sessions.size === 0) {
      await startSession();
    }
    const s = active();

    // 1. エディタ: 左にコード、右に図・変数
    const desk = [...allFigurePanels().map(f => f.p), ...varEditors.map(v => v.panel)];
    const figs = s && figuresInTabs() ? readFigures(s) : undefined;
    const right = figuresInTabs() || desk.length > 0;
    const code = lastCode ?? (vscode.window.activeTextEditor?.document.languageId === "python"
      ? { uri: vscode.window.activeTextEditor.document.uri, column: vscode.ViewColumn.One } : undefined);
    await vscode.commands.executeCommand("vscode.setEditorLayout", right
      ? { orientation: 0, groups: [{ size: 0.58 }, { size: 0.42 }] }
      : { orientation: 0, groups: [{}] });
    if (right) {
      for (const p of desk) { p.reveal(vscode.ViewColumn.Two, true); }
    }
    if (code) {
      await vscode.window.showTextDocument(code.uri, {
        viewColumn: vscode.ViewColumn.One, preserveFocus: false, preview: false });
    }
    // 閉じていた Figure タブも開き直す（右のグループに入る）
    if (s && figs && figs.figures.length > 0) {
      syncFigurePanels(s, figs);
    }

    // 2. パネル（下）にコンソール
    try {
      await vscode.commands.executeCommand("workbench.action.positionPanelBottom");
    } catch { /* 古い VS Code */ }
    s?.terminal.show(true);

    // 3. サイドバーに Workspace
    await vscode.commands.executeCommand("workbench.view.extension.ipydesk");

    // 4. フォーカスはコードへ戻す
    if (code) {
      await vscode.window.showTextDocument(code.uri, {
        viewColumn: vscode.ViewColumn.One, preserveFocus: false, preview: false });
    }
  };
  context.subscriptions.push(vscode.commands.registerCommand("ipydesk.openDesk", openDesk));

  // ---- セルの折りたたみ ----
  // インデントによる既定の折りたたみと併存する（VS Code が両方をマージする）
  context.subscriptions.push(
    vscode.languages.registerFoldingRangeProvider({ language: "python" }, {
      provideFoldingRanges(doc) {
        const marks = cellMarkers(doc);
        return marks
          .map((m, i) => new vscode.FoldingRange(
            m,
            i + 1 < marks.length ? marks[i + 1] - 1 : doc.lineCount - 1,
            vscode.FoldingRangeKind.Region))
          .filter(r => r.end > r.start);
      },
    }),
    vscode.window.onDidChangeActiveTextEditor(applyCellDecorations),
    vscode.window.onDidChangeVisibleTextEditors(applyCellDecorations),
    vscode.window.onDidChangeTextEditorSelection(applyCellDecorations),
    vscode.workspace.onDidChangeTextDocument(applyCellDecorations),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration("ipydesk.showCellDecorations")) { applyCellDecorations(); }
    }),
  );

  // ---- 設定変更への追従 ----
  // バックエンドはセッション起動時に決まるので、走っている間は作り直さないと変わらない。
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async e => {
      if (!e.affectsConfiguration("ipydesk.figureDisplay")
        && !e.affectsConfiguration("ipydesk.windowBackend")
        && !e.affectsConfiguration("ipydesk.autoOpenFigures")) { return; }
      updateFigureTabsContext();
      if (sessions.size === 0) { return; }
      // 設定変更の反映だけは、古い設定のセッションを残しても紛らわしいので置き換える
      const pick = await vscode.window.showInformationMessage(
        "IPyDesk: 図の表示先が変わりました。アクティブなセッションを空のセッションに置き換えると反映されます（変数は消えます）",
        "置き換える");
      if (pick !== "置き換える") { return; }
      if (starting) {   // 片付けだけして起動されない、を避ける
        vscode.window.setStatusBarMessage("IPyDesk: セッションを起動中です", 3000);
        return;
      }
      const s = active();
      if (s) {
        endSession(s);
        s.terminal.dispose();
      }
      await startSession(undefined, undefined, s?.id);
    }),
  );

  setStopped(false);
  updateFigureTabsContext();
  updateStatus();
  applyCellDecorations();
  void offerCellKeybindings();
}

export function deactivate() {}