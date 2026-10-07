"""
ipydesk.inject — 赤丸の行に「止まるための関数呼び出し」を埋め込む（注入方式）。

sys.settrace を全体にかけると、関係のない関数呼び出しまで遅くなる。そこで、赤丸の行に
`__ipydesk_bp__(<id>)` を AST で埋め込んでから compile し、その呼び出しに着いた時点で
初めてトレースを入れて対話に入る。止まるまでは素の速度で走る。

  - inject_tree      : AST に呼び出しを埋め込む（行の種類ごとの規則は下を参照）
  - ScriptPlan       : 1 回の実行（スクリプト / セル）の注入計画
  - install / _Finder: import されるファイルの赤丸にも、読み込み時に注入する
  - bp_hit / bp_cond : 埋め込んだ呼び出しの実体（builtins に置く）

埋め込む位置（pdb と同じ動きになるように）:
  ふつうの文・if・with・try・def・class・デコレータ → その文の前
  for / async for の行 → ループ本体の先頭と、else 節の先頭（尽きた判定でも止まる）
  while の行            → 条件を `__ipydesk_bp_cond__(id) and (元の条件)` に置き換える
  複数行の文の 2 行目以降 → その行を含む一番内側の文の前
  空行・コメント・else / except / finally の行 → 次の文
  docstring・`from __future__` の前には入れない（次の文に寄せる）
"""

from __future__ import annotations

import ast
import builtins
import importlib.abc
import importlib.machinery
import json
import os
import sys
from pathlib import Path

BP_NAME = "py_breakpoints.json"  # 拡張 → Python : 赤丸の一覧
NAME_HIT = "__ipydesk_bp__"
NAME_COND = "__ipydesk_bp_cond__"


def canon(path) -> str:
    """赤丸のファイルを突き合わせるための正規化（絶対パス・大文字小文字を畳む）"""
    return os.path.normcase(str(Path(path).resolve()))


class _State:
    dbg = None  # 実行中の VsPdb（None なら埋め込んだ呼び出しは何もしない）
    vscode_dir: Path | None = None  # 赤丸 JSON のある .vscode/
    suppress = False  # 赤丸を無視する実行（--nobp）の間は import 時の注入をしない
    in_find = False


state = _State()

# 埋め込む id ↔ (正規化したファイル, 行)。id はプロセスの間ずっと同じ赤丸に同じ番号
_keys: list[tuple[str, int]] = []
_ids: dict[tuple[str, int], int] = {}

# ファイル → 直近に compile した版で、実際に呼び出しを埋め込んだ赤丸の行。
# ここにある行の赤丸はトレースを使わず、埋め込んだ呼び出しで止まる
injected_by_file: dict[str, set[int]] = {}


def _bp_id(key: tuple[str, int]) -> int:
    i = _ids.get(key)
    if i is None:
        i = _ids[key] = len(_keys)
        _keys.append(key)
    return i


def record_injected(file: str, done: set[int], span: tuple[int, int] | None = None) -> None:
    """compile した結果を覚える。span（セル実行の行範囲）があれば、その範囲だけ置き換える
    （範囲外の関数に前の実行で埋め込んだ呼び出しは、そのまま生きている）"""
    if span is None:
        injected_by_file[file] = set(done)
        return
    old = injected_by_file.get(file, set())
    injected_by_file[file] = {ln for ln in old if not span[0] <= ln <= span[1]} | done


# ---- 赤丸 JSON ------------------------------------------------------------------


def read_bp_file(vscode_dir: Path | None) -> tuple[str, list[dict]]:
    """(mode, 有効な赤丸) を返す。"active": false の間は赤丸が空。

    ファイルの形は {"active": bool, "mode": "inject"|"trace", "breakpoints": [...]}。
    以前の形（赤丸の配列そのまま）も読める。
    """
    if vscode_dir is None:
        return "trace", []
    bp_file = vscode_dir / BP_NAME
    if not bp_file.exists():
        return "trace", []
    raw = json.loads(bp_file.read_text(encoding="utf-8"))
    mode = "trace"
    if isinstance(raw, dict):
        mode = raw.get("mode", "trace")
        if not raw.get("active", True):
            return mode, []
        raw = raw.get("breakpoints", [])
    return mode, [b for b in raw if b.get("enabled", True)]


