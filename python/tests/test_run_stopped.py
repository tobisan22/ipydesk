"""停止中の Ctrl+Shift+Enter（pdb コマンド ipydesk_run）の回帰テスト

停止位置のフレームのローカル変数で、ファイルの行範囲を実行できること。
"""

import io
import sys

import pytest

from ipydesk import core

SAMPLE = """\
def f(x):
    y = x * 2
    for i in range(2):
        y += i
    return y
z = 5
z + 100
1 / 0
if True
"""


@pytest.fixture
def dbg(tmp_path):
    script = tmp_path / "s.py"
    script.write_text(SAMPLE, encoding="utf-8")
    out = io.StringIO()
    d = core.VsPdb(script, None, stdout=out)

    def frame_of(x):
        y = x * 3  # noqa: F841
        return sys._getframe()

    frame = frame_of(7)
    d.curframe = frame
    d.curframe_locals = frame.f_locals
    return d, out, script, frame


def run(d, script, a, b):
    d.onecmd(f'ipydesk_run "{script}" {a} {b}')


def test_line_uses_frame_locals(dbg):
    d, out, script, _ = dbg
    run(d, script, 2, 2)  # 字下げ付きの 1 行: y = x * 2
    assert d.curframe_locals["y"] == 14


def test_indented_block(dbg):
    d, out, script, _ = dbg
    run(d, script, 2, 4)  # for を含む字下げ付きの複数行
    assert d.curframe_locals["y"] == 15


def test_tail_expression_is_shown(dbg):
    d, out, script, _ = dbg
    run(d, script, 6, 7)
    assert "105" in out.getvalue()
    assert d.lastcmd == ""  # 空 Enter で再実行しない


def test_error_keeps_stopped(dbg):
    d, out, script, _ = dbg
    run(d, script, 8, 8)
    assert "ZeroDivisionError" in out.getvalue()
    run(d, script, 9, 9)
    assert "SyntaxError" in out.getvalue()


def test_bad_args(dbg):
    d, out, script, _ = dbg
    d.onecmd("ipydesk_run nonsense")
    assert "usage" in out.getvalue()
