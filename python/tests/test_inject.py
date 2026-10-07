"""注入方式（0.1.0）の回帰テスト

赤丸の行に `__ipydesk_bp__(id)` を埋め込み、トレースを入れずに実行して、
止まる位置・回数が pdb と同じになることを確認する。
"""

import json
import sys
import textwrap
from pathlib import Path

import pytest

from ipydesk import core, inject


@pytest.fixture
def ws(tmp_path, monkeypatch):
    (tmp_path / ".vscode").mkdir()
    monkeypatch.syspath_prepend(str(tmp_path))
    monkeypatch.setattr(core, "session_vscode_dir", None)
    monkeypatch.setattr(core, "session_file", None)
    monkeypatch.setattr(inject, "injected_by_file", {})
    monkeypatch.setattr(sys, "dont_write_bytecode", False)  # .pyc を書かないことの確認を空振りさせない
    before = set(sys.modules)
    yield tmp_path
    for name in set(sys.modules) - before:
        sys.modules.pop(name, None)


def write(ws, name, src):
    p = ws / name
    p.write_text(textwrap.dedent(src), encoding="utf-8")
    return p


def set_bps(ws, *items, mode="inject", cond=None):
    bps = [
        {"file": str(f), "line": ln, "enabled": True, "condition": cond}
        for f, ln in items
    ]
    (ws / ".vscode" / core.BP_NAME).write_text(
        json.dumps({"active": True, "mode": mode, "breakpoints": bps}), encoding="utf-8"
    )


@pytest.fixture
def hits(monkeypatch):
    """停止のたびに (行, i の値) を記録して続行する"""
    got = []

    def interaction(self, frame, tb_or_exc):
        if frame is None:
            return
        got.append((frame.f_lineno, frame.f_locals.get("i")))
        self.set_continue()

    monkeypatch.setattr(core.VsPdb, "interaction", interaction)
    return got


def run(ws, src, *lines, **kw):
    script = write(ws, "main.py", src)
    set_bps(ws, *[(script, ln) for ln in lines], **kw)
    ns = {}
    core.run_script(script, ns)
    return ns


def lines_of(hits):
    return [ln for ln, _ in hits]


# ---- 2-2 の対応表 ------------------------------------------------------------------


def test_plain_statement_stops_before_it_and_traces_nothing(ws, hits):
    ns = run(ws, "a = 1\nb = a + 1\nc = b\n", 2)
    assert lines_of(hits) == [2]
    assert ns["c"] == 2
    assert sys.gettrace() is None, "続行したあとはトレースが外れて全速に戻る"


def test_no_trace_is_installed_before_the_stop(ws, hits, monkeypatch):
    """止まるまでは、トレースを入れない（遅くならない）"""
    seen = []
    orig = core.VsPdb.stop_at

    def stop_at(self, frame):
        seen.append(sys.gettrace())
        return orig(self, frame)

    monkeypatch.setattr(core.VsPdb, "stop_at", stop_at)
    run(ws, "s = 0\nfor k in range(1000):\n    s += k\nx = 1\n", 4)
    assert seen == [None]


def test_for_line_stops_each_iteration_and_when_exhausted(ws, hits):
    run(ws, "for i in range(3):\n    pass\n", 1)
    assert hits == [(1, 0), (1, 1), (1, 2), (1, 2)], "反復のたび＋尽きた判定。値は最後のまま"


def test_for_line_with_empty_iterable_stops_once(ws, hits):
    run(ws, "for i in []:\n    pass\n", 1)
    assert len(hits) == 1


def test_for_line_break_skips_the_final_stop(ws, hits):
    run(ws, "for i in range(5):\n    if i == 1:\n        break\n", 1)
    assert [v for _, v in hits] == [0, 1]


def test_for_line_continue_stops_on_next_iteration(ws, hits):
    run(ws, "for i in range(3):\n    if i == 1:\n        continue\n    x = i\n", 1)
    assert len(hits) == 4


