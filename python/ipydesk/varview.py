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
import sys
import threading
import time
from pathlib import Path
from typing import Any

from . import workspace

REQ_PREFIX = "py_varreq_"  # 拡張 → Python : 問い合わせ
RES_PREFIX = "py_varres_"  # Python → 拡張 : 答え

MAX_ROWS = 1000  # 1 回に返す行数の上限
MAX_COLS = 200  # 1 回に返す列数の上限
MAX_COPY_CELLS = 200_000  # コピー（TSV）で返すセル数の上限
MAX_TEXT = 80  # セル 1 つの表示文字数の上限
MAX_FULL_TEXT = 2000  # 高くした行（full）のセル 1 つの表示文字数の上限。改行は残す
MAX_CELL_TEXT = 100_000  # インスペクタ（op cell）で返す文字数の上限
MAX_LABELS = 10_000  # collabels で返す列名の数の上限
MAX_STATS_CELLS = 20_000_000  # 統計（op stats）で読むセル数の上限
POLL_SEC = 0.05

STALE_SEC = 60  # 拡張がタイムアウトで諦めた答え（拾われない py_varres_*）を消すまでの秒数

_repr = workspace.SafeRepr()
_repr.maxstring = MAX_TEXT
_repr.maxother = MAX_TEXT
_repr.maxlist = _repr.maxtuple = 4
_repr.maxdict = 3
_repr.maxlevel = 1

# 高くした行（full）の repr。表のセルに収まる程度に広げる
_repr_full = workspace.SafeRepr()
_repr_full.maxstring = _repr_full.maxother = MAX_FULL_TEXT
_repr_full.maxlist = _repr_full.maxtuple = 50
_repr_full.maxdict = 30
_repr_full.maxlevel = 3

# インスペクタ（op cell）の repr。全文を見るためのものなので大きく取る
_repr_cell = workspace.SafeRepr()
_repr_cell.maxstring = _repr_cell.maxother = MAX_CELL_TEXT
_repr_cell.maxlist = _repr_cell.maxtuple = _repr_cell.maxset = 1000
_repr_cell.maxdict = 500
_repr_cell.maxlevel = 6


def _clip(s: str) -> str:
    s = " ".join(str(s).split())
    return s if len(s) <= MAX_TEXT else s[: MAX_TEXT - 1] + "…"


def _clip_full(s: str) -> str:
    """改行を残したまま MAX_FULL_TEXT で切る（折り返し表示用）"""
    s = str(s).replace("\r\n", "\n").replace("\r", "\n")
    return s if len(s) <= MAX_FULL_TEXT else s[: MAX_FULL_TEXT - 1] + "…"


# ---- セル 1 つの表示 ------------------------------------------------------------


def fmt(x: Any, full: bool = False) -> str:
    """セルに出す文字列。数値は MATLAB の format short g に近い 6 桁

    full=True は高くした行（折り返して表示する行）用。文字列の改行を残し、上限を広げる
    """
    if x is None:
        return "None"
    if isinstance(x, str):
        return _clip_full(x) if full else _clip(x)
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
        return _clip_full(_repr_full.repr(x)) if full else _clip(_repr.repr(x))
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

    if _mod(v) == "numpy" or _is_xr(v):
        import numpy as np

        if isinstance(v, np.ndarray) or _is_xr(v):
            a = _arr(v)
            shape = list(a.shape)
            rows = shape[0] if a.ndim >= 1 else 1
            cols = shape[1] if a.ndim >= 2 else 1
            if 0 in shape[2:]:  # 3 次元目以降に大きさ 0 の軸: 選べるページが無いので空の表
                rows = 0
            out = {
                **base,
                "kind": "ndarray",
                "cls": f"{'DataArray' if _is_xr(v) else 'ndarray'} {a.dtype}",
                "shape": shape,
                "ndim": a.ndim,
                "rows": rows,
                "cols": cols,
                "pages": shape[2:],
                "numeric": _is_numeric_dtype(a.dtype),
                "dims": None,
                "coords": None,
            }
            if _is_xr(v):
                out["xr"] = True
                out["dims"], out["coords"] = _xr_labels(v)
            return out

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
                "rowLevels": int(v.index.nlevels),
                "colLevels": int(v.columns.nlevels),
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
                "rowLevels": int(v.index.nlevels),
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


