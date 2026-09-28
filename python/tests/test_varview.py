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
