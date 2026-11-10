"""Variable Editor（ipydesk.varview）の回帰テスト

表としての形・範囲の切り出し・停止中のフレームの参照・ファイル経由の応答を固定する。
"""

import json

import numpy as np
import pandas as pd
import pytest

from ipydesk import core, varview, workspace


class Shell:
    def __init__(self, ns):
        self.user_ns = ns


def test_ndarray_shapes():
    i = varview.info(np.zeros((3, 4)))
    assert (i["kind"], i["rows"], i["cols"], i["pages"]) == ("ndarray", 3, 4, [])
    assert i["numeric"] and i["cls"] == "ndarray float64"
    i = varview.info(np.arange(5))
    assert (i["rows"], i["cols"]) == (5, 1), "1 次元は縦に並べる"
    i = varview.info(np.zeros((2, 3, 4, 5)))
    assert (i["rows"], i["cols"], i["pages"]) == (2, 3, [4, 5])
    assert not varview.info(np.array(["a", "b"]))["numeric"]


def test_block_is_clamped_and_formatted():
    a = np.arange(12, dtype=float).reshape(3, 4) / 3
    b = varview.block(a, 1, 99, 2, 99)
    assert (b["r0"], b["r1"], b["c0"], b["c1"]) == (1, 3, 2, 4)
    assert b["cells"] == [["2", "2.33333"], ["3.33333", "3.66667"]]


def test_block_pages_select_trailing_dims():
    a = np.arange(24).reshape(2, 3, 4)
    b = varview.block(a, 0, 2, 0, 3, page=[2])
    assert b["cells"] == [[str(x) for x in row] for row in a[:, :, 2]]
    b = varview.block(a, 0, 1, 0, 1, page=[99])
    assert b["cells"] == [[str(a[0, 0, 3])]], "範囲外のページは端に寄せる"


def test_special_values():
    b = varview.block(np.array([np.nan, np.inf, -np.inf, 1e-9, True]), 0, 5, 0, 1)
    assert [r[0] for r in b["cells"]] == ["NaN", "Inf", "-Inf", "1e-09", "1"]
    assert varview.fmt(np.bool_(True)) == "True"
    assert varview.fmt(1 + 2j) == "1+2j"


def test_dataframe_has_labels():
    df = pd.DataFrame({"t": [0.0, 0.1, 0.2], "name": ["a", "b", "c"]}, index=[10, 11, 12])
    i = varview.info(df)
    assert (i["kind"], i["rows"], i["cols"], i["labels"], i["numeric"]) == ("dataframe", 3, 2, True, True)
    b = varview.block(df, 1, 3, 0, 2)
    assert b["cells"] == [["0.1", "b"], ["0.2", "c"]]
    assert b["rowLabels"] == ["11", "12"] and b["colLabels"] == ["t", "name"]


def test_series_and_list():
    s = pd.Series([1.5, 2.5], name="v")
    b = varview.block(s, 0, 2, 0, 1)
    assert b["cells"] == [["1.5"], ["2.5"]] and b["colLabels"] == ["v"]
    i = varview.info([1, 2.5, 3])
    assert (i["kind"], i["rows"], i["numeric"]) == ("list", 3, True)
    assert not varview.info(["a", 1])["numeric"]


def test_copy_text_keeps_full_precision():
    a = np.array([[1 / 3, 2], [3, 4]], dtype=float)
    t = varview.copy_text(a, 0, 2, 0, 2)
    assert t.split("\n")[0].split("\t")[0] == repr(1 / 3)
    assert t.count("\n") == 1


def test_resolve_names_and_expressions():
    shell = Shell({"x": np.arange(4), "d": {"k": [1, 2]}})
    assert varview.handle({"id": "1", "expr": "x", "r0": 0, "r1": 2, "c0": 0, "c1": 1}, shell)[
        "block"
    ]["cells"] == [["0"], ["1"]]
    r = varview.handle({"id": "2", "expr": "d['k']", "r0": 0, "r1": 9, "c0": 0, "c1": 9}, shell)
    assert r["ok"] and r["info"]["rows"] == 2
    r = varview.handle({"id": "3", "expr": "nope", "r0": 0, "r1": 1, "c0": 0, "c1": 1}, shell)
    assert not r["ok"] and "NameError" in r["error"]