def test_for_loop_else_keeps_its_meaning(ws, hits):
    ns = run(ws, "for i in range(2):\n    pass\nelse:\n    done = True\n", 1)
    assert ns["done"] is True
    assert len(hits) == 3, "2 周 + else"


def test_while_line_stops_before_every_condition_check(ws, hits):
    ns = run(ws, "n = 0\nwhile n < 3:\n    n += 1\n", 2)
    assert len(hits) == 4, "3 周 + 最後の偽の判定の前"
    assert ns["n"] == 3


def test_elif_stops_only_when_evaluated(ws, hits):
    src = "x = 1\nif x == 1:\n    y = 1\nelif x == 2:\n    y = 2\n"
    run(ws, src, 4)
    assert hits == [], "最初の if が成り立てば elif は評価されない"
    run(ws, src.replace("x = 1", "x = 5"), 4)
    assert len(hits) == 1


def test_decorator_line_stops_before_the_def(ws, hits):
    ns = run(ws, "def deco(f):\n    return f\n\n@deco\ndef g():\n    return 1\n", 4)
    assert lines_of(hits) == [4]
    assert ns["g"]() == 1


def test_multiline_statement_second_line_stops_before_the_statement(ws, hits):
    ns = run(ws, "x = 1\ny = [\n    x,\n    x + 1,\n]\n", 4)
    assert len(hits) == 1
    assert ns["y"] == [1, 2]


def test_blank_and_comment_lines_move_to_the_next_statement(ws, hits):
    run(ws, "a = 1\n\n# comment\nb = 2\n", 2, 3)
    assert lines_of(hits) == [2, 3]  # 2 つとも b = 2 の前で止まる
    ns = run(ws, "a = 1\n\n# comment\nb = 2\n", 2)
    assert ns["b"] == 2


def test_else_and_except_lines_move_into_the_block(ws, hits):
    src = (
        "try:\n    raise ValueError\nexcept ValueError:\n    e = 1\n"
        "else:\n    e = 2\nfinally:\n    f = 3\n"
    )
    ns = run(ws, src, 3, 7)
    assert len(hits) == 2
    assert ns["e"] == 1 and ns["f"] == 3


def test_docstring_and_future_import_stay_valid(ws, hits):
    src = '"""doc"""\nfrom __future__ import annotations\nx = 1\n'
    ns = run(ws, src, 1, 2)
    assert ns["__doc__"] == "doc"
    assert len(hits) == 2
    assert ns["x"] == 1


def test_function_docstring_stays_a_docstring(ws, hits):
    ns = run(ws, 'def f():\n    "doc"\n    return 1\nf()\n', 2)
    assert ns["f"].__doc__ == "doc"
    assert len(hits) == 1


def test_condition(ws, hits):
    run(ws, "for i in range(5):\n    x = i\n", 2, cond="i == 3")
    assert [v for _, v in hits] == [3]


def test_traceback_line_numbers_are_unchanged(ws, hits, capsys):
    src = "a = 1\nb = 2\nc = 1 / 0\n"
    run(ws, src, 2)
    err = capsys.readouterr().err
    assert "line 3" in err and "1 / 0" in err
    assert core.error_info["where"].endswith("main.py:3")


# ---- 注入しない・できない赤丸 --------------------------------------------------------


def test_no_breakpoints_means_no_injection(ws, hits):
    script = write(ws, "main.py", "x = 1\n")
    set_bps(ws)
    plan = inject.make_plan(ws / ".vscode", script, True)
    assert plan.lines == set()


def test_run_without_breakpoints_ignores_injected_calls(ws, hits):
    script = write(ws, "main.py", "x = 1\ny = 2\n")
    set_bps(ws, (script, 2))
    ns = {}
    core.run_script(script, ns, use_breakpoints=False)
    assert hits == [] and ns["y"] == 2


def test_removed_breakpoint_is_inert(ws, hits):
    """compile した後に外された赤丸の呼び出しは何もしない"""
    script = write(ws, "main.py", "def f():\n    return 1\n")
    set_bps(ws, (script, 2))
    ns = {}
    core.run_script(script, ns)
    set_bps(ws)
    assert ns["f"]() == 1 and hits == []