_file_cache: tuple[tuple | None, dict[str, set[int]]] = (None, {})


def breakpoint_files(vscode_dir: Path | None) -> dict[str, set[int]]:
    """注入する赤丸 {正規化したファイル: {行}}。import のたびに呼ぶので、JSON の更新時刻で覚える"""
    global _file_cache
    if vscode_dir is None:
        return {}
    try:
        st = (vscode_dir / BP_NAME).stat()
        stamp = (st.st_mtime_ns, st.st_size)
    except OSError:
        return {}
    if _file_cache[0] == stamp:
        return _file_cache[1]
    files: dict[str, set[int]] = {}
    try:
        mode, bps = read_bp_file(vscode_dir)
        if mode == "inject":
            for b in bps:
                if str(b.get("file", "")).endswith(".py"):
                    files.setdefault(canon(b["file"]), set()).add(int(b["line"]))
    except (OSError, ValueError, KeyError, TypeError):
        files = {}
    _file_cache = (stamp, files)
    return files


# ---- AST への埋め込み ------------------------------------------------------------


def _loc(node: ast.AST, line: int) -> ast.AST:
    for n in ast.walk(node):
        n.lineno = n.end_lineno = line  # type: ignore[attr-defined]
        n.col_offset, n.end_col_offset = 0, 1  # type: ignore[attr-defined]
    return node


def _call(name: str, bp_id: int, line: int) -> ast.Call:
    return _loc(  # type: ignore[return-value]
        ast.Call(func=ast.Name(id=name, ctx=ast.Load()), args=[ast.Constant(bp_id)], keywords=[]),
        line,
    )


def _stmt_lists(node: ast.AST):
    for _, val in ast.iter_fields(node):
        if isinstance(val, list) and val and isinstance(val[0], ast.stmt):
            yield val


