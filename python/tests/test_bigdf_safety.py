"""大きな DataFrame で停止したときの安全策（ipydesk.workspace / varview / core）の回帰テスト

- 要約（ワークスペースビュー・Variable Editor のセル表示）は、pandas の表示上限を
  外していても、DataFrame 全体の文字列を作らない
- Variable Editor は、セッションの実行中は変数を読まない（停止中・プロンプト待ちだけ）
- 拡張が拾わなかった答えのファイルは、しばらくすると消える
"""

import json
import os
import time

import numpy as np
import pandas as pd
import pytest

from ipydesk import core, varview, workspace


@pytest.fixture
def big():
    rng = np.random.default_rng(0)
    df = pd.DataFrame(rng.normal(size=(10000, 50)), columns=[f"c{i}" for i in range(50)])
    df["name"] = [f"n{i}" for i in range(10000)]
    return df


@pytest.fixture(autouse=True)
def fresh():
    workspace._previous.clear()
    core.set_ready(True)
    yield
    core.set_ready(True)


@pytest.fixture
def no_limits():
    with pd.option_context("display.max_rows", None, "display.max_columns", None,
                           "display.width", None):
        yield


def test_containers_of_frames_do_not_build_full_repr(big, no_limits, monkeypatch):
    called = []
    orig = pd.DataFrame.__repr__
    monkeypatch.setattr(pd.DataFrame, "__repr__", lambda self: called.append(1) or orig(self))
    ns = {"out": (big, big.c0, big.to_numpy()), "dfs": {"a": big}, "lst": [big, big]}
    t = time.perf_counter()
    got = {v["name"]: v for v in workspace.snapshot(ns)}
    assert time.perf_counter() - t < 2.0
    assert not called, "list / tuple / dict の中の DataFrame に repr を呼ばない"
    assert "<DataFrame 10000×51>" in got["lst"]["value"]
    assert "<ndarray 10000×51>" in got["out"]["value"]


def test_user_object_repr_is_limited(big, no_limits):
    class Holder:
        def __init__(self, df):
            self.df = df

        def __repr__(self):
            return f"Holder({self.df!r})"

    (item,) = workspace.snapshot({"h": Holder(big)})
    assert item["value"].startswith("Holder(")
    # 中で表示された DataFrame は、要約の間だけ小さく制限される
    with workspace.display_limits():
        assert len(repr(big)) < 5000
    assert pd.get_option("display.max_rows") is None, "利用者の設定は元に戻す"


def test_cell_fmt_of_object_column_with_frames(big, no_limits):
    s = pd.Series([big, [1, 2, 3]], dtype=object)
    assert varview.fmt(s[0]) == "<DataFrame 10000×51>"


def test_variable_editor_does_not_read_while_running(big):
    ns = {"df": big}

    class Shell:
        user_ns = ns

    core.set_ready(False)
    res = varview.handle({"id": "a", "expr": "df", "op": "block", "r0": 0, "r1": 5, "c0": 0, "c1": 5}, Shell())
    assert res["ok"] is False and res.get("transient") is True
    core.set_ready(True)
    res = varview.handle({"id": "b", "expr": "df", "op": "block", "r0": 0, "r1": 5, "c0": 0, "c1": 5}, Shell())
    assert res["ok"] is True and len(res["block"]["cells"]) == 5


def test_stale_answers_are_removed(tmp_path):
    old = tmp_path / f"{varview.RES_PREFIX}x.json"
    new = tmp_path / f"{varview.RES_PREFIX}y.json"
    old.write_text("{}"); new.write_text("{}")
    t = time.time() - varview.STALE_SEC - 5
    os.utime(old, (t, t))
    varview.serve_once(tmp_path)
    assert not old.exists() and new.exists()


def test_clip_output():
    text = "\n".join(f"row {i:06d} " + "x" * 50 for i in range(10000))
    out = core.clip_output(text, 20_000)
    assert len(out) < 21_000 and "[ipydesk]" in out and out.startswith("row 000000")
    assert core.clip_output("short", 20_000) == "short"
    assert core.clip_output(text, 0) == text, "0 は無制限"


def test_pdb_display_is_clipped(monkeypatch, big, no_limits, capsys):
    monkeypatch.setenv("IPYDESK_MAX_OUTPUT", "5000")
    from pathlib import Path
    dbg = core.VsPdb(Path(__file__), None)
    dbg.displayhook(big)           # 停止中に `df` と打ったときの表示
    out = capsys.readouterr().out
    assert len(out) < 6000 and "[ipydesk]" in out


@pytest.mark.parametrize("cmd", ["print(df)", "df.to_dict()", "df.c0.tolist()"])
def test_pdb_statement_output_is_clipped(monkeypatch, big, no_limits, capsys, cmd):
    """停止中に print(df) や巨大な 1 行（to_dict など）を打っても、端末へは上限までしか流さない"""
    import sys
    from pathlib import Path
    monkeypatch.setenv("IPYDESK_MAX_OUTPUT", "5000")
    dbg = core.VsPdb(Path(__file__), None)
    frame = sys._getframe()
    dbg.curframe = frame
    for name in ("curframe_locals", "_curframe_locals"):
        try:
            setattr(dbg, name, {"df": big})
        except AttributeError:  # IPython では読み取り専用のプロパティ
            pass
    dbg.default(cmd)
    out = capsys.readouterr().out
    assert 5000 <= len(out) < 6000 and "[ipydesk]" in out
