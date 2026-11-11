import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "path";
import {
  expandPath, dotVenvPython, isUvVenvCfg, samePath, isUvProject, planInstall,
  manualInstallCommand, uvFallbackPaths,
} from "../pyEnvCore";

const WS = path.resolve("/work/proj");
const HOME = path.resolve("/home/me");

test("P-1 expandPath: コマンド名はそのまま", () => {
  assert.equal(expandPath("python", WS, HOME), "python");
  assert.equal(expandPath("  python3 ", WS, HOME), "python3");
});

test("P-2 expandPath: ${workspaceFolder} / ${userHome} / ~ を置き換える", () => {
  assert.equal(expandPath("${workspaceFolder}/.venv/bin/python", WS, HOME), `${WS}/.venv/bin/python`);
  assert.equal(expandPath("${userHome}/py/python", WS, HOME), `${HOME}/py/python`);
  assert.equal(expandPath("~/py/python", WS, HOME), path.join(HOME, "py/python"));
});

test("P-3 expandPath: 相対パスはワークスペース基準、Windows の絶対パスは触らない", () => {
  assert.equal(expandPath(".venv/bin/python", WS, HOME), path.resolve(WS, ".venv/bin/python"));
  assert.equal(expandPath("C:\\Py\\python.exe", WS, HOME), "C:\\Py\\python.exe");
  assert.equal(expandPath(".venv/bin/python", undefined, HOME), ".venv/bin/python");
});

test("P-4 dotVenvPython: Windows は Scripts/python.exe", () => {
  assert.equal(dotVenvPython(WS, true), path.join(WS, ".venv", "Scripts", "python.exe"));
  assert.equal(dotVenvPython(WS, false), path.join(WS, ".venv", "bin", "python"));
});

test("P-5 isUvVenvCfg: uv = の行で判定", () => {
  assert.equal(isUvVenvCfg("home = C:\\Py\nimplementation = CPython\nuv = 0.9.2\n"), true);
  assert.equal(isUvVenvCfg("home = C:\\Py\ninclude-system-site-packages = false\n"), false);
  assert.equal(isUvVenvCfg(undefined), false);
});

test("P-6 samePath: Windows は大文字小文字・区切り・末尾の区切りを無視", () => {
  assert.equal(samePath("C:\\Proj\\.venv\\", "c:/proj/.venv", true), true);
  assert.equal(samePath("/a/b", "/a/B", false), false);
});

test("P-7 isUvProject: ワークスペース直下の .venv + pyproject.toml + uv.lock", () => {
  const files = new Set([path.join(WS, "pyproject.toml"), path.join(WS, "uv.lock")]);
  const ex = (p: string) => files.has(p);
  assert.equal(isUvProject(path.join(WS, ".venv"), WS, ex, false), true);
  assert.equal(isUvProject(path.join(WS, "env"), WS, ex, false), false);
  assert.equal(isUvProject(path.join(WS, ".venv"), WS, p => p.endsWith("pyproject.toml"), false), false);
  assert.equal(isUvProject(path.join(WS, ".venv"), undefined, ex, false), false);
});

test("P-8 planInstall: 優先順位", () => {
  const base = { hasPip: false, uvVenv: false, uvProject: false, uv: undefined as string | undefined, ws: WS };
  assert.deepEqual(planInstall({ ...base, hasPip: true }), { kind: "pip" });
  assert.deepEqual(planInstall({ ...base, hasPip: true, uvVenv: true, uv: "uv" }), { kind: "uv", uv: "uv" });
  assert.deepEqual(planInstall({ ...base, uv: "uv" }), { kind: "uv", uv: "uv" });
  assert.deepEqual(planInstall({ ...base, hasPip: true, uvVenv: true, uvProject: true, uv: "uv" }),
    { kind: "uvProject", uv: "uv", root: WS });
  assert.deepEqual(planInstall({ ...base, uvVenv: true, uvProject: true }), { kind: "none", uvProject: true });
  assert.deepEqual(planInstall({ ...base, hasPip: true, uvVenv: true }), { kind: "pip" });
  assert.deepEqual(planInstall(base), { kind: "none", uvProject: false });
});

test("P-9 manualInstallCommand / uvFallbackPaths", () => {
  assert.equal(manualInstallCommand({ uvProject: true }, "py", ["ipython", "ipdb"]), "uv add --dev ipython ipdb");
  assert.equal(manualInstallCommand({ uvProject: false }, "C:\\a b\\python.exe", ["ipython"]), '"C:\\a b\\python.exe" -m ensurepip');
  assert.deepEqual(uvFallbackPaths(HOME, true),
    [path.join(HOME, ".local", "bin", "uv.exe"), path.join(HOME, ".cargo", "bin", "uv.exe")]);
});