def inject_tree(tree: ast.Module, lines, file: str) -> set[int]:
    """tree に、lines の各行の赤丸の呼び出しを埋め込む。埋め込めた行を返す
    （文の無い行・ファイルの終わりより後ろの行は埋め込めない）"""
    stmts = [n for n in ast.walk(tree) if isinstance(n, ast.stmt)]  # 外側の文が先
    span: dict[int, tuple[int, int]] = {}
    for s in stmts:
        first = min([s.lineno] + [d.lineno for d in getattr(s, "decorator_list", [])])
        span[id(s)] = (first, s.end_lineno)  # type: ignore[attr-defined]
    container: dict[int, list] = {}  # 文 → それを入れているリスト
    owner: dict[int, ast.AST] = {}  # リスト → それを持つノード
    for n in ast.walk(tree):
        for lst in _stmt_lists(n):
            owner[id(lst)] = n
            for s in lst:
                container[id(s)] = lst

    def start(s) -> int:
        return span[id(s)][0]

    def child_start(s) -> int | None:
        """複合文の最初の子（本体の先頭の文・最初の case）の開始行"""
        firsts = [start(lst[0]) for lst in _stmt_lists(s)]
        if isinstance(s, ast.Match):
            firsts.append(s.cases[0].pattern.lineno)
        return min(firsts) if firsts else None

    def next_after(line: int):
        best = None
        for s in stmts:
            if start(s) > line and (best is None or start(s) < start(best)):
                best = s
        return best

    def settle(t):
        """docstring と `from __future__` の前には入れられない — 次の文へ寄せる"""
        while t is not None:
            lst = container[id(t)]
            is_doc = (
                isinstance(t, ast.Expr)
                and isinstance(t.value, ast.Constant)
                and isinstance(t.value.value, str)
                and lst[0] is t
                and isinstance(owner[id(lst)], (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
            )
            is_future = isinstance(t, ast.ImportFrom) and t.module == "__future__"
            if not (is_doc or is_future):
                return t
            t = next_after(span[id(t)][1])
        return None

    done: set[int] = set()
    for line in sorted(lines):
        containing = [s for s in stmts if start(s) <= line <= span[id(s)][1]]
        at = next((s for s in containing if start(s) == line), None)
        header = False
        if at is not None:
            target = at
            header = True
        elif containing:
            s = containing[-1]  # 一番内側
            cs = child_start(s)
            if cs is not None and line < cs:  # 複数行にまたがる見出しの 2 行目以降
                target, header = s, True
            elif cs is not None:  # else: / except: / finally: / 空行 / コメント
                target = next_after(line)
            else:
                target = s
        else:
            target = next_after(line)
        settled = settle(target)
        if settled is None:
            continue
        header = header and settled is target  # 寄せたあとは、見出しの行ではない
        target = settled
        bp_id = _bp_id((file, line))
        cs = child_start(target)
        is_header = header and (cs is None or line < cs)
        if is_header and isinstance(target, (ast.For, ast.AsyncFor)):
            target.body.insert(0, ast.Expr(value=_call(NAME_HIT, bp_id, line)))
            target.orelse.insert(0, ast.Expr(value=_call(NAME_HIT, bp_id, line)))
            _loc(target.body[0], line)
            _loc(target.orelse[0], line)
        elif is_header and isinstance(target, ast.While):
            test = target.test
            cond = ast.BoolOp(op=ast.And(), values=[_call(NAME_COND, bp_id, line), test])
            for a in ("lineno", "end_lineno", "col_offset", "end_col_offset"):
                setattr(cond, a, getattr(test, a))
            target.test = cond
        else:
            lst = container[id(target)]
            lst.insert(lst.index(target), _loc(ast.Expr(value=_call(NAME_HIT, bp_id, line)), line))
        done.add(line)
    ast.fix_missing_locations(tree)
    return done


def _function_lines(full_src: str) -> list[tuple[int, int]]:
    """関数の本体の行範囲（セルの外にある関数の赤丸を見分けるのに使う）"""
    try:
        tree = ast.parse(full_src)
    except SyntaxError:
        return [(1, 10**9)]  # 読めないときは、どの行も関数の中とみなす（安全側＝トレース）
    return [
        (n.body[0].lineno, n.end_lineno)  # type: ignore[attr-defined]
        for n in ast.walk(tree)
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
    ]


class ScriptPlan:
    """1 回の実行（スクリプト全体 / セル）の注入計画。

    lines     : このファイルにある有効な赤丸の行
    bdb_lines : 今回 compile した範囲の外にあるが、関数の中なので前に実行した関数から呼ばれて
                止まり得る赤丸の行（注入できないので、トレースで止める）
    """

    def __init__(self, file: str, lines: set[int]):
        self.file = file
        self.lines = lines
        self.bdb_lines: set[int] = set()

    def compile_script(self, src: str, filename: str):
        if not self.lines:
            record_injected(self.file, set())
            return compile(src, filename, "exec", dont_inherit=True)
        tree = ast.parse(src, filename, "exec")
        record_injected(self.file, inject_tree(tree, self.lines, self.file))
        return compile(tree, filename, "exec", dont_inherit=True)

    def apply_range(self, mod: ast.Module, start: int, end: int, full_src: str | None) -> None:
        """セル実行: 範囲の中の赤丸を埋め込み、範囲の外の関数の赤丸は bdb_lines に回す"""
        inside = {ln for ln in self.lines if start <= ln <= end}
        record_injected(self.file, inject_tree(mod, inside, self.file), (start, end))
        outside = self.lines - inside
        if outside and full_src is not None:
            funcs = _function_lines(full_src)
            self.bdb_lines = {ln for ln in outside if any(a <= ln <= b for a, b in funcs)}


def make_plan(vscode_dir: Path | None, script: Path, use_breakpoints: bool) -> ScriptPlan:
    file = canon(script)
    lines: set[int] = set()
    if use_breakpoints:
        mode, bps = read_bp_file(vscode_dir)
        if mode == "inject":
            lines = {int(b["line"]) for b in bps if canon(b["file"]) == file}
    return ScriptPlan(file, lines)


# ---- 止まる処理（builtins に置く）--------------------------------------------------


def bp_hit(bp_id: int) -> None:
    """埋め込んだ `__ipydesk_bp__(id)` の実体。有効な赤丸なら呼び出し元のフレームで止まる"""
    dbg = state.dbg
    if dbg is not None:
        dbg.inject_hit(_keys[bp_id], sys._getframe(1))


def bp_cond(bp_id: int) -> bool:
    """while の条件の前に置く `__ipydesk_bp_cond__(id)`。止まるかを確かめて、常に True を返す"""
    dbg = state.dbg
    if dbg is not None:
        dbg.inject_hit(_keys[bp_id], sys._getframe(1))
    return True


builtins.__ipydesk_bp__ = bp_hit  # type: ignore[attr-defined]
builtins.__ipydesk_bp_cond__ = bp_cond  # type: ignore[attr-defined]


# ---- import 時の注入 --------------------------------------------------------------


class _InjectLoader(importlib.machinery.SourceFileLoader):
    """赤丸のあるファイルを読み込むとき、AST に注入してから compile する。
    注入したコードを .pyc に残さないよう、キャッシュは読まない・書かない"""

    def get_code(self, fullname):
        path = self.get_filename(fullname)
        return self.source_to_code(self.get_data(path), path)

    def source_to_code(self, data, path, *, _optimize=-1):
        key = canon(path)
        lines = set() if state.suppress else breakpoint_files(state.vscode_dir).get(key, set())
        if not lines:
            injected_by_file[key] = set()
            return compile(data, path, "exec", dont_inherit=True, optimize=_optimize)
        tree = ast.parse(data, path, "exec")
        injected_by_file[key] = inject_tree(tree, lines, key)
        return compile(tree, path, "exec", dont_inherit=True, optimize=_optimize)


class _Finder(importlib.abc.MetaPathFinder):
    """ほかの Finder に探させ、見つかったファイルに赤丸があれば Loader を差し替える。
    入れっぱなしにするのは、autoreload が実行の前（pre_run_cell）にモジュールを読み直すため。
    赤丸が無ければ、何もせず素通りする"""

    def find_spec(self, name, path=None, target=None):
        if state.in_find:
            return None
        files = breakpoint_files(state.vscode_dir)
        if not files and not injected_by_file:
            return None
        state.in_find = True
        try:
            spec = None
            for finder in sys.meta_path:
                if finder is self or not hasattr(finder, "find_spec"):
                    continue
                spec = finder.find_spec(name, path, target)
                if spec is not None:
                    break
        finally:
            state.in_find = False
        if spec is None:
            return None
        loader = spec.loader
        if type(loader) is importlib.machinery.SourceFileLoader and str(spec.origin).endswith(".py"):
            key = canon(spec.origin)
            if (key in files and not state.suppress) or key in injected_by_file:
                spec.loader = _InjectLoader(loader.name, loader.path)
        return spec


def install(vscode_dir: Path | None) -> None:
    """赤丸 JSON の場所を決め、import 時の注入を有効にする（何度呼んでもよい）。
    trace 方式の間は Finder を入れない（実行のたびに呼ばれるので、inject に切り替えた次の実行で入る）"""
    state.vscode_dir = vscode_dir
    if read_bp_file(vscode_dir)[0] != "inject":
        return
    if not any(isinstance(f, _Finder) for f in sys.meta_path):
        sys.meta_path.insert(0, _Finder())
