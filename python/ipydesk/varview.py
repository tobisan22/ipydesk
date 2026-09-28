"""
ipydesk.varview — Variable Editor（MATLAB の「変数エディター」）用に、変数の一部を表で返す。

拡張 → Python の問い合わせはファイルで行う（ほかの通知と同じ方式）:
  1. 拡張がセッションの通知ディレクトリに py_varreq_<id>.json を書く
  2. このモジュールのスレッドが見つけて読み、消す
  3. 答えを py_varres_<id>.json に書く（拡張が読んで消す）

スレッドで答えるので、IPython のプロンプト待ち・ブレークポイントで停止中・計算中の
どれでも応答できる。停止中は、そのフレームの変数を見る（ワークスペースビューと同じ）。

方針:
  - 一度に返すのは表示に要る範囲だけ（行・列の上限あり）。巨大な配列でも軽い
  - 値の中身を書き換えることはしない（読むだけ）
  - どんな値・どんな失敗でもセッションを止めない（例外は答えの error に入れて返す）
"""

from __future__ import annotations

import json
import numbers
import os
import reprlib
import sys
import threading
import time
from pathlib import Path
from typing import Any

REQ_PREFIX = "py_varreq_"  # 拡張 → Python : 問い合わせ
RES_PREFIX = "py_varres_"  # Python → 拡張 : 答え

MAX_ROWS = 1000  # 1 回に返す行数の上限
MAX_COLS = 200  # 1 回に返す列数の上限
MAX_COPY_CELLS = 200_000  # コピー（TSV）で返すセル数の上限
MAX_TEXT = 80  # セル 1 つの表示文字数の上限
POLL_SEC = 0.05

_repr = reprlib.Repr()
_repr.maxstring = MAX_TEXT
_repr.maxother = MAX_TEXT
_repr.maxlist = _repr.maxtuple = 4
_repr.maxdict = 3
_repr.maxlevel = 1


def _clip(s: str) -> str:
    s = " ".join(str(s).split())
    return s if len(s) <= MAX_TEXT else s[: MAX_TEXT - 1] + "…"


# ---- セル 1 つの表示 ------------------------------------------------------------


def fmt(x: Any) -> str:
    """セルに出す文字列。数値は MATLAB の format short g に近い 6 桁"""
    if x is None:
        return "None"
    if isinstance(x, str):
        return _clip(x)
    t = type(x)
    if isinstance(x, bool) or (t.__module__ == "numpy" and t.__name__ in ("bool_", "bool")):
        return "True" if x else "False"
    if isinstance(x, numbers.Integral):
        return str(int(x))
    if isinstance(x, numbers.Real):
        f = float(x)
        if f != f:
            return "NaN"
        if f in (float("inf"), float("-inf")):
            return "Inf" if f > 0 else "-Inf"
        return format(f, ".6g")
    if isinstance(x, numbers.Complex):
        c = complex(x)
        return f"{c.real:.4g}{c.imag:+.4g}j"
    try:
        return _clip(_repr.repr(x))
    except Exception as e:  # 壊れた __repr__
        return f"<{type(e).__name__}>"


# ---- 値の種類と形 ---------------------------------------------------------------


def _mod(v: Any) -> str:
    return (type(v).__module__ or "").split(".")[0]


def _is_numeric_dtype(dt) -> bool:
    import numpy as np

    return bool(np.issubdtype(dt, np.number) or np.issubdtype(dt, np.bool_))


