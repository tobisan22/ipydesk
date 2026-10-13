"""スクリプト引数（sys.argv）対応の回帰テスト（仕様書/スクリプト引数_仕様書_実装済み_v0.1.2.md の T-1〜T-15）"""

import os
import sys
from pathlib import Path

import pytest
from IPython.terminal.interactiveshell import TerminalInteractiveShell as InteractiveShell

from ipydesk import core
from ipydesk.__main__ import join_args, parse_args, startup_lines

PARSE_SCRIPT = """\
import argparse
p = argparse.ArgumentParser()
p.add_argument("--n", type=int, default=0)
p.add_argument("--in", dest="inp", default="")
args = p.parse_args()
argv_seen = list(__import__("sys").argv)
"""


@pytest.fixture
def script(tmp_path):
    (tmp_path / ".vscode").mkdir()
    path = tmp_path / "x.py"
    path.write_text(PARSE_SCRIPT, encoding="utf-8")
    return path


# ---- split_args / split_target ----------------------------------------------


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("--n 10", ["--n", "10"]),
        (r'--in "C:\d\a b.csv"', ["--in", r"C:\d\a b.csv"]),
        (r"--in C:\d\x.csv", ["--in", r"C:\d\x.csv"]),
        ("--j '{\"a\": 1}'", ["--j", '{"a": 1}']),
        ("--tag a#b", ["--tag", "a#b"]),
        ("--n $x {x}", ["--n", "$x", "{x}"]),
        ('"a ""b"', ["a b"]),
        ("", []),
    ],
)
def test_split_args(raw, expected):  # T-1
    assert core.split_args(raw) == expected


def test_split_args_unclosed_quote():  # T-2
    with pytest.raises(ValueError, match="引用符が閉じていません"):
        core.split_args(r'--in "C:\d')


def test_split_target_ignores_separator_inside_quotes():  # T-3
    assert core.split_target(r'"C:\a -- b\x.py" -- --n 1') == (r'"C:\a -- b\x.py"', "--n 1")


@pytest.mark.parametrize("rest", ["x.py", "x.py --", "x.py -- "])
def test_split_target_without_args(rest):  # T-4
    assert core.split_target(rest) == ("x.py", "")


def test_split_target_keeps_later_separator():  # T-5
    assert core.split_target("x.py -- a -- b") == ("x.py", "a -- b")


# ---- 実行 -------------------------------------------------------------------


def test_exec_as_script_sets_and_restores_argv():  # T-6
    saved = list(sys.argv)
    seen = {}
    code = compile("import sys; seen['argv'] = list(sys.argv)", "x.py", "exec")
    core._exec_as_script(Path("x.py"), code, {"seen": seen}, ["--n", "3"])
    assert seen["argv"] == ["x.py", "--n", "3"]
    assert sys.argv == saved

    with pytest.raises(RuntimeError):
        core._exec_as_script(Path("x.py"), compile("raise RuntimeError", "x.py", "exec"), {}, ["a"])
    assert sys.argv == saved


def test_run_script_passes_argv(script):  # T-7
    ns = {}
    core.run_script(script, ns, argv=["--n", "7", "--in", "a b.csv"])
    assert ns["args"].n == 7 and ns["args"].inp == "a b.csv"


def test_run_cell_passes_argv(script):  # T-8
    ns = {}
    core.run_cell(script, 1, 6, ns, argv=["--n", "7"])
    assert ns["args"].n == 7
    assert ns["argv_seen"][1:] == ["--n", "7"]


# ---- マジック ---------------------------------------------------------------


@pytest.fixture
def shell():
    # 拡張全体は読み込まない（セッションファイルや変数ビューのスレッドを持ち込まないため）
    InteractiveShell.clear_instance()
    ip = InteractiveShell.instance()
    ip.register_magics(core.IPyDeskMagics)
    yield ip
    InteractiveShell.clear_instance()


def test_magic_does_not_expand_variables(shell, script):  # T-9
    shell.user_ns["x"] = "EXPANDED"
    plain = script.with_name("plain.py")
    plain.write_text("import sys\nargv_seen = list(sys.argv)\n", encoding="utf-8")
    shell.run_cell(f'%ipydesk "{plain}" -- --n $x')
    assert shell.user_ns["argv_seen"][1:] == ["--n", "$x"]


def test_magic_cell_reads_range_and_args(shell, script):  # T-10
    shell.run_cell(f'%ipydesk_cell "{script}" 1 6 -- --n 1')
    assert shell.user_ns["args"].n == 1


def test_magic_unclosed_quote_does_not_run(shell, tmp_path):  # T-11
    marker = tmp_path / "ran.txt"
    s = tmp_path / "side.py"
    s.write_text(f"open({str(marker)!r}, 'w').close()\n", encoding="utf-8")
    shell.run_cell(f'%ipydesk "{s}" -- --in "C:' + chr(92) + 'd')
    assert not marker.exists()


# ---- python -m ipydesk ------------------------------------------------------


def test_parse_args_splits_script_args():  # T-12
    script, cell, raw = parse_args(["a.py", "--cell", "3", "9", "--pm", "--", "x", "y z"])
    assert script is not None and script.name == "a.py"
    assert cell == (3, 9)
    assert raw == "x 'y z'"


@pytest.mark.parametrize(
    "items", [["a", "b c"], ['say "hi"'], ["it's"], [""], ["--n", "10"], [r"C:\d\a b.csv"]]
)
def test_join_args_roundtrip(items):  # T-13
    assert core.split_args(join_args(items)) == items


def test_join_args_rejects_both_quotes():
    with pytest.raises(ValueError):
        join_args(["a'b\"c"])


def test_startup_lines_append_args():  # T-14
    s = Path("/w/a.py")
    plain = startup_lines("none", 0, s)
    assert plain[-1] == '%ipydesk "' + str(s) + '"'
    assert startup_lines("none", 0, s, args="--n 1")[-1] == plain[-1] + " -- --n 1"
    with_cell = startup_lines("none", 0, s, cell=(3, 9), args="--n 1")
    assert with_cell[-1].endswith("3 9 -- --n 1")


def test_main_consumes_ipydesk_args_env(monkeypatch):  # T-15
    import ipydesk.__main__ as m

    seen = {}
    # main() が書き換えるモジュール変数を、テスト後に元へ戻す
    monkeypatch.setattr(core, "session_vscode_dir", None)
    monkeypatch.setattr(core, "session_file", None)
    monkeypatch.setattr(sys, "argv", ["ipydesk", "a.py"])
    monkeypatch.setenv("IPYDESK_ARGS", "--n 3")
    monkeypatch.setenv("IPYDESK_MPL", "none")
    monkeypatch.setattr(
        m.IPyDeskApp, "launch_instance",
        classmethod(lambda cls, **kw: seen.update(lines=kw["ipydesk_lines"])),
    )
    m.main()
    assert "IPYDESK_ARGS" not in os.environ
    assert seen["lines"][-1].endswith(" -- --n 3")
