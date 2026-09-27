"""
ipydesk.workspace — ワークスペースビュー（MATLAB の「ワークスペース」）用に、
名前空間の変数を要約して .vscode/py_workspace.json に書き出す。

書き出すタイミング:
  - IPython のセルが終わるたび（F5 / セル実行 / プロンプトで打った 1 行も含む）
  - ブレークポイント・ステップで停止したとき（そのフレームのローカル変数）

方針:
  - 表示用の要約だけを作る。値そのものは送らない
  - 要約は軽く保つ。巨大な配列の min/max や、重い repr は避ける
  - どんな変数があってもセッションを止めない（例外はすべて握りつぶす）
  - 展開は 1 段だけ（dict の要素・list の要素・オブジェクトの属性）
"""

from __future__ import annotations

import inspect
import json
import os
import reprlib
import sys
import warnings
from pathlib import Path
from typing import Any

WORKSPACE_NAME = "py_workspace.json"  # Python → 拡張 : 変数一覧

MAX_VARS = 500  # 1 画面に出す変数の上限
MAX_KIDS = 50  # 展開したときに出す要素数の上限
MAX_TEXT = 120  # 値の表示文字数の上限
MINMAX_LIMIT = 1_000_000  # これを超える配列は min/max を計算しない

# IPython が名前空間に置く変数のうち、user_ns_hidden で隠れないもの
_IPY_NAMES = {"In", "Out", "exit", "quit", "get_ipython"}

_repr = reprlib.Repr()
_repr.maxstring = MAX_TEXT
_repr.maxother = MAX_TEXT
_repr.maxlist = _repr.maxtuple = _repr.maxset = _repr.maxfrozenset = 6
_repr.maxdict = 4
_repr.maxlevel = 2

# スコープごとの前回スナップショット（変更マークの判定用）
_previous: dict[str, dict[str, tuple]] = {}
_seq = 0


def _clip(s: str) -> str:
    s = " ".join(s.split())  # 改行を潰して 1 行にする
    return s if len(s) <= MAX_TEXT else s[: MAX_TEXT - 1] + "…"


def _num(x: Any) -> str:
    try:
        return format(x, ".4g")
    except (TypeError, ValueError):
        return str(x)


# ---- 表示する変数の選別 ---------------------------------------------------------


def is_visible(name: str, value: Any) -> bool:
    """モジュール・関数・クラスと、_ 始まりの変数は出さない（MATLAB と同じくデータだけ）"""
    if name.startswith("_") or name in _IPY_NAMES:
        return False
    return not (
        inspect.ismodule(value)
        or inspect.isclass(value)
        or inspect.isroutine(value)  # 関数・メソッド・組み込み関数
    )


# ---- 1 つの値の要約 -------------------------------------------------------------


def _ndarray(v) -> tuple[str, str, str]:
    import numpy as np

    cls = f"ndarray {v.dtype}"
    if v.ndim == 0:
        return _num(v.item()), "1×1", cls
    size = "×".join(str(n) for n in v.shape)
    if v.size == 0:
        return "[]", size, cls
    if v.ndim == 1 and v.size <= 6:
        return _clip(np.array2string(v, separator=", ", precision=4)), size, cls
    numeric = np.issubdtype(v.dtype, np.number) and not np.issubdtype(
        v.dtype, np.complexfloating
    )
    if v.ndim == 1:
        head = ", ".join(_num(x) for x in v[:3])
        return _clip(f"[{head}, … {_num(v[-1])}]"), size, cls
    if numeric and v.size <= MINMAX_LIMIT:
        with warnings.catch_warnings(), np.errstate(all="ignore"):
            warnings.simplefilter("ignore")
            lo, hi = np.nanmin(v), np.nanmax(v)
        return f"min {_num(lo)} … max {_num(hi)}", size, cls
    return _clip(f"[{', '.join(_num(x) for x in v.flat[:3])}, …]"), size, cls


def describe(v: Any) -> tuple[str, str, str]:
    """(値, サイズ, クラス) の表示用文字列を返す"""
    t = type(v)
    cls = t.__name__
    mod = t.__module__ or ""

    if v is None:
        return "None", "", "NoneType"
    if isinstance(v, (bool, int, float, complex)):
        return _num(v) if isinstance(v, float) else repr(v), "1×1", cls
    if isinstance(v, (str, bytes, bytearray)):
        return _clip(_repr.repr(v)), str(len(v)), cls

    if mod.startswith("numpy"):
        import numpy as np

        if isinstance(v, np.ndarray):
            return _ndarray(v)
        if isinstance(v, np.generic):
            return _num(v.item()), "1×1", cls

    if mod.startswith("pandas"):
        shape = getattr(v, "shape", None)
        if cls == "DataFrame":
            cols = ", ".join(str(c) for c in list(v.columns[:8]))
            more = " …" if len(v.columns) > 8 else ""
            return _clip(cols + more), f"{shape[0]}×{shape[1]}", cls
        if cls == "Series":
            return _clip(_repr.repr(list(v.head(4)))), str(len(v)), f"Series {v.dtype}"

    if isinstance(v, dict):
        keys = ", ".join(_clip(_repr.repr(k)) for k in list(v)[:6])
        more = ", …" if len(v) > 6 else ""
        return _clip("{" + keys + more + "}"), f"{len(v)} keys", cls
    if isinstance(v, (list, tuple, set, frozenset)):
        return _clip(_repr.repr(v)), str(len(v)), cls

    # その他のオブジェクト。__repr__ を自前で持つものだけ呼ぶ（既定の repr はアドレスで役に立たない）
    shape = getattr(v, "shape", None)
    size = "×".join(str(n) for n in shape) if _is_shape(shape) else ""
    if t.__repr__ is not object.__repr__:
        # reprlib は例外をアドレス表示に化かすので、ここは repr を直接呼ぶ（例外は _safe_describe へ）
        return _clip(repr(v)), size, cls
    return f"<{cls}>", size, cls