def test_stopped_frame_locals_win(monkeypatch):
    class Dbg:
        pass

    def f():
        y = np.ones(3)  # noqa: F841
        import sys

        return sys._getframe()

    dbg = Dbg()
    dbg.curframe = f()
    dbg.curframe_locals = dbg.curframe.f_locals
    monkeypatch.setattr(core, "active_debugger", dbg)
    r = varview.handle({"id": "4", "expr": "y", "r0": 0, "r1": 3, "c0": 0, "c1": 1}, Shell({}))
    assert r["ok"] and r["info"]["rows"] == 3 and "ローカル" in r["scope"]


def test_serve_once_answers_via_files(tmp_path):
    (tmp_path / "py_varreq_ab1.json").write_text(
        json.dumps({"id": "ab1", "expr": "x", "r0": 0, "r1": 1, "c0": 0, "c1": 1}), encoding="utf-8"
    )
    assert varview.serve_once(tmp_path, Shell({"x": [7]})) == 1
    assert not (tmp_path / "py_varreq_ab1.json").exists(), "問い合わせは消す"
    res = json.loads((tmp_path / "py_varres_ab1.json").read_text(encoding="utf-8"))
    assert res["block"]["cells"] == [["7"]]


def test_workspace_marks_openable():
    workspace._previous.clear()
    got = {v["name"]: v for v in workspace.snapshot(
        {"a": np.zeros(3), "s": np.float64(1.0), "n": 3, "L": [1, 2], "d": {"k": np.ones(2)}}
    )}
    assert got["a"].get("open") and got["L"].get("open")
    assert not got["s"].get("open") and not got["n"].get("open")
    assert got["d"]["kids"][0].get("open"), "展開した子も開ける"


# ---- 0.1.9: 行の高さ（full）・列名・統計・インスペクタ ----------------------------------


def test_block_full_keeps_newlines_and_raises_limit():
    long = "a" * 500
    df = pd.DataFrame({"s": ["line1\nline2", long, "x\r\ny"]})
    b = varview.block(df, 0, 3, 0, 1)
    assert b["cells"][0] == ["line1 line2"], "既定では改行を詰める"
    assert len(b["cells"][1][0]) == varview.MAX_TEXT
    b = varview.block(df, 0, 3, 0, 1, full=[0, 1, 2, 99])
    assert b["full"] == [0, 1, 2], "範囲外の行番号は無視する"
    assert b["cells"][0] == ["line1\nline2"]
    assert b["cells"][1] == [long]
    assert b["cells"][2] == ["x\ny"]
    b = varview.block(["p\nq", "r\ns"], 0, 2, 0, 1, full=[1])
    assert b["cells"] == [["p q"], ["r\ns"]], "full の行だけ"


def test_full_text_is_still_capped():
    b = varview.block(["z" * 5000], 0, 1, 0, 1, full=[0])
    assert len(b["cells"][0][0]) == varview.MAX_FULL_TEXT


def test_zero_length_page_axis_is_empty():
    a = np.zeros((3, 2, 0))
    i = varview.info(a)
    assert (i["rows"], i["shape"]) == (0, [3, 2, 0])
    assert varview.block(a, 0, 10, 0, 10)["cells"] == []
    assert varview.copy_text(a, 0, 10, 0, 10) == ""


def test_collabels():
    df = pd.DataFrame({"time": [1.0], "alt_m": [2.0]})
    assert varview.collabels(df) == {"labels": ["time", "alt_m"], "count": 2}
    assert varview.collabels(pd.Series([1], name="x"))["labels"] == ["x"]
    assert varview.collabels(np.zeros((2, 3))) == {"labels": None, "count": 3}
    wide = pd.DataFrame(np.zeros((1, varview.MAX_LABELS + 1)))
    assert varview.collabels(wide)["labels"] is None, "上限を超えたら列番号で覚える"


def test_stats_real_matches_numpy():
    rng = np.random.default_rng(0)
    a = rng.normal(size=(100, 5))
    a[3, 1] = np.nan
    a[4, 2] = np.inf
    s = varview.stats(a, 10, 60, 1, 4)
    sub = a[10:60, 1:4]
    assert s["kind"] == "real" and s["n"] == sub.size
    assert (s["nan"], s["inf"]) == (0, 0)
    assert s["min"] == pytest.approx(np.nanmin(sub))
    assert s["mean"] == pytest.approx(np.nanmean(sub))
    assert s["std"] == pytest.approx(np.nanstd(sub, ddof=1)), "std は N−1"
    s = varview.stats(a, 0, 10, 0, 5)
    assert (s["nan"], s["inf"], s["max"], s["mean"]) == (1, 1, "Inf", "Inf")
    json.dumps(s, allow_nan=False)   # NaN・Inf は JSON に出せる形