# ---- xarray.DataArray（入っていれば。import はしない） ----------------------------------


def _is_xr(v: Any) -> bool:
    return _mod(v) == "xarray" and type(v).__name__ == "DataArray"


def _arr(v: Any):
    """配列の中身（DataArray は .values）"""
    if _is_xr(v):
        import numpy as np

        return np.asarray(v.values)
    return v


MAX_COORDS = 1000  # 座標を見出しに使う軸の長さの上限


def _xr_labels(v: Any) -> tuple[list[str], dict[str, list[str]]]:
    """軸の名前と、短い軸の座標（見出し用）。座標の無い・長い軸は入れない"""
    dims = [str(d) for d in v.dims]
    coords: dict[str, list[str]] = {}
    for k, d in enumerate(v.dims):
        try:
            if d in v.coords and v.shape[k] <= MAX_COORDS:
                c = v.coords[d]
                coords[str(k)] = [fmt(x) for x in getattr(c, "values", c)]
        except Exception:
            pass
    return dims, coords


# ---- 多次元配列の見え方（ビュー） ---------------------------------------------------


def _norm_view(view: dict, shape: tuple) -> tuple[int, list[int], dict[int, int]]:
    """ビュー {row, cols, fix} を確かめて正規化する。固定の番号は負なら後ろから、範囲外は端へ"""
    nd = len(shape)
    try:
        row = int(view["row"])
        cols = [int(c) for c in view["cols"]]
        fix = {int(k): int(x) for k, x in (view.get("fix") or {}).items()}
    except (KeyError, TypeError, ValueError) as e:
        raise ValueError("ビューの指定が正しくありません") from e
    if not cols or sorted([row, *cols, *fix]) != list(range(nd)):
        raise ValueError("ビューの指定が正しくありません（行 1 つ・列 1 つ以上・残りは固定）")
    for k, x in fix.items():
        n = shape[k]
        x = x + n if x < 0 else x
        fix[k] = max(0, min(x, n - 1))
    return row, cols, fix


class _Nd:
    """配列を表（行 × 列）として読む。3 次元以上は view（行・列・固定）か page で 2 次元にする

    view では、固定の軸を整数で切り出し（コピーなし）、行の軸を先頭・列の軸を後ろへ並べ替え
    （これもコピーなし）、列の軸が 2 つ以上なら C 順で 1 列に並べる。取り出すときは
    表示する範囲の添字だけを作るので、コピーは表示ブロックぶんだけ。
    """

    def __init__(self, a, page: list[int] | None = None, view: dict | None = None):
        import numpy as np

        self.view = False
        if a.ndim == 0:
            b = a.reshape(1, 1)
        elif a.ndim == 1:
            b = a.reshape(-1, 1)
        elif a.ndim == 2:
            b = a
        elif view:
            row, cols, fix = _norm_view(view, a.shape)
            self.view = True
            if any(a.shape[k] == 0 for k in fix):
                b = np.empty((0, 1), dtype=a.dtype)
            else:
                b = a[tuple(fix.get(k, slice(None)) for k in range(a.ndim))]
                rest = [k for k in range(a.ndim) if k not in fix]
                b = b.transpose([rest.index(row)] + [rest.index(c) for c in cols])
        elif 0 in a.shape[2:]:
            b = np.empty((0, a.shape[1]), dtype=a.dtype)
        else:
            b = a[(slice(None), slice(None)) + tuple(_page_index(page, a.shape[2:]))]
        self.b = b
        self.colshape = tuple(b.shape[1:])
        self.rows = int(b.shape[0])
        self.cols = int(np.prod(self.colshape)) if self.colshape else 1

    def get(self, r0: int, r1: int, c0: int, c1: int):
        """[r0, r1) × [c0, c1) の 2 次元配列"""
        import numpy as np

        sub = self.b[r0:r1]
        if len(self.colshape) == 1:
            return sub[:, c0:c1]
        ci = np.unravel_index(np.arange(c0, c1), self.colshape)
        return sub[(slice(None),) + tuple(ci)]

    def item(self, r: int, c: int):
        import numpy as np

        ci = np.unravel_index(c, self.colshape) if len(self.colshape) > 1 else (c,)
        return self.b[(r,) + tuple(int(i) for i in ci)]


