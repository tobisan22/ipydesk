import { test } from "node:test";
import * as assert from "node:assert/strict";
import { parse, serialize, keyFor, lookup, list, add, edit, remove, LIMIT, ArgFile } from "../argList";

const ok = (t: string): ArgFile => {
  const r = parse(t);
  assert.ok(r.ok);
  return (r as { ok: true; data: ArgFile }).data;
};

test("U-1 parse: 正しい JSON / version 省略は 1", () => {
  assert.deepEqual(ok('{"version":1,"scripts":{"a.py":["x"]}}').scripts, { "a.py": ["x"] });
  assert.equal(ok('{"scripts":{}}').version, 1);
});

test("U-2 parse: 構文エラー・version 2・scripts が配列", () => {
  assert.equal(parse("{").ok, false);
  assert.equal(parse('{"version":2,"scripts":{}}').ok, false);
  assert.equal(parse('{"scripts":[]}').ok, false);
});

test("U-3 parse: 文字列以外・空文字を捨て、改行は空白", () => {
  const d = ok('{"scripts":{"a.py":["", 1, null, "a\\nb", "  "]}}');
  assert.deepEqual(d.scripts["a.py"], ["a b"]);
});

test("U-4 serialize: 書式・空配列のキー削除・順序保持", () => {
  const s = serialize({ version: 1, scripts: { z: ["1"], e: [], a: ["2"] } });
  assert.equal(s, '{\n  "version": 1,\n  "scripts": {\n    "z": [\n      "1"\n    ],\n    "a": [\n      "2"\n    ]\n  }\n}\n');
});

test("U-5 keyFor", () => {
  assert.equal(keyFor("C:\\w\\sim\\a.py", "C:\\w", true), "sim/a.py");
  assert.equal(keyFor("D:\\x\\b.py", "C:\\w", true), "D:\\x\\b.py");
  assert.equal(keyFor("C:\\x\\b.py", "C:\\w", true), "C:\\x\\b.py");
  assert.equal(keyFor("/r/x/b.py", "/r/w", false), "/r/x/b.py");
});

test("U-6 lookup: 大文字小文字を区別しない", () => {
  const d: ArgFile = { version: 1, scripts: { "Sim/A.py": ["x"] } };
  assert.equal(lookup(d, "sim/a.py", true), "Sim/A.py");
  assert.deepEqual(list(d, "sim/a.py", true), ["x"]);
  assert.equal(lookup(d, "sim/a.py", false), undefined);
});

test("U-7 add: 先頭追加・既存は位置不変・trim", () => {
  assert.deepEqual(add(["a", "b"], "  c ").list, ["c", "a", "b"]);
  assert.deepEqual(add(["a", "b"], "b").list, ["a", "b"]);
});

test("U-8 add: 上限", () => {
  const ten = Array.from({ length: LIMIT }, (_, i) => String(i));
  assert.deepEqual(add(ten, "n").list, ["n", ...ten.slice(0, LIMIT - 1)]);
  assert.deepEqual(add(ten, "n", "9").list, ["n", ...ten.slice(0, 8), "9"].filter(x => x !== "8"));
  const thirteen = Array.from({ length: 13 }, (_, i) => String(i));
  assert.equal(add(thirteen, "n").list.length, LIMIT);
});

test("U-9 edit", () => {
  assert.deepEqual(edit(["a", "b", "c"], "b", "x"), ["a", "x", "c"]);
  assert.deepEqual(edit(["a", "b", "c"], "b", "c"), ["a", "c"]);
});

test("U-10 remove", () => {
  assert.deepEqual(remove(["a", "b"], "a"), ["b"]);
  assert.deepEqual(remove(["a", "b"], "z"), ["a", "b"]);
});

test("U-11 往復", () => {
  const d: ArgFile = { version: 1, scripts: { "a.py": ['--in "C:\\data\\a b.csv"', "日本語 'x'"] } };
  assert.deepEqual(ok(serialize(d)), d);
});