def test_stats_special_kinds():
    s = varview.stats(np.array([[True, False], [True, True]]), 0, 2, 0, 2)
    assert (s["kind"], s["n"], s["true"]) == ("bool", 4, 3)
    s = varview.stats(np.array([1 + 1j, 3 - 1j]), 0, 2, 0, 1)
    assert s["kind"] == "complex" and s["mean"] == [2.0, 0.0] and s["absmax"] == pytest.approx(10 ** 0.5)
    s = varview.stats(np.full((2, 2), np.nan), 0, 2, 0, 2)
    assert s["nan"] == 4 and s["mean"] is None
    assert varview.stats(np.zeros((3, 3)), 1, 1, 0, 3)["kind"] == "none", "空の選択"
    assert varview.stats(np.array(["a", "b"]), 0, 2, 0, 1)["kind"] == "none"
    s = varview.stats(np.arange(10, dtype=np.int64) * 10**17, 0, 10, 0, 1)
    assert s["mean"] == pytest.approx(4.5e17), "整数は float64 で集計"


def test_stats_dataframe_uses_numeric_columns_only():
    df = pd.DataFrame({"a": [1.0, 2.0, 3.0], "s": ["x", "y", "z"], "b": [4, 5, 6]})
    s = varview.stats(df, 0, 3, 0, 3)
    assert (s["numCols"], s["allCols"], s["n"]) == (2, 3, 6)
    assert s["max"] == 6.0
    assert varview.stats(df, 0, 3, 1, 2)["kind"] == "none"


def test_stats_pages_and_limit(monkeypatch):
    a = np.arange(24, dtype=float).reshape(2, 3, 4)
    s = varview.stats(a, 0, 2, 0, 3, page=[1])
    assert s["min"] == 1.0 and s["max"] == 21.0
    monkeypatch.setattr(varview, "MAX_STATS_CELLS", 5)
    with pytest.raises(ValueError):
        varview.stats(a, 0, 2, 0, 3, page=[1])


def test_cell_returns_full_value():
    df = pd.DataFrame({"s": ["x" * 300 + "\nend"], "f": [0.1 + 0.2]})
    c = varview.cell(df, 0, 0)
    assert c["text"].endswith("\nend") and c["len"] == 304 and c["type"] == "str"
    assert varview.cell(df, 0, 1)["text"] == repr(0.1 + 0.2)
    assert varview.cell([[1, 2, [3]]], 0, 0)["text"] == "[1, 2, [3]]"
    assert varview.cell(np.arange(24).reshape(2, 3, 4), 1, 2, page=[3])["text"] == "23"
    with pytest.raises(IndexError):
        varview.cell(df, 5, 0)


def test_handle_new_ops_and_unknown(monkeypatch):
    monkeypatch.setattr(core, "ns_ready", True)
    sh = Shell({"df": pd.DataFrame({"a": [1.0, 2.0]})})
    r = varview.handle({"id": "1", "op": "collabels", "expr": "df"}, sh)
    assert r["ok"] and r["labels"] == ["a"]
    r = varview.handle({"id": "2", "op": "stats", "expr": "df", "r0": 0, "r1": 2, "c0": 0, "c1": 1}, sh)
    assert r["ok"] and r["stats"]["mean"] == 1.5
    r = varview.handle({"id": "3", "op": "cell", "expr": "df", "r": 1, "c": 0}, sh)
    assert r["ok"] and r["cell"]["text"] == "2.0"
    r = varview.handle({"id": "4", "op": "nope", "expr": "df"}, sh)
    assert not r["ok"] and "op" in r["error"]


def test_workspace_total_counts_before_limit(tmp_path, monkeypatch):
    monkeypatch.setattr(workspace, "MAX_VARS", 3)
    workspace.write(tmp_path, {f"v{i}": i for i in range(5)})
    data = json.loads((tmp_path / workspace.WORKSPACE_NAME).read_text(encoding="utf-8"))
    assert len(data["vars"]) == 3 and data["total"] == 5


