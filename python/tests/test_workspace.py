"""ワークスペースビュー（ipydesk.workspace）の回帰テスト

ビューに出す要約の形と、停止中にそのフレームの変数が書き出されることを固定する。
"""

import json

import pytest

from ipydesk import core, workspace


@pytest.fixture(autouse=True)
def fresh():
    workspace._previous.clear()


def names(items):
    return [v["name"] for v in items]


def test_hides_modules_functions_classes_and_private():
    import math

    class K:
        pass

    ns = {"math": math, "f": lambda: 0, "K": K, "_tmp": 1, "In": [], "a": 1, "B": 2.5}
    assert names(workspace.snapshot(ns)) == ["a", "B"], "データだけを名前順（大小無視）で出す"


def test_ipython_hidden_names_are_skipped():
    assert names(workspace.snapshot({"x": 1, "y": 2}, hidden={"y"})) == ["x"]


def test_scalars_and_containers():
    got = {v["name"]: v for v in workspace.snapshot(
        {"i": 4, "dt": 0.01, "s": "sin(x)", "g": [2.5, 0.8], "d": {"pos": 1, "t": 2}}
    )}
    assert (got["i"]["value"], got["i"]["size"], got["i"]["cls"]) == ("4", "1×1", "int")
    assert got["dt"]["value"] == "0.01"
    assert got["s"]["value"] == "'sin(x)'" and got["s"]["size"] == "6"
    assert got["g"]["size"] == "2" and got["g"]["cls"] == "list"
    assert got["d"]["size"] == "2 keys"
    assert names(got["d"]["kids"]) == ["'pos'", "'t'"], "dict は 1 段だけ展開できる"
    assert "kids" not in got["d"]["kids"][0], "展開は 1 段まで"


def test_object_attributes_are_one_level():
    class EKF:
        def __init__(self):
            self.Q = [1, 2]
            self._cache = 0

        def update(self):
            pass

    (item,) = workspace.snapshot({"ekf": EKF()})
    assert item["value"] == "<EKF>", "既定の repr（アドレス）は出さない"
    assert names(item["kids"]) == ["Q"], "_ 始まりの属性とメソッドは出さない"


def test_broken_repr_does_not_break_the_view():
    class Bad:
        def __repr__(self):
            raise RuntimeError("boom")

    (item,) = workspace.snapshot({"b": Bad()})
    assert "RuntimeError" in item["value"]


def test_long_values_are_clipped():
    (item,) = workspace.snapshot({"s": "x" * 1000})
    assert len(item["value"]) <= workspace.MAX_TEXT + 2


def test_marks_new_and_changed_per_scope():
    ns = {"a": 1, "b": 2}
    assert [v["mark"] for v in workspace.snapshot(ns)] == ["", ""], "初回は印なし"
    ns.update(b=3, c=4)
    assert {v["name"]: v["mark"] for v in workspace.snapshot(ns)} == {
        "a": "", "b": "chg", "c": "new"}
    workspace.snapshot({"z": 0}, scope="f")  # 別スコープは別に覚える
    assert {v["name"]: v["mark"] for v in workspace.snapshot(ns)} == {
        "a": "", "b": "", "c": ""}


def test_numpy_arrays():
    np = pytest.importorskip("numpy")
    got = {v["name"]: v for v in workspace.snapshot({
        "x": np.linspace(0, 10, 100),
        "P": np.diag([25.0, 1e-4, 3.0]),
        "v": np.array([1.0, 2.0]),
        "big": np.zeros((2000, 1000)),
        "n": np.float64(1.5),
    })}
    assert (got["x"]["size"], got["x"]["cls"]) == ("100", "ndarray float64")
    assert got["x"]["value"].startswith("[0, 0.101") and got["x"]["value"].endswith("10]")
    assert got["P"]["size"] == "3×3" and got["P"]["value"] == "min 0 … max 25"
    assert got["v"]["value"] == "[1., 2.]"
    assert not got["big"]["value"].startswith("min"), "巨大配列は min/max を計算しない"
    assert got["n"]["size"] == "1×1"
    assert "kids" not in got["x"], "配列は展開しない"


def test_dataframe():
    pd = pytest.importorskip("pandas")
    (item,) = workspace.snapshot({"log": pd.DataFrame({"t": [0, 1], "alt": [1, 2]})})
    assert (item["value"], item["size"], item["cls"]) == ("t, alt", "2×2", "DataFrame")


def test_write_file(tmp_path):
    workspace.write(tmp_path, {"a": 1})
    data = json.loads((tmp_path / workspace.WORKSPACE_NAME).read_text(encoding="utf-8"))
    assert data["stopped"] is False and names(data["vars"]) == ["a"]
    assert not (tmp_path / (workspace.WORKSPACE_NAME + ".tmp")).exists()
    workspace.write(None, {"a": 1})  # .vscode が無ければ何もしない


SAMPLE = """\
def update(xk, k):
    z = xk * 2
    return z

total = update(3, 1)
"""


def test_stop_writes_the_frame_locals(tmp_path, monkeypatch):
    """ブレークポイントで止まったら、その関数のローカル変数を書き出す"""
    (tmp_path / ".vscode").mkdir()
    script = tmp_path / "s.py"
    script.write_text(SAMPLE, encoding="utf-8")
    (tmp_path / ".vscode" / core.BP_NAME).write_text(
        json.dumps([{"file": str(script), "line": 3, "enabled": True}]), encoding="utf-8")

    seen = []

    def interaction(self, frame, tb):
        self.setup(frame, tb)
        self.preloop()  # 実際の停止と同じく cmdloop の入口で書き出す
        seen.append(json.loads(
            (tmp_path / ".vscode" / workspace.WORKSPACE_NAME).read_text(encoding="utf-8")))
        self.forget()
        self.set_continue()

    monkeypatch.setattr(core.VsPdb, "interaction", interaction)
    ns = {}
    core.run_script(script, ns)

    (data,) = seen
    assert data["stopped"] is True and data["where"] == "s.py:3"
    assert data["scope"] == "update（ローカル）"
    assert {v["name"]: v["value"] for v in data["vars"]} == {"k": "1", "xk": "3", "z": "6"}
    assert ns["total"] == 6


def test_variables_from_the_first_run_stay_visible():
    """起動時の %ipydesk（exec_lines）で作った変数が user_ns_hidden に入らないこと。

    IPython の既定 hide_initial_ns=True だと、1 回目の F5 で作った変数が
    次のセル以降ワークスペースビューから消えていた。
    """
    from IPython.terminal.ipapp import TerminalIPythonApp

    from ipydesk.__main__ import IPyDeskApp, ipython_config

    TerminalIPythonApp.clear_instance()
    IPyDeskApp.clear_instance()
    app = IPyDeskApp.instance(config=ipython_config(), ipydesk_lines=["x_first = 1"])
    try:
        app.initialize([])
        ip = app.shell
        assert ip.user_ns["x_first"] == 1
        assert "x_first" not in ip.user_ns_hidden
        assert "x_first" in names(workspace.snapshot(ip.user_ns, ip.user_ns_hidden))
    finally:
        from IPython.core.interactiveshell import InteractiveShell

        InteractiveShell.clear_instance()
        IPyDeskApp.clear_instance()
        TerminalIPythonApp.clear_instance()
