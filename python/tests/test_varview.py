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