def block(v: Any, r0: int, r1: int, c0: int, c1: int, page: list[int] | None = None,
          full: list[int] | None = None, view: dict | None = None) -> dict:
    """[r0, r1) × [c0, c1) の範囲を文字列の 2 次元リストで返す（範囲は形に合わせて詰める）

    full: 行番号のリスト。その行のセルは改行を残し、上限を MAX_FULL_TEXT に広げる
    （Variable Editor で高くした行。折り返して表示する）
    view: 3 次元以上の配列の見え方 {row, cols, fix}。指定したら答えに view: True を付ける
    """
    inf = info(v)
    kind = inf["kind"]
    nd = _Nd(_arr(v), page, view) if kind == "ndarray" else None
    nrows, ncols = (nd.rows, nd.cols) if nd else (inf["rows"], inf["cols"])
    r0, r1 = _span(r0, r1, nrows, MAX_ROWS)
    c0, c1 = _span(c0, c1, ncols, MAX_COLS)
    out: dict[str, Any] = {"r0": r0, "r1": r1, "c0": c0, "c1": c1}
    fullset = {int(r) for r in (full or ()) if r0 <= int(r) < r1}
    if fullset:
        out["full"] = sorted(fullset)

    def row(r: int, xs) -> list[str]:
        f = r in fullset
        return [fmt(x, f) for x in xs]

    if nd is not None:
        if nd.view:
            out.update(view=True, vrows=nd.rows, vcols=nd.cols)
        sub = nd.get(r0, r1, c0, c1)
        out["cells"] = [row(r0 + i, xs) for i, xs in enumerate(sub)]
        return out

    if kind == "dataframe":
        sub = v.iloc[r0:r1, c0:c1]
        cols = [sub.iloc[:, j].to_numpy(dtype=object) for j in range(sub.shape[1])]
        out["cells"] = [row(r0 + i, [col[i] for col in cols]) for i in range(sub.shape[0])]
        out["rowLabels"] = [fmt(x) for x in sub.index]
        out["colLabels"] = [fmt(x) for x in sub.columns]
        if sub.index.nlevels > 1:
            out["rowLevels"] = _levels(sub.index)
        if sub.columns.nlevels > 1:
            out["colLevels"] = _levels(sub.columns)
        return out

    if kind == "series":
        sub = v.iloc[r0:r1]
        vals = sub.to_numpy(dtype=object)
        out["cells"] = [row(r0 + i, [x]) if c1 > c0 else [] for i, x in enumerate(vals)]
        out["rowLabels"] = [fmt(x) for x in sub.index]
        out["colLabels"] = [fmt(v.name) if v.name is not None else "0"]
        if sub.index.nlevels > 1:
            out["rowLevels"] = _levels(sub.index)
        return out

    if kind == "list":
        out["cells"] = [row(r0 + i, [x]) if c1 > c0 else [] for i, x in enumerate(v[r0:r1])]
        return out

    out["cells"] = [row(0, [v])] if (r1 > r0 and c1 > c0) else []
    return out


def _levels(idx) -> list[list[str]]:
    """MultiIndex の段ごとのラベル（[段][番号]）"""
    return [[fmt(t[k]) for t in idx] for k in range(idx.nlevels)]