def _is_shape(s: Any) -> bool:
    return isinstance(s, tuple) and all(isinstance(n, int) for n in s)


def _safe_describe(v: Any) -> tuple[str, str, str]:
    try:
        return describe(v)
    except Exception as e:  # 壊れた __repr__ などでビューを止めない
        return f"<表示できません: {type(e).__name__}>", "", type(v).__name__


# ---- 1 段の展開 -----------------------------------------------------------------


def children(v: Any) -> tuple[list[tuple[str, Any]], int] | None:
    """展開できる値なら ((名前, 値) のリスト, 残り件数) を返す。展開できなければ None"""
    if isinstance(v, dict):
        items = [(_clip(_repr.repr(k)), x) for k, x in list(v.items())[:MAX_KIDS]]
        return items, max(0, len(v) - MAX_KIDS)
    if isinstance(v, (list, tuple)):
        if not v:
            return None
        items = [(f"[{i}]", x) for i, x in enumerate(v[:MAX_KIDS])]
        return items, max(0, len(v) - MAX_KIDS)
    t = type(v)
    if (t.__module__ or "").split(".")[0] in ("numpy", "pandas", "builtins", "matplotlib"):
        return None  # 配列・表・Figure などは中身を属性として並べても読めない
    attrs = getattr(v, "__dict__", None)
    if not isinstance(attrs, dict):
        return None
    items = [(k, x) for k, x in attrs.items() if is_visible(k, x)]
    if not items:
        return None
    return items[:MAX_KIDS], max(0, len(items) - MAX_KIDS)


# ---- スナップショット -----------------------------------------------------------


def snapshot(ns: dict, hidden: dict | set | None = None, scope: str = "base") -> list[dict]:
    """ns の変数一覧を作る。前回の同じスコープと比べて new / chg の印を付ける"""
    hidden = hidden or ()
    names = sorted(
        (n for n, v in list(ns.items()) if n not in hidden and is_visible(n, v)),
        key=str.lower,
    )[:MAX_VARS]

    prev = _previous.get(scope)
    now: dict[str, tuple] = {}
    out = []
    for name in names:
        v = ns[name]
        value, size, cls = _safe_describe(v)
        now[name] = (value, size, cls)
        mark = ""
        if prev is not None:
            if name not in prev:
                mark = "new"
            elif prev[name] != now[name]:
                mark = "chg"
        item: dict[str, Any] = {"name": name, "value": value, "size": size, "cls": cls, "mark": mark}
        try:
            kids = children(v)
        except Exception:
            kids = None
        if kids:
            item["kids"] = [
                dict(zip(("name", "value", "size", "cls"), (k, *_safe_describe(x))))
                for k, x in kids[0]
            ]
            if kids[1]:
                item["more"] = kids[1]
        out.append(item)
    _previous[scope] = now
    return out


def write(
    vscode_dir: Path | None,
    ns: dict,
    *,
    hidden: dict | set | None = None,
    scope: str = "base",
    label: str = "Base（グローバル）",
    where: str | None = None,
) -> None:
    """変数一覧を .vscode/py_workspace.json に書く。失敗してもセッションは止めない"""
    global _seq
    if vscode_dir is None:
        return
    try:
        _seq += 1
        data = {
            "seq": _seq,
            "scope": label,
            "stopped": where is not None,
            "where": where,
            "vars": snapshot(ns, hidden, scope),
        }
        target = vscode_dir / WORKSPACE_NAME
        tmp = vscode_dir / (WORKSPACE_NAME + ".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        # 拡張が読んでいる最中に半端な内容を見せないよう、置き換えで書く
        try:
            os.replace(tmp, target)
        except PermissionError:  # Windows で拡張が開いている瞬間に当たった
            target.write_text(tmp.read_text(encoding="utf-8"), encoding="utf-8")
            tmp.unlink(missing_ok=True)
    except Exception as e:
        print(f"[ipydesk] workspace の書き出しに失敗: {e}", file=sys.stderr)


def frame_scope(frame) -> tuple[str, str, str]:
    """停止中のフレームから (scope キー, 表示名, 場所) を作る"""
    code = frame.f_code
    name = getattr(code, "co_qualname", code.co_name)  # 3.11+ は Class.method まで出る
    where = f"{Path(code.co_filename).name}:{frame.f_lineno}"
    if code.co_name == "<module>":
        return "base", "Base（グローバル）", where
    return f"{code.co_filename}::{name}", f"{name}（ローカル）", where
