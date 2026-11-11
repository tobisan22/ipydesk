/**
 * Python 環境の選択・依存パッケージの入れ方を決める純粋な処理（vscode に依存しない）。
 * 単体テストできるよう、ファイルの有無などは呼び出し側から関数で渡す。
 */
import * as path from "path";

/** どこから決まったインタプリタか（ログ・ツールチップに出す） */
export type PySource = "setting" | "pythonExtension" | "dotVenv" | "default";

export const SOURCE_LABEL: Record<PySource, string> = {
  setting: "設定 ipydesk.pythonPath",
  pythonExtension: "Python 拡張で選択中の環境",
  dotVenv: "ワークスペースの .venv",
  default: "PATH 上の python",
};

/**
 * 設定値のパスを展開する。
 *  - ${workspaceFolder} / ${userHome} を置き換える
 *  - パス区切りを含まない値（"python" など）はコマンド名としてそのまま返す
 *  - 相対パスはワークスペース基準で絶対パスにする（ワークスペースが無ければそのまま）
 */
export function expandPath(raw: string, ws: string | undefined, home: string): string {
  let v = raw.trim();
  if (ws) { v = v.split("${workspaceFolder}").join(ws); }
  v = v.split("${userHome}").join(home);
  if (/^~[\\/]/.test(v)) { v = path.join(home, v.slice(2)); }
  if (!/[\\/]/.test(v)) { return v; }
  if (path.isAbsolute(v) || /^[A-Za-z]:[\\/]/.test(v)) { return v; }
  return ws ? path.resolve(ws, v) : v;
}

/** ワークスペース直下の .venv の python（Windows / それ以外） */
export function dotVenvPython(ws: string, win = process.platform === "win32"): string {
  return win
    ? path.join(ws, ".venv", "Scripts", "python.exe")
    : path.join(ws, ".venv", "bin", "python");
}

/** pyvenv.cfg の中身から、uv で作った venv かどうかを判定する */
export function isUvVenvCfg(cfgText: string | undefined): boolean {
  if (!cfgText) { return false; }
  return /^\s*uv\s*=/m.test(cfgText);
}

/** 2 つのパスが同じ場所か（Windows は大文字小文字・区切り文字を無視） */
export function samePath(a: string, b: string, win = process.platform === "win32"): boolean {
  const n = (p: string) => {
    let s = path.normalize(p).replace(/[\\/]+$/, "");
    if (win) { s = s.replace(/\//g, "\\").toLowerCase(); }
    return s;
  };
  return n(a) === n(b);
}

/**
 * uv プロジェクトの venv か。
 * venv がワークスペース直下の .venv で、同じフォルダに pyproject.toml と uv.lock がある。
 * こうした環境に `uv pip install` で入れたものは、次の `uv sync` で消される。
 */
export function isUvProject(
  prefix: string, ws: string | undefined, exists: (p: string) => boolean,
  win = process.platform === "win32"): boolean {
  if (!ws) { return false; }
  if (!samePath(prefix, path.join(ws, ".venv"), win)) { return false; }
  return exists(path.join(ws, "pyproject.toml")) && exists(path.join(ws, "uv.lock"));
}

/** 不足パッケージの入れ方 */
export type InstallPlan =
  | { kind: "pip" }                                 // <exe> -m pip install
  | { kind: "uv"; uv: string }                      // uv pip install --python <exe>
  | { kind: "uvProject"; uv: string; root: string } // uv add --dev か uv pip install を選ばせる
  | { kind: "none"; uvProject: boolean };           // 入れられない（案内だけ出す）

/**
 * 入れ方を決める。
 *  - uv で作った venv で uv があれば uv を使う（pip と混ぜると uv の管理情報とずれる）
 *  - pip があれば pip
 *  - pip が無くても uv があれば uv
 *  - uv プロジェクトなら、uv があれば選ばせる
 */
export function planInstall(o: {
  hasPip: boolean; uvVenv: boolean; uvProject: boolean; uv: string | undefined; ws: string | undefined;
}): InstallPlan {
  if (o.uvProject && o.uv && o.ws) { return { kind: "uvProject", uv: o.uv, root: o.ws }; }
  if (o.uvVenv && o.uv) { return { kind: "uv", uv: o.uv }; }
  if (o.hasPip) { return { kind: "pip" }; }
  if (o.uv) { return { kind: "uv", uv: o.uv }; }
  return { kind: "none", uvProject: o.uvProject };
}

/** 入れられないときに案内するコマンド */
export function manualInstallCommand(plan: { uvProject: boolean }, exe: string, pkgs: string[]): string {
  return plan.uvProject
    ? `uv add --dev ${pkgs.join(" ")}`
    : `"${exe}" -m ensurepip`;
}

/** uv を探す場所の候補（設定値のあとに PATH を試し、そのあとにこれらを見る） */
export function uvFallbackPaths(home: string, win = process.platform === "win32"): string[] {
  const exe = win ? "uv.exe" : "uv";
  return [path.join(home, ".local", "bin", exe), path.join(home, ".cargo", "bin", exe)];
}