def collabels(v: Any) -> dict:
    """列名の一覧（列幅を列名で覚えるため）。上限を超えたら labels は None

    列が MultiIndex なら levels（段ごとのラベル）も返す。labels はタプル全体の文字列
    """
    inf = info(v)
    if inf["kind"] == "dataframe":
        n = v.shape[1]
        if n > MAX_LABELS:
            return {"labels": None, "count": n}
        out = {"labels": [fmt(x) for x in v.columns], "count": n}
        if v.columns.nlevels > 1:
            out["levels"] = _levels(v.columns)
        return out
    if inf["kind"] == "series":
        return {"labels": [fmt(v.name) if v.name is not None else "0"], "count": 1}
    return {"labels": None, "count": inf["cols"]}


# ---- 選択範囲の統計（op stats） ---------------------------------------------------


def _jnum(x: Any) -> Any:
    """JSON に出せる数値。NaN は None、±Inf は文字列"""
    f = float(x)
    if f != f:
        return None
    if f in (float("inf"), float("-inf")):
        return "Inf" if f > 0 else "-Inf"
    return f


def _dims(v: Any, inf: dict, page, view) -> tuple[Any, int, int]:
    """(_Nd か None, 行数, 列数)。配列はビュー・ページを当てた表の大きさ"""
    if inf["kind"] == "ndarray":
        nd = _Nd(_arr(v), page, view)
        return nd, nd.rows, nd.cols
    return None, inf["rows"], inf["cols"]


def _stats_data(v: Any, r0: int, r1: int, c0: int, c1: int, page: list[int] | None,
                view: dict | None = None):
    """統計に使う値（ndarray）と、数値の列数・全列数。数値が無ければ値は None"""
    import numpy as np

    inf = info(v)
    kind = inf["kind"]
    nd, nrows, ncols = _dims(v, inf, page, view)
    r0, r1 = _span(r0, r1, nrows, MAX_STATS_CELLS)
    c0, c1 = _span(c0, c1, ncols, MAX_STATS_CELLS)
    all_cols = c1 - c0
    if (r1 - r0) * max(1, all_cols) > MAX_STATS_CELLS:
        raise ValueError(f"統計を計算できるのは {MAX_STATS_CELLS:,} セルまでです")
    if r1 <= r0 or c1 <= c0:
        return None, 0, all_cols

    def num(a):
        a = np.asarray(a)
        return a if _is_numeric_dtype(a.dtype) else None

    if nd is not None:
        a = num(nd.get(r0, r1, c0, c1))
        return a, (all_cols if a is not None else 0), all_cols
    if kind == "dataframe":
        sub = v.iloc[r0:r1, c0:c1]
        keep = [j for j, dt in enumerate(sub.dtypes) if isinstance(dt, np.dtype) and _is_numeric_dtype(dt)]
        if not keep:
            return None, 0, all_cols
        dts = [sub.dtypes.iloc[j] for j in keep]
        if all(np.issubdtype(dt, np.bool_) for dt in dts):
            target = bool
        elif any(np.issubdtype(dt, np.complexfloating) for dt in dts):
            target = complex
        else:
            target = float
        return sub.iloc[:, keep].to_numpy(dtype=target), len(keep), all_cols
    if kind == "series":
        dt = v.dtype
        if not (isinstance(dt, np.dtype) and _is_numeric_dtype(dt)):
            return None, 0, all_cols
        return v.iloc[r0:r1].to_numpy(), 1, 1
    if kind == "list":
        xs = v[r0:r1]
        if not all(isinstance(x, numbers.Number) for x in xs):
            return None, 0, all_cols
        a = np.asarray(xs)
        return (a, 1, 1) if _is_numeric_dtype(a.dtype) else (None, 0, all_cols)
    if isinstance(v, numbers.Number):
        return np.asarray([v]), 1, 1
    return None, 0, all_cols