# ---- 0.2.0: 多次元配列のビュー・xarray・MultiIndex -----------------------------------------


def _cells(b):
    return [[float(x) for x in row] for row in b["cells"]]


@pytest.mark.parametrize("shape", [(5, 3, 3), (3, 3, 7), (2, 3, 4, 5), (2, 2, 3, 2, 2)])
def test_view_block_matches_numpy(shape):
    rng = np.random.default_rng(1)
    a = rng.integers(0, 1000, size=shape).astype(float)
    nd = a.ndim
    for row in range(nd):
        rest = [k for k in range(nd) if k != row]
        for ncols in range(1, nd):
            cols = rest[:ncols]
            fix = {k: -1 if k % 2 else 1 for k in rest[ncols:]}
            fix = {k: (x if a.shape[k] > 1 else 0) for k, x in fix.items()}
            view = {"row": row, "cols": cols, "fix": {str(k): x for k, x in fix.items()}}
            idx = tuple(fix.get(k, slice(None)) for k in range(nd))
            sub = a[idx]
            rem = [k for k in range(nd) if k not in fix]
            want = sub.transpose([rem.index(row)] + [rem.index(c) for c in cols]).reshape(a.shape[row], -1)
            b = varview.block(a, 0, 999, 0, 999, view=view)
            assert b["view"] is True and (b["vrows"], b["vcols"]) == want.shape
            got = np.array(_cells(b)) if want.size else np.zeros(want.shape)
            assert np.array_equal(got, np.round(want, 0)), (row, cols, fix)
            # 一部の範囲
            b = varview.block(a, 1, 3, 1, 4, view=view)
            assert np.array_equal(np.array(_cells(b)).reshape(-1), want[1:3, 1:4].reshape(-1))


def test_view_dcm_time_series():
    R = np.arange(10001 * 9, dtype=float).reshape(10001, 3, 3)
    b = varview.block(R, 7, 8, 0, 9, view={"row": 0, "cols": [1, 2], "fix": {}})
    assert _cells(b)[0][4] == R[7, 1, 1], "セル [t, 4] は R[t, 1, 1]"
    M = np.moveaxis(R, 0, 2)    # (3, 3, 10001)
    b = varview.block(M, 7, 8, 0, 9, view={"row": 2, "cols": [0, 1], "fix": {}})
    assert _cells(b)[0] == list(R[7].reshape(-1)), "MATLAB 流の並びでも同じ見え方"


def test_view_noncontiguous_and_empty():
    a = np.arange(4 * 5 * 6, dtype=float).reshape(4, 5, 6)[:, ::2, ::-1]
    b = varview.block(a, 0, 99, 0, 99, view={"row": 2, "cols": [0, 1], "fix": {}})
    assert np.array_equal(np.array(_cells(b)), a.transpose(2, 0, 1).reshape(6, -1))
    e = np.zeros((3, 0, 2))
    b = varview.block(e, 0, 9, 0, 9, view={"row": 0, "cols": [2], "fix": {"1": 0}})
    assert b["cells"] == [] and b["vrows"] == 0


def test_view_is_validated():
    a = np.zeros((2, 3, 4))
    for bad in ({"row": 0, "cols": [], "fix": {"1": 0, "2": 0}}, {"row": 0, "cols": [1]},
                {"row": 0, "cols": [0, 1], "fix": {"2": 0}}, {"cols": [1, 2]}):
        with pytest.raises(ValueError):
            varview.block(a, 0, 2, 0, 2, view=bad)


def test_view_stats_copy_cell():
    a = np.arange(2 * 3 * 4, dtype=float).reshape(2, 3, 4)
    view = {"row": 2, "cols": [0, 1], "fix": {}}
    t = a.transpose(2, 0, 1).reshape(4, 6)
    s = varview.stats(a, 1, 3, 2, 5, view=view)
    assert s["n"] == 6 and s["max"] == t[1:3, 2:5].max()
    assert varview.copy_text(a, 0, 1, 0, 6, view=view) == "\t".join(repr(float(x)) for x in t[0])
    assert varview.cell(a, 3, 5, view=view)["text"] == repr(float(t[3, 5]))