def info(v: Any) -> dict:
    """表としての形。rows × cols の 2 次元に、3 次元目以降は pages として持つ

    kind:
      ndarray   : 0 次元は 1×1、1 次元は n×1（縦に並べる）、3 次元以上は [:, :, k, …]
      dataframe : 行ラベル・列ラベル付き
      series    : n×1、行ラベル付き
      list      : list / tuple。n×1
      scalar    : それ以外。1×1
    """
    cls = type(v).__name__
    base: dict[str, Any] = {"cls": cls, "pages": [], "numeric": False, "labels": False}

    if _mod(v) == "numpy":
        import numpy as np

        if isinstance(v, np.ndarray):
            shape = list(v.shape)
            rows = shape[0] if v.ndim >= 1 else 1
            cols = shape[1] if v.ndim >= 2 else 1
            return {
                **base,
                "kind": "ndarray",
                "cls": f"ndarray {v.dtype}",
                "shape": shape,
                "rows": rows,
                "cols": cols,
                "pages": shape[2:],
                "numeric": _is_numeric_dtype(v.dtype),
            }

    if _mod(v) == "pandas":
        import numpy as np

        if cls == "DataFrame":
            numeric = any(_is_numeric_dtype(dt) for dt in v.dtypes if isinstance(dt, np.dtype))
            return {
                **base,
                "kind": "dataframe",
                "shape": list(v.shape),
                "rows": v.shape[0],
                "cols": v.shape[1],
                "numeric": numeric,
                "labels": True,
            }
        if cls == "Series":
            dt = v.dtype
            return {
                **base,
                "kind": "series",
                "cls": f"Series {dt}",
                "shape": [len(v)],
                "rows": len(v),
                "cols": 1,
                "numeric": isinstance(dt, np.dtype) and _is_numeric_dtype(dt),
                "labels": True,
            }

    if isinstance(v, (list, tuple)):
        numeric = len(v) > 0 and all(
            isinstance(x, numbers.Real) for x in v[:1000]
        )
        return {
            **base,
            "kind": "list",
            "shape": [len(v)],
            "rows": len(v),
            "cols": 1,
            "numeric": numeric,
        }

    return {
        **base,
        "kind": "scalar",
        "shape": [],
        "rows": 1,
        "cols": 1,
        "numeric": isinstance(v, numbers.Number) and not isinstance(v, bool),
    }


def _span(lo: int, hi: int, n: int, cap: int) -> tuple[int, int]:
    lo = max(0, min(int(lo), n))
    hi = max(lo, min(int(hi), n, lo + cap))
    return lo, hi


def block(v: Any, r0: int, r1: int, c0: int, c1: int, page: list[int] | None = None) -> dict:
    """[r0, r1) × [c0, c1) の範囲を文字列の 2 次元リストで返す（範囲は形に合わせて詰める）"""
    inf = info(v)
    kind = inf["kind"]
    r0, r1 = _span(r0, r1, inf["rows"], MAX_ROWS)
    c0, c1 = _span(c0, c1, inf["cols"], MAX_COLS)
    out: dict[str, Any] = {"r0": r0, "r1": r1, "c0": c0, "c1": c1}

    if kind == "ndarray":
        a = v
        if a.ndim == 0:
            cells = [[fmt(a.item())]] if (r1 > r0 and c1 > c0) else []
        elif a.ndim == 1:
            cells = [[fmt(x)] for x in a[r0:r1]] if c1 > c0 else [[] for _ in range(r1 - r0)]
        else:
            idx = tuple(_page_index(page, a.shape[2:]))
            sub = a[(slice(r0, r1), slice(c0, c1)) + idx]
            cells = [[fmt(x) for x in row] for row in sub]
        out["cells"] = cells
        return out

    if kind == "dataframe":
        sub = v.iloc[r0:r1, c0:c1]
        cols = [sub.iloc[:, j].to_numpy(dtype=object) for j in range(sub.shape[1])]
        out["cells"] = [[fmt(col[i]) for col in cols] for i in range(sub.shape[0])]
        out["rowLabels"] = [fmt(x) for x in sub.index]
        out["colLabels"] = [fmt(x) for x in sub.columns]
        return out

    if kind == "series":
        sub = v.iloc[r0:r1]
        vals = sub.to_numpy(dtype=object)
        out["cells"] = [[fmt(x)] if c1 > c0 else [] for x in vals]
        out["rowLabels"] = [fmt(x) for x in sub.index]
        out["colLabels"] = [fmt(v.name) if v.name is not None else "0"]
        return out

    if kind == "list":
        out["cells"] = [[fmt(x)] if c1 > c0 else [] for x in v[r0:r1]]
        return out

    out["cells"] = [[fmt(v)]] if (r1 > r0 and c1 > c0) else []
    return out


def _page_index(page: list[int] | None, dims: list[int] | tuple) -> list[int]:
    """3 次元目以降の添字。範囲外は端に寄せる"""
    page = list(page or [])
    return [max(0, min(int(page[i]) if i < len(page) else 0, n - 1)) for i, n in enumerate(dims)]