def test_mode_trace_uses_the_old_tracing(ws, hits):
    run(ws, "a = 1\nb = 2\n", 2, mode="trace")
    assert lines_of(hits) == [2]
    assert inject.injected_by_file.get(inject.canon(ws / "main.py"), set()) == set()


# ---- ② import 時の注入 --------------------------------------------------------------


def test_breakpoint_in_a_module_not_yet_imported_is_injected_at_import(ws, hits, monkeypatch):
    mod = write(ws, "plugmod.py", "def inc(x):\n    y = x + 1\n    return y\n")
    script = write(ws, "main.py", "import plugmod\nr = plugmod.inc(1)\n")
    set_bps(ws, (mod, 2))
    traced = []
    orig = core.VsPdb.set_break
    monkeypatch.setattr(
        core.VsPdb, "set_break", lambda self, *a, **k: traced.append(a) or orig(self, *a, **k)
    )
    ns = {}
    core.run_script(script, ns)
    assert ns["r"] == 2
    assert [ln for ln, _ in hits] == [2]
    assert traced == [], "トレース（bdb）には登録しない"
    assert not list((ws / "__pycache__").glob("plugmod*")), "注入したコードを .pyc に残さない"


def test_module_without_breakpoint_still_uses_pyc(ws, hits):
    write(ws, "plainmod.py", "v = 1\n")
    other = write(ws, "other.py", "z = 1\n")
    script = write(ws, "main.py", "import plainmod\n")
    set_bps(ws, (other, 1))
    core.run_script(script, {})
    assert list((ws / "__pycache__").glob("plainmod*")), "赤丸のないモジュールは通常どおり"


def test_already_imported_module_falls_back_to_tracing(ws, hits):
    """③ import 済みのモジュールの赤丸はトレースで止める"""
    mod = write(ws, "loadedmod.py", "def inc(x):\n    y = x + 1\n    return y\n")
    script = write(ws, "main.py", "import loadedmod\nr = loadedmod.inc(1)\n")
    set_bps(ws)
    core.run_script(script, {})  # 赤丸なしで 1 回目の import
    set_bps(ws, (mod, 2))
    ns = {}
    core.run_script(script, ns)
    assert [ln for ln, _ in hits] == [2]
    assert core.trace_done is not None and core.trace_done["bps"][0]["line"] == 2


def test_traced_and_injected_breakpoints_in_one_run_stop_only_in_user_code(ws, monkeypatch):
    """B1: トレース経由の赤丸（import 済み）が先に止まったあと、注入の赤丸で bdb.py の中に止まらない"""
    mod = write(ws, "tracedmod.py", "def inc(x):\n    y = x + 1\n    return y\n")
    script = write(
        ws, "main.py", "import tracedmod\nr = tracedmod.inc(1)\nq = 5\nw = 6\n"
    )
    set_bps(ws)
    core.run_script(script, {})  # 赤丸なしで 1 回目の import（以降はトレース経路）
    set_bps(ws, (mod, 2), (script, 4))
    stops = []

    def interaction(self, frame, tb_or_exc):
        if frame is None:
            return
        stops.append((Path(frame.f_code.co_filename).name, frame.f_lineno))
        self.set_continue()

    monkeypatch.setattr(core.VsPdb, "interaction", interaction)
    ns = {}
    core.run_script(script, ns)
    assert stops == [("tracedmod.py", 2), ("main.py", 4)]
    assert ns["w"] == 6
    assert sys.gettrace() is None


def test_module_reload_picks_up_a_new_breakpoint(ws, hits):
    """autoreload のように、実行の外で読み直されても注入される（Finder は入れっぱなし）"""
    import importlib

    mod = write(ws, "reloadmod.py", "def inc(x):\n    y = x + 1\n    return y\n")
    script = write(ws, "main.py", "import reloadmod\nr = reloadmod.inc(1)\n")
    set_bps(ws)
    core.run_script(script, {})
    set_bps(ws, (mod, 2))
    importlib.reload(sys.modules["reloadmod"])
    core.run_script(script, {})
    assert [ln for ln, _ in hits] == [2]


