// ---- エクスプローラーのファイルを実行（.bat / .cmd / .exe / .ps1 など）----
// MATLAB の「現在のフォルダー」でファイルを実行する感覚で、VS Code のエクスプローラーや
// エディタで開いているファイルを F5 / 右クリックから実行する。
//
//  ・ターミナルで実行 : VS Code のターミナルを 1 つ作り、そのファイルのフォルダで実行する。
//                       実行後もターミナルは残る（出力を読める・続けて入力できる）。
//                       同じファイルをもう一度実行すると、前のターミナルを閉じて作り直す
//  ・ダブルクリックと同じ : OS の関連付けで起動する（cmd の start）。VS Code とは切り離される
import * as vscode from "vscode";
import * as path from "path";
import { execFile } from "child_process";

/** 拡張子を足さなくても対象にするもの（package.json の when 句の正規表現と揃える） */
export const DEFAULT_RUN_EXTS = [".bat", ".cmd", ".exe", ".ps1"];
const EXTRA_EXTS_SETTING = "runFileExtraExtensions";
const EXTS_CONTEXT_KEY = "ipydesk.runFileExts";
const TERMINAL_PREFIX = "▶ ";

/** キー割り当てから呼ばれたときの引数（package.json の keybindings の args） */
type KeySource = { source: "explorer" | "editor" };

function normExt(e: string): string {
  const t = e.trim().toLowerCase();
  return t === "" ? "" : t.startsWith(".") ? t : "." + t;
}

/** when 句の `resourceExtname in ipydesk.runFileExts` 用。大文字の拡張子（.BAT）も拾う */
function updateExtsContext(): void {
  const extra = vscode.workspace.getConfiguration("ipydesk").get<string[]>(EXTRA_EXTS_SETTING) ?? [];
  const exts = [...new Set([...DEFAULT_RUN_EXTS, ...extra.map(normExt).filter(Boolean)])];
  const both = exts.flatMap(e => [e, e.toUpperCase()]);
  void vscode.commands.executeCommand("setContext", EXTS_CONTEXT_KEY, both);
}

/** エクスプローラーで選んでいるファイル。キー操作からは URI が渡らないので
 *  「パスのコピー」を借りて取る（クリップボードは元に戻す） */
async function explorerSelection(): Promise<vscode.Uri[]> {
  const saved = await vscode.env.clipboard.readText();
  try {
    await vscode.env.clipboard.writeText("");
    await vscode.commands.executeCommand("copyFilePath");
    const text = await vscode.env.clipboard.readText();
    return text.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(p => vscode.Uri.file(p));
  } finally {
    await vscode.env.clipboard.writeText(saved);
  }
}

/** コマンドの引数から実行するファイルを決める
 *  - 右クリック（エクスプローラー）: (uri, 選択中の uri[])
 *  - 右クリック（エディタのタブ・▶ ボタン）: (uri)
 *  - キー操作: ({ source })
 *  - コマンドパレット: なし → アクティブなエディタ */
async function targets(arg: unknown, multi: unknown): Promise<vscode.Uri[]> {
  if (Array.isArray(multi) && multi.length > 0 && multi.every(u => u instanceof vscode.Uri)) {
    return multi as vscode.Uri[];
  }
  if (arg instanceof vscode.Uri) { return [arg]; }
  if ((arg as KeySource | undefined)?.source === "explorer") { return explorerSelection(); }
  const doc = vscode.window.activeTextEditor?.document;
  return doc && doc.uri.scheme === "file" ? [doc.uri] : [];
}

/** 未保存のまま実行すると古い内容で動くので、開いていて変更があれば保存する */
async function saveIfDirty(uri: vscode.Uri): Promise<void> {
  const doc = vscode.workspace.textDocuments.find(
    d => d.uri.fsPath.toLowerCase() === uri.fsPath.toLowerCase());
  if (doc?.isDirty) { await doc.save(); }
}

async function filesOnly(uris: vscode.Uri[]): Promise<string[]> {
  const out: string[] = [];
  for (const u of uris) {
    try {
      const st = await vscode.workspace.fs.stat(u);
      if (st.type & vscode.FileType.File) { out.push(u.fsPath); }
    } catch { /* 消えたファイルは無視 */ }
  }
  return out;
}

/** ターミナルの起動方法。.ps1 は PowerShell、ほかは cmd に任せる
 *  （.bat / .cmd / .exe はそのまま、.vbs / .py などは関連付けで動く） */
export function terminalOptionsFor(file: string, comspec = process.env.ComSpec || "cmd.exe")
  : { shellPath: string; shellArgs: string | string[] } {
  if (path.extname(file).toLowerCase() === ".ps1") {
    return {
      shellPath: "powershell.exe",
      shellArgs: ["-NoLogo", "-NoExit", "-ExecutionPolicy", "Bypass", "-File", file],
    };
  }
  // shellArgs を文字列で渡すと Windows ではそのままコマンドラインになる。
  // cmd /k は先頭が " なら最初と最後の " を 1 つずつ外すので、二重に囲むとスペース・日本語入りでも崩れない
  return { shellPath: comspec, shellArgs: `/k ""${file}""` };
}

function runInTerminal(file: string): void {
  const name = TERMINAL_PREFIX + path.basename(file);
  // 同じファイルの前のターミナルは閉じて作り直す（並ぶと紛らわしいため）
  for (const t of vscode.window.terminals) {
    if (t.name === name) { t.dispose(); }
  }
  const term = vscode.window.createTerminal({
    name,
    cwd: path.dirname(file),
    iconPath: new vscode.ThemeIcon("play"),
    ...terminalOptionsFor(file),
  });
  term.show(false);
}

function openExternally(file: string): Promise<void> {
  // start の最初の "" はウィンドウタイトル（無いとパスがタイトルとして食われる）
  return new Promise((resolve, reject) => {
    execFile(process.env.ComSpec || "cmd.exe", ["/c", "start", "", file],
      { cwd: path.dirname(file), windowsHide: true },
      err => (err ? reject(err) : resolve()));
  });
}

export function registerRunFile(context: vscode.ExtensionContext): void {
  updateExtsContext();

  const run = (external: boolean) => async (arg?: unknown, multi?: unknown) => {
    if (process.platform !== "win32") {
      vscode.window.showWarningMessage("IPyDesk: ファイルの実行は Windows のみ対応です");
      return;
    }
    const uris = await targets(arg, multi);
    const files = await filesOnly(uris);
    if (files.length === 0) {
      vscode.window.showWarningMessage("IPyDesk: 実行するファイルを選んでください");
      return;
    }
    for (const f of files) {
      await saveIfDirty(vscode.Uri.file(f));
      try {
        if (external) { await openExternally(f); } else { runInTerminal(f); }
        vscode.window.setStatusBarMessage(`IPyDesk: ▶ ${path.basename(f)}`, 3000);
      } catch (e) {
        vscode.window.showErrorMessage(
          `IPyDesk: ${path.basename(f)} を実行できませんでした: ${(e as Error).message}`);
      }
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("ipydesk.runFileInTerminal", run(false)),
    vscode.commands.registerCommand("ipydesk.runFileExternally", run(true)),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration("ipydesk." + EXTRA_EXTS_SETTING)) { updateExtsContext(); }
    }),
  );
}
