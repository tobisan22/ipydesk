"""セル実行（run_cell）の回帰テスト

セル実行の肝は「切り出した範囲を、元のファイルの行番号のまま実行する」こと。
ここがずれると赤丸（ブレークポイント）が効かず、例外の行も食い違う。
先頭に空行を詰めて行番号を合わせているので、その性質をここで固定する。
"""

import json

import pytest

from ipydesk import core
from ipydesk.__main__ import parse_args, startup_lines

SAMPLE = """\
# %% cell1
import math
a = 1

# %% cell2
b = a + 1
for i in range(3):
    c = i
b * 10
"""


@pytest.fixture
def sample(tmp_path):
    """.vscode/ を備えたワークスペースに置いたサンプルスクリプト"""
    (tmp_path / ".vscode").mkdir()
    (tmp_path / ".vscode" / core.BP_NAME).write_text("[]", encoding="utf-8")
    path = tmp_path / "sample.py"
    path.write_text(SAMPLE, encoding="utf-8")
    return path


@pytest.fixture
def stops(monkeypatch):
    """停止のたびに (ファイル名, 行) を記録し、対話に入らず続行する"""
    hits = []

    def interaction(self, frame, tb_or_exc):
        if frame is None:  # 事後デバッグ
            hits.append(("<postmortem>", None))
            return
        hits.append((frame.f_code.co_filename, frame.f_lineno))
        self.set_continue()

    monkeypatch.setattr(core.VsPdb, "interaction", interaction)
    return hits


@pytest.fixture
def shown(monkeypatch):
    """Out[n] として表示された値"""
    values = []
    monkeypatch.setattr("sys.displayhook", values.append)
    return values


def set_breakpoints(sample, *lines):
    (sample.parent / ".vscode" / core.BP_NAME).write_text(
        json.dumps([{"file": str(sample), "line": ln, "enabled": True} for ln in lines]),
        encoding="utf-8",
    )


def test_runs_only_the_selected_range(sample):
    ns = {}
    core.run_cell(sample, 1, 4, ns)
    assert ns["a"] == 1
    assert "b" not in ns, "セル2の行まで実行してはいけない"
    assert ns["__file__"] == str(sample.resolve())


def test_namespace_persists_between_cells(sample):
    ns = {}
    core.run_cell(sample, 1, 4, ns)
    core.run_cell(sample, 5, 9, ns)
    assert ns["b"] == 2, "前のセルで作った変数を引き継ぐ"
    assert ns["c"] == 2


def test_trailing_expression_is_displayed(sample, shown):
    core.run_cell(sample, 5, 9, {"a": 1})
    assert shown == [20], "IPython のセルと同じく、末尾の式は Out[n] に出す"


def test_trailing_statement_shows_nothing(sample, shown):
    core.run_cell(sample, 6, 6, {"a": 1})
    assert shown == []


def test_breakpoint_inside_a_cell_stops_at_the_file_line(sample, stops):
    """行番号合わせが効いていないと、そもそも赤丸で止まらない"""
    set_breakpoints(sample, 8)
    ns = {"a": 1}
    core.run_cell(sample, 5, 9, ns)
    assert stops == [(str(sample.resolve()), 8)] * 3, "ループの 3 周とも止まる"
    assert ns["c"] == 2, "続行してセルの最後まで走る"


def test_breakpoint_outside_the_range_is_ignored(sample, stops):
    set_breakpoints(sample, 3)
    core.run_cell(sample, 5, 9, {"a": 1})
    assert stops == []


def test_exception_keeps_file_line_numbers(sample, stops, capsys):
    sample.write_text("x = 1\ny = 0\nx / y\n", encoding="utf-8")
    core.run_cell(sample, 3, 3, {}, post_mortem=True)
    assert "line 3" in capsys.readouterr().err
    assert stops == [("<postmortem>", None)], "post_mortem=True なら例外は事後デバッグへ渡す"


def test_indented_range_can_be_run_alone(sample):
    """`for` の中だけを選んで実行しても IndentationError にしない"""
    ns = {"i": 7}
    core.run_cell(sample, 8, 8, ns)
    assert ns["c"] == 7


def test_syntax_error_is_reported_without_raising(tmp_path, capsys):
    bad = tmp_path / "bad.py"
    bad.write_text("x = (\n", encoding="utf-8")
    core.run_cell(bad, 1, 1, {})
    assert "SyntaxError" in capsys.readouterr().out


def test_blank_or_out_of_range_does_nothing(sample):
    ns = {}
    core.run_cell(sample, 4, 4, ns)      # 空行だけ
    core.run_cell(sample, 100, 200, ns)  # ファイルの外
    core.run_cell(sample, 9, 5, ns)      # 逆順
    assert "a" not in ns


def test_run_script_still_runs_the_whole_file(sample):
    ns = {}
    core.run_script(sample, ns)
    assert ns["a"] == 1 and ns["b"] == 2


# ---- 起動時のセル実行（拡張がセッション未起動でセルを実行したとき）----------------


def test_parse_args_reads_cell_range():
    script, cell = parse_args(["/work/a.py", "--cell", "3", "9"])
    assert cell == (3, 9)
    assert script is not None and script.name == "a.py"


def test_parse_args_without_cell():
    script, cell = parse_args(["/work/a.py"])
    assert cell is None and script is not None

    assert parse_args([]) == (None, None)


def test_startup_runs_the_cell_when_given_one():
    lines = startup_lines("webagg", port=8988, script=r"C:\work\a.py", cell=(3, 9))
    assert lines[-1] == r'%ipydesk_cell "C:\work\a.py" 3 9'


def test_startup_without_cell_runs_the_script():
    lines = startup_lines("webagg", port=8988, script=r"C:\work\a.py")
    assert lines[-1] == r'%ipydesk "C:\work\a.py"'