def copy_text(v: Any, r0: int, r1: int, c0: int, c1: int, page: list[int] | None = None) -> str:
    """範囲をタブ区切り（Excel に貼れる形）で返す。数値は丸めずに出す"""
    inf = info(v)
    r0, r1 = _span(r0, r1, inf["rows"], MAX_COPY_CELLS)
    c0, c1 = _span(c0, c1, inf["cols"], MAX_COPY_CELLS)
    if (r1 - r0) * max(1, c1 - c0) > MAX_COPY_CELLS:
        raise ValueError(f"コピーできるのは {MAX_COPY_CELLS:,} セルまでです")
    kind = inf["kind"]

    def raw(x):
        if isinstance(x, numbers.Real) and not isinstance(x, (bool, numbers.Integral)):
            return repr(float(x))
        return str(x)

    rows: list[list[Any]]
    if kind == "ndarray":
        if v.ndim == 0:
            rows = [[v.item()]]
        elif v.ndim == 1:
            rows = [[x] for x in v[r0:r1]]
        else:
            idx = tuple(_page_index(page, v.shape[2:]))
            rows = [list(r) for r in v[(slice(r0, r1), slice(c0, c1)) + idx]]
    elif kind == "dataframe":
        rows = v.iloc[r0:r1, c0:c1].to_numpy(dtype=object).tolist()
    elif kind == "series":
        rows = [[x] for x in v.iloc[r0:r1].to_numpy(dtype=object)]
    elif kind == "list":
        rows = [[x] for x in v[r0:r1]]
    else:
        rows = [[v]]
    return "\n".join("\t".join(raw(x) for x in r) for r in rows)


# ---- 問い合わせへの応答 ---------------------------------------------------------


def namespace(shell=None) -> tuple[dict, dict | None, str]:
    """(globals, locals, scope 表示名)。ブレークポイントで停止中ならそのフレーム"""
    from . import core, workspace

    dbg = core.active_debugger
    frame = getattr(dbg, "curframe", None) if dbg is not None else None
    if frame is not None:
        loc = getattr(dbg, "curframe_locals", None)
        if loc is None:
            loc = frame.f_locals
        return frame.f_globals, loc, workspace.frame_scope(frame)[1]
    if shell is None:
        from IPython import get_ipython

        shell = get_ipython()
    ns = shell.user_ns if shell is not None else {}
    return ns, None, "Base（グローバル）"


def resolve(expr: str, shell=None) -> tuple[Any, str]:
    """変数名（または式）を今の名前空間で評価する"""
    g, loc, scope = namespace(shell)
    expr = expr.strip()
    if expr.isidentifier():
        if loc is not None and expr in loc:
            return loc[expr], scope
        if expr in g:
            return g[expr], scope
        raise NameError(f"変数 {expr} はありません（{scope}）")
    return eval(expr, g, loc if loc is not None else g), scope


def handle(req: dict, shell=None) -> dict:
    """1 件の問い合わせに答える。失敗は error に入れて返す"""
    rid = req.get("id")
    try:
        v, scope = resolve(str(req.get("expr", "")), shell)
        res: dict[str, Any] = {"id": rid, "ok": True, "scope": scope, "info": info(v)}
        op = req.get("op", "block")
        page = req.get("page")
        if op == "copy":
            res["text"] = copy_text(v, req["r0"], req["r1"], req["c0"], req["c1"], page)
        elif op == "block":
            res["block"] = block(v, req["r0"], req["r1"], req["c0"], req["c1"], page)
        return res
    except Exception as e:
        return {"id": rid, "ok": False, "error": f"{type(e).__name__}: {e}"}


def _write_atomic(path: Path, data: dict) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    try:
        os.replace(tmp, path)
    except PermissionError:  # Windows で拡張が読んでいる瞬間に当たった
        path.write_text(tmp.read_text(encoding="utf-8"), encoding="utf-8")
        tmp.unlink(missing_ok=True)


def serve_once(folder: Path, shell=None) -> int:
    """届いている問い合わせをすべて処理する。処理した件数を返す"""
    n = 0
    try:
        entries = [e for e in os.scandir(folder)
                   if e.name.startswith(REQ_PREFIX) and e.name.endswith(".json")]
    except OSError:
        return 0
    for e in entries:
        p = Path(e.path)
        try:
            req = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue  # 書きかけ。次の周回で読む
        p.unlink(missing_ok=True)
        rid = str(req.get("id", ""))
        if not rid.replace("_", "").isalnum():
            continue
        _write_atomic(folder / f"{RES_PREFIX}{rid}.json", handle(req, shell))
        n += 1
    return n


_thread: threading.Thread | None = None


def start(folder: Path | None, shell=None) -> None:
    """問い合わせを待つスレッドを起動する（セッションに 1 つ）"""
    global _thread
    if folder is None or _thread is not None:
        return

    def loop():
        while True:
            try:
                serve_once(folder, shell)
            except Exception as e:  # 何があってもスレッドは止めない
                print(f"[ipydesk] Variable Editor の応答に失敗: {e}", file=sys.stderr)
            time.sleep(POLL_SEC)

    _thread = threading.Thread(target=loop, name="ipydesk-varview", daemon=True)
    _thread.start()