def stats(v: Any, r0: int, r1: int, c0: int, c1: int, page: list[int] | None = None,
          view: dict | None = None) -> dict:
    """選択範囲の統計。std は N−1（MATLAB の std と同じ）"""
    import numpy as np

    a, num_cols, all_cols = _stats_data(v, r0, r1, c0, c1, page, view)
    out: dict[str, Any] = {"numCols": num_cols, "allCols": all_cols}
    if a is None or a.size == 0:
        out["kind"] = "none"
        return out
    out["n"] = int(a.size)
    if np.issubdtype(a.dtype, np.bool_):
        out["kind"] = "bool"
        out["true"] = int(np.count_nonzero(a))
        return out
    if np.issubdtype(a.dtype, np.complexfloating):
        out["kind"] = "complex"
        with np.errstate(all="ignore"):
            m = np.nanmean(a) if a.size else complex("nan")
            absmax = np.nanmax(np.abs(a)) if a.size else float("nan")
        out["mean"] = [_jnum(m.real), _jnum(m.imag)]
        out["absmax"] = _jnum(absmax)
        return out
    out["kind"] = "real"
    f = a.astype(np.float64, copy=False)   # 整数は float64 で集計する（合計のあふれを避ける）
    nan = int(np.count_nonzero(np.isnan(f)))
    inf = int(np.count_nonzero(np.isinf(f)))
    out["nan"], out["inf"] = nan, inf
    if nan == f.size:
        out.update(min=None, max=None, mean=None, std=None)
        return out
    import warnings

    with np.errstate(all="ignore"), warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        out["min"] = _jnum(np.nanmin(f))
        out["max"] = _jnum(np.nanmax(f))
        out["mean"] = _jnum(np.nanmean(f))
        out["std"] = _jnum(np.nanstd(f, ddof=1)) if f.size - nan > 1 else None
    return out


# ---- セル 1 つの全文（インスペクタ、op cell） -----------------------------------------


def _element(v: Any, r: int, c: int, page: list[int] | None, view: dict | None = None) -> Any:
    inf = info(v)
    nd, nrows, ncols = _dims(v, inf, page, view)
    if not (0 <= r < nrows and 0 <= c < ncols):
        raise IndexError(f"範囲外です（{r}, {c}）")
    kind = inf["kind"]
    if nd is not None:
        return nd.item(r, c)
    if kind == "dataframe":
        return v.iat[r, c]
    if kind == "series":
        return v.iat[r]
    if kind == "list":
        return v[r]
    return v


def cell(v: Any, r: int, c: int, page: list[int] | None = None, view: dict | None = None) -> dict:
    """セル 1 つの値を丸めずに返す（文字列は全文、数値は repr）"""
    x = _element(v, int(r), int(c), page, view)
    t = type(x)
    tname = t.__name__ if t.__module__ in ("builtins", None) else f"{t.__module__.split('.')[0]}.{t.__name__}"
    if _mod(x) == "numpy" and isinstance(x, numbers.Number):
        x = x.item()   # np.int64(23) ではなく 23 と出す（型は tname に残す）
    if isinstance(x, str):
        text = x
    elif isinstance(x, numbers.Real) and not isinstance(x, numbers.Integral):
        text = repr(float(x))
    elif isinstance(x, numbers.Complex) and not isinstance(x, numbers.Real):
        text = repr(complex(x))
    else:
        try:
            text = _repr_cell.repr(x)
        except Exception as e:  # 壊れた __repr__
            text = f"<{type(e).__name__}>"
    cut = len(text) > MAX_CELL_TEXT
    return {"text": text[:MAX_CELL_TEXT], "type": tname, "len": len(x) if isinstance(x, str) else None,
            "cut": cut}


def _page_index(page: list[int] | None, dims: list[int] | tuple) -> list[int]:
    """3 次元目以降の添字。範囲外は端に寄せる"""
    page = list(page or [])
    return [max(0, min(int(page[i]) if i < len(page) else 0, n - 1)) for i, n in enumerate(dims)]


