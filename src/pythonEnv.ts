/**
 * Python 環境の取得（Python 拡張連携・uv の検出）。
 *
 * Python 拡張（ms-python.python）は必須にしない。入っていれば、その exports の
 * environments API で「右下で選んでいる環境」を取る。npm の @vscode/python-extension は
 * 使わず、必要な型だけをここに書く（runtime の依存を増やさず tsc だけでビルドするため）。
 */
import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import { execFile } from "child_process";
import { expandPath, uvFallbackPaths } from "./pyEnvCore";

const PY_EXT_ID = "ms-python.python";
const ACTIVATE_TIMEOUT_MS = 5000;

interface EnvPath { id: string; path: string }
interface PyEnvApi {
  environments: {
    getActiveEnvironmentPath(resource?: vscode.Uri | vscode.WorkspaceFolder): EnvPath;
    resolveEnvironment(env: EnvPath | string):
      Promise<{ executable: { uri?: vscode.Uri } } | undefined>;
    onDidChangeActiveEnvironmentPath: vscode.Event<{ id: string; path: string; resource?: vscode.WorkspaceFolder }>;
  };
}

const timeout = <T>(p: Thenable<T>, ms: number): Promise<T | "timeout"> =>
  Promise.race([Promise.resolve(p), new Promise<"timeout">(r => setTimeout(() => r("timeout"), ms))]);

let apiCache: PyEnvApi | undefined;

/** Python 拡張の API。入っていない・起動しない・形が違うときは理由を返す */
async function pyApi(): Promise<PyEnvApi | { reason: string }> {
  if (apiCache) { return apiCache; }
  const ext = vscode.extensions.getExtension<PyEnvApi>(PY_EXT_ID);
  if (!ext) { return { reason: "Python 拡張が入っていない" }; }
  try {
    const r = ext.isActive ? ext.exports : await timeout(ext.activate(), ACTIVATE_TIMEOUT_MS);
    if (r === "timeout") { return { reason: `Python 拡張の起動が ${ACTIVATE_TIMEOUT_MS / 1000} 秒で終わらない` }; }
    if (!r?.environments?.getActiveEnvironmentPath) { return { reason: "Python 拡張に environments API が無い" }; }
    apiCache = r;
    return r;
  } catch (e) {
    return { reason: `Python 拡張の起動に失敗: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Python 拡張で選択中の環境の python。取れなければ reason */
export async function pythonFromExtension(resource?: vscode.Uri):
  Promise<{ exe: string } | { reason: string }> {
  const api = await pyApi();
  if ("reason" in api) { return api; }
  try {
    const envPath = api.environments.getActiveEnvironmentPath(resource);
    if (!envPath?.path) { return { reason: "Python 拡張で環境が選ばれていない" }; }
    const env = await timeout(api.environments.resolveEnvironment(envPath), ACTIVATE_TIMEOUT_MS);
    if (env === "timeout") { return { reason: "環境の解決が終わらない" }; }
    const exe = env?.executable.uri?.fsPath;
    return exe ? { exe } : { reason: `環境を解決できない（${envPath.path}）` };
  } catch (e) {
    return { reason: `環境の取得に失敗: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * 右下の環境が切り替わったら呼ぶ。Python 拡張が無ければ何もしない。
 * 拡張の起動を待たずに返し、購読は API が取れたあとで張る。
 */
export function onPythonEnvChange(cb: () => void): vscode.Disposable {
  let sub: vscode.Disposable | undefined;
  let disposed = false;
  if (vscode.extensions.getExtension(PY_EXT_ID)) {
    void pyApi().then(api => {
      if (disposed || "reason" in api) { return; }
      sub = api.environments.onDidChangeActiveEnvironmentPath(() => cb());
    });
  }
  return new vscode.Disposable(() => { disposed = true; sub?.dispose(); });
}

const runs = (exe: string): Promise<boolean> =>
  new Promise(resolve => {
    execFile(exe, ["--version"], { windowsHide: true, timeout: 5000 }, err => resolve(!err));
  });

let uvCache: { key: string; uv: string | undefined } | undefined;

/**
 * uv を探す。設定 ipydesk.uvPath → PATH 上の uv → ~/.local/bin → ~/.cargo/bin の順。
 * 拡張ホストの PATH にはインストーラが足した ~/.local/bin が入っていないことがある。
 * 結果は設定値ごとにキャッシュする。
 */
export async function findUv(configured: string, ws: string | undefined): Promise<string | undefined> {
  const home = os.homedir();
  const key = configured.trim();
  if (uvCache && uvCache.key === key) { return uvCache.uv; }
  const candidates = [
    ...(key ? [expandPath(key, ws, home)] : []),
    "uv",
    ...uvFallbackPaths(home),
  ];
  let found: string | undefined;
  for (const c of candidates) {
    if (c !== "uv" && !fs.existsSync(c)) { continue; }
    if (await runs(c)) { found = c; break; }
  }
  uvCache = { key, uv: found };
  return found;
}