def test_view_handle_marks_response(monkeypatch):
    monkeypatch.setattr(core, "ns_ready", True)
    sh = Shell({"R": np.zeros((4, 3, 3))})
    r = varview.handle({"id": "1", "op": "block", "expr": "R", "r0": 0, "r1": 4, "c0": 0, "c1": 9,
                        "view": {"row": 0, "cols": [1, 2], "fix": {}}}, sh)
    assert r["ok"] and r["block"]["view"] and len(r["block"]["cells"][0]) == 9
    assert r["info"]["ndim"] == 3 and r["info"]["dims"] is None


class _FakeCoord:
    def __init__(self, values):
        self.values = np.asarray(values)


class DataArray:
    """xarray を入れずに試すための最小の DataArray"""

    def __init__(self, values, dims, coords):
        self.values = np.asarray(values)
        self.dims = tuple(dims)
        self.coords = {k: _FakeCoord(v) for k, v in coords.items()}
        self.shape = self.values.shape
        self.ndim = self.values.ndim
        self.dtype = self.values.dtype


DataArray.__module__ = "xarray.core.dataarray"


def test_xarray_dataarray():
    da = DataArray(np.arange(24.0).reshape(2, 3, 4), ("run", "state", "time"),
                   {"state": ["x", "vx", "y"], "time": np.arange(4) * 0.5})
    i = varview.info(da)
    assert i["kind"] == "ndarray" and i["xr"] and i["cls"] == "DataArray float64"
    assert i["dims"] == ["run", "state", "time"]
    assert i["coords"] == {"1": ["x", "vx", "y"], "2": ["0", "0.5", "1", "1.5"]}
    b = varview.block(da, 0, 4, 0, 6, view={"row": 2, "cols": [0, 1], "fix": {}})
    assert _cells(b)[1] == list(da.values[:, :, 1].reshape(-1))
    assert workspace.openable(da)


def test_multiindex_levels():
    cols = pd.MultiIndex.from_tuples([("pos", "x"), ("pos", "y"), ("vel", "x")])
    idx = pd.MultiIndex.from_product([["run0", "run1"], [0, 1]])
    df = pd.DataFrame(np.arange(12.0).reshape(4, 3), index=idx, columns=cols)
    i = varview.info(df)
    assert (i["rowLevels"], i["colLevels"]) == (2, 2)
    c = varview.collabels(df)
    assert c["levels"] == [["pos", "pos", "vel"], ["x", "y", "x"]]
    assert len(c["labels"]) == 3 and c["labels"][0] != c["labels"][2]
    b = varview.block(df, 1, 3, 1, 3)
    assert b["colLevels"] == [["pos", "vel"], ["y", "x"]]
    assert b["rowLevels"] == [["run0", "run1"], ["1", "0"]]
    flat = varview.block(pd.DataFrame({"a": [1]}), 0, 1, 0, 1)
    assert "colLevels" not in flat and "rowLevels" not in flat


def test_scattered_columns_copy_and_stats():
    """Ctrl+クリックで選んだ離れた列（cols）だけを対象にする"""
    a = np.arange(40.0).reshape(5, 8)
    assert varview.copy_text(a, 0, 2, 0, 8, cols=[0, 3, 7]) == "0.0\t3.0\t7.0\n8.0\t11.0\t15.0"
    s = varview.stats(a, 0, 5, 0, 8, cols=[0, 3, 7])
    sub = a[:, [0, 3, 7]]
    assert (s["n"], s["allCols"]) == (15, 3)
    assert s["mean"] == pytest.approx(sub.mean()) and s["max"] == sub.max()
    df = pd.DataFrame(a, columns=list("abcdefgh"))
    assert varview.copy_text(df, 1, 2, 0, 8, cols=[1, 6]) == "9.0\t14.0"
    assert varview.stats(df, 0, 5, 0, 8, cols=[1, 6])["mean"] == pytest.approx(a[:, [1, 6]].mean())
    r = np.arange(90.0).reshape(10, 3, 3)
    view = {"row": 0, "cols": [1, 2], "fix": {}}
    assert varview.copy_text(r, 1, 2, 0, 9, None, view, cols=[0, 4, 8]) == "9.0\t13.0\t17.0"
    assert varview.copy_text(a, 0, 1, 0, 8, cols=[2, 99]) == "2.0", "範囲外の列は捨てる"