def copy_text(v: Any, r0: int, r1: int, c0: int, c1: int, page: list[int] | None = None,
              view: dict | None = None) -> str:
    """範囲をタブ区切り（Excel に貼れる形）で返す。数値は丸めずに出す"""
    inf = info(v)
    nd, nrows, ncols = _dims(v, inf, page, view)
    r0, r1 = _span(r0, r1, nrows, MAX_COPY_CELLS)
    c0, c1 = _span(c0, c1, ncols, MAX_COPY_CELLS)
    if (r1 - r0) * max(1, c1 - c0) > MAX_COPY_CELLS:
        raise ValueError(f"コピーできるのは {MAX_COPY_CELLS:,} セルまでです")
    kind = inf["kind"]

    def raw(x):
        if isinstance(x, numbers.Real) and not isinstance(x, (bool, numbers.Integral)):
            return repr(float(x))
        return str(x)

    rows: list[list[Any]]
    if nrows == 0:
        rows = []
    elif nd is not None:
        rows = [list(r) for r in nd.get(r0, r1, c0, c1)]
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


BUSY_MESSAGE = "実行中のため表示できません（止まるか、実行が終わると表示します）"


def handle(req: dict, shell=None) -> dict:
    """1 件の問い合わせに答える。失敗は error に入れて返す。

    値を読むのは、セッションがプロンプト待ち・ブレークポイントで停止中のときだけ。
    スクリプトの実行中に別スレッドから DataFrame などを読むと、書き換えの途中の
    中身を読む（例外・壊れた値）うえ、停止フレームの変数を実行再開と同時に読む
    競合も起きる。core.ns_lock で、メインスレッドが再開する前に読み終えるようにする。
    """
    from . import core

    rid = req.get("id")
    with core.ns_lock:
        if not core.ns_ready:
            return {"id": rid, "ok": False, "error": BUSY_MESSAGE, "transient": True}
        with workspace.display_limits():
            return _handle(req, shell)


def _handle(req: dict, shell=None) -> dict:
    rid = req.get("id")
    try:
        v, scope = resolve(str(req.get("expr", "")), shell)
        res: dict[str, Any] = {"id": rid, "ok": True, "scope": scope, "info": info(v)}
        op = req.get("op", "block")
        page = req.get("page")
        view = req.get("view")
        if op == "copy":
            res["text"] = copy_text(v, req["r0"], req["r1"], req["c0"], req["c1"], page, view)
        elif op == "block":
            res["block"] = block(v, req["r0"], req["r1"], req["c0"], req["c1"], page, req.get("full"), view)
        elif op == "collabels":
            res.update(collabels(v))
        elif op == "stats":
            res["stats"] = stats(v, req["r0"], req["r1"], req["c0"], req["c1"], page, view)
        elif op == "cell":
            res["cell"] = cell(v, req["r"], req["c"], page, view)
        else:
            raise ValueError(f"知らない op です: {op}")
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
        all_entries = list(os.scandir(folder))
    except OSError:
        return 0
    entries = [e for e in all_entries
               if e.name.startswith(REQ_PREFIX) and e.name.endswith(".json")]
    _remove_stale(e for e in all_entries if e.name.startswith(RES_PREFIX))
    for e in entries:
        p = Path(e.path)
        try:
            req = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue  # 書きかけ。次の周回で読む
        try:
            p.unlink(missing_ok=True)
        except OSError:  # Windows: ウイルス対策・OneDrive が開いている瞬間。次の周回で読み直す
            continue
        rid = str(req.get("id", ""))
        if not rid.replace("_", "").isalnum():
            continue
        _write_atomic(folder / f"{RES_PREFIX}{rid}.json", handle(req, shell))
        n += 1
    return n


def _remove_stale(entries) -> None:
    """拡張がタイムアウトで諦めて拾わなかった答えを消す（OneDrive 等の同期対象に溜めない）"""
    now = time.time()
    for e in entries:
        try:
            if now - e.stat().st_mtime > STALE_SEC:
                os.unlink(e.path)
        except OSError:
            pass


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