# ---- セル実行 ------------------------------------------------------------------------


def test_cell_breakpoint_inside_the_range_is_injected(ws, hits):
    script = write(ws, "main.py", "a = 1\nfor i in range(2):\n    c = i\nb = 2\n")
    set_bps(ws, (script, 3))
    core.run_cell(script, 2, 3, {})
    assert lines_of(hits) == [3, 3]


def test_cell_breakpoint_outside_the_range_does_not_trace(ws, hits):
    script = write(ws, "main.py", "a = 1\nb = 2\nc = 3\n")
    set_bps(ws, (script, 1))
    core.trace_done = None
    core.run_cell(script, 2, 3, {})
    assert hits == []
    assert core.trace_done is None, "トレースを入れていない"


def test_cell_breakpoint_inside_a_function_defined_elsewhere_still_stops(ws, hits):
    src = "def f(x):\n    y = x + 1\n    return y\nr = f(1)\n"
    script = write(ws, "main.py", src)
    set_bps(ws)
    ns = {}
    core.run_cell(script, 1, 3, ns)  # f を定義（赤丸なし）
    set_bps(ws, (script, 2))
    core.run_cell(script, 4, 4, ns)  # 別のセルから呼ぶ
    assert [ln for ln, _ in hits] == [2]


def test_tail_expression_is_still_displayed(ws, hits, monkeypatch):
    shown = []
    monkeypatch.setattr("sys.displayhook", shown.append)
    script = write(ws, "main.py", "a = 1\na + 1\n")
    set_bps(ws, (script, 2))
    core.run_cell(script, 1, 2, {})
    assert shown == [2] and len(hits) == 1


# ---- ステップ実行 ---------------------------------------------------------------------


def test_step_over_does_not_enter_the_injected_call_or_stop_twice(ws, monkeypatch):
    got = []

    def interaction(self, frame, tb_or_exc):
        if frame is None:
            return
        got.append((Path(frame.f_code.co_filename).name, frame.f_lineno))
        if len(got) < 3:
            self.set_next(frame)
        else:
            self.set_continue()

    monkeypatch.setattr(core.Pdb, "interaction", interaction)  # 本物の VsPdb.interaction は通す
    script = write(ws, "main.py", "a = 1\nb = 2\nc = 3\nd = 4\n")
    set_bps(ws, (script, 1), (script, 2), (script, 3))
    core.run_script(script, {})
    assert got == [("main.py", 1), ("main.py", 2), ("main.py", 3)], \
        "各行で 1 回ずつ。__ipydesk_bp__ の中や同じ行の二重停止はない"
    assert sys.gettrace() is None


def test_quit_inside_an_injected_stop_aborts_the_run(ws, monkeypatch):
    def interaction(self, frame, tb_or_exc):
        if frame is not None:
            self.set_quit()

    monkeypatch.setattr(core.VsPdb, "interaction", interaction)
    script = write(ws, "main.py", "a = 1\nb = 2\nc = 3\n")
    set_bps(ws, (script, 2))
    ns = {}
    core.run_script(script, ns)
    assert ns["a"] == 1 and "c" not in ns
    assert sys.gettrace() is None


# ---- AST の注入そのもの --------------------------------------------------------------


def test_injected_statement_has_the_breakpoint_line_number():
    import ast

    tree = ast.parse("a = 1\nb = 2\n")
    inject.inject_tree(tree, {2}, "x.py")
    inserted = tree.body[1]
    assert isinstance(inserted, ast.Expr) and inserted.lineno == 2
    assert ast.unparse(tree.body[2]) == "b = 2"


def test_line_past_the_end_is_ignored():
    import ast

    tree = ast.parse("a = 1\n")
    assert inject.inject_tree(tree, {50}, "x.py") == set()
