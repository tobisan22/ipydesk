/**
 * スクリプト引数の履歴（.vscode/ipydesk_args.json）の一覧操作。
 * vscode を import しない純粋な関数だけにして、Node だけでテストできるようにする。
 */
import * as path from "path";

/** ipydesk_args.json の中身 */
export interface ArgFile {
  version: number;
  scripts: Record<string, string[]>;
}

/** 1 スクリプトあたりの上限（UI から追加したときだけ効く） */
export const LIMIT = 10;

export type ParseResult = { ok: true; data: ArgFile } | { ok: false; error: string };

const clean = (s: string): string => s.replace(/[\r\n]+/g, " ").trim();

/** JSON として読み、正規化する。読めなければ ok:false */
export function parse(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ""));
  } catch (e) {
    return { ok: false, error: `JSON の構文エラー: ${(e as Error).message}` };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "最上位がオブジェクトではありません" };
  }
  const o = raw as Record<string, unknown>;
  const version = o.version === undefined ? 1 : o.version;
  if (typeof version !== "number" || !Number.isFinite(version)) {
    return { ok: false, error: "version が数値ではありません" };
  }
  if (version >= 2) {
    return { ok: false, error: `version ${version} には対応していません` };
  }
  const sc = o.scripts;
  if (typeof sc !== "object" || sc === null || Array.isArray(sc)) {
    return { ok: false, error: "scripts がオブジェクトではありません" };
  }
  const scripts: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(sc as Record<string, unknown>)) {
    if (!Array.isArray(v)) { continue; }
    const items: string[] = [];
    for (const x of v) {
      if (typeof x !== "string") { continue; }
      const s = clean(x);
      if (s && !items.includes(s)) { items.push(s); }
    }
    scripts[k] = items;
  }
  return { ok: true, data: { version: 1, scripts } };
}

/** 1-1 の書式で文字列にする。空配列のキーは消す。キーの順番は保つ */
export function serialize(data: ArgFile): string {
  const scripts: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(data.scripts)) {
    if (v.length > 0) { scripts[k] = v; }
  }
  return JSON.stringify({ version: 1, scripts }, null, 2) + "\n";
}

/** ワークスペース内ならルートからの相対パス（/ 区切り）、外なら絶対パス */
export function keyFor(file: string, root: string | undefined,
  win: boolean = process.platform === "win32"): string {
  const p = win ? path.win32 : path.posix;
  if (!root) { return file; }
  const rel = p.relative(root, file);
  if (rel === "" || rel.startsWith("..") || p.isAbsolute(rel)) { return file; }
  return rel.split(p.sep).join("/");
}

/** 照合に使う形（Windows では小文字） */
export function norm(key: string, win: boolean = process.platform === "win32"): string {
  return win ? key.toLowerCase() : key;
}

/** 大文字小文字を区別せず（Windows）、ファイル上のキーを返す */
export function lookup(data: ArgFile, key: string,
  win: boolean = process.platform === "win32"): string | undefined {
  if (Object.prototype.hasOwnProperty.call(data.scripts, key)) { return key; }
  const n = norm(key, win);
  return Object.keys(data.scripts).find(k => norm(k, win) === n);
}

/** そのスクリプトの一覧（無ければ []） */
export function list(data: ArgFile, key: string,
  win: boolean = process.platform === "win32"): string[] {
  const k = lookup(data, key, win);
  return k === undefined ? [] : data.scripts[k];
}

/**
 * 追加。すでにあれば位置を変えない。無ければ先頭に入れる。
 * 上限を超えたら末尾から見て選択中でない最初の 1 件を、超えた分だけ消す
 */
export function add(l: string[], args: string, selected?: string):
  { list: string[]; removed?: string[] } {
  const a = clean(args);
  if (!a || l.includes(a)) { return { list: l }; }
  const out = [a, ...l];
  const removed: string[] = [];
  while (out.length > LIMIT) {
    let i = out.length - 1;
    while (i >= 0 && (out[i] === selected || out[i] === a)) { i--; }
    if (i < 0) { break; }
    removed.push(out.splice(i, 1)[0]);
  }
  return removed.length ? { list: out, removed } : { list: out };
}

/** old の位置を next に置き換える。next がほかと同じなら old を消すだけ */
export function edit(l: string[], old: string, next: string): string[] {
  const n = clean(next);
  const i = l.indexOf(old);
  if (i < 0 || !n || n === old) { return l; }
  if (l.includes(n)) { return l.filter(x => x !== old); }
  const out = l.slice();
  out[i] = n;
  return out;
}

export function remove(l: string[], args: string): string[] {
  return l.includes(args) ? l.filter(x => x !== args) : l;
}
