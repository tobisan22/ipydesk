"""エラー時に止まるかどうか（0.4.3）の回帰テスト

- F5 / セル実行（post_mortem=False）: トレースバックを出すだけで止まらない。
  エラーは取っておき、後から %ipydesk_pm（IPyDesk: Debug Last Error）で入れる
- Alt+F5（post_mortem=True / --pm）: その場でエラーの行に止まる
赤丸で止まる動作はどちらでも変わらない。
"""

import json

import pytest

from ipydesk import core
from ipydesk.__main__ import startup_lines

BAD = "a = 1\nb = 0\nc = a / b\n"


@pytest.fixture
def ws(tmp_path, monkeypatch):
    (tmp_path / ".vscode").mkdir()
    (tmp_path / ".vscode" / core.BP_NAME).write_text("[]", encoding="utf-8")
    script = tmp_path / "bad.py"
    script.write_text(BAD, encoding="utf-8")
    monkeypatch.setattr(core, "session_vscode_dir", None)
    monkeypatch.setattr(core, "session_file", None)
    monkeypatch.setattr(core, "_last_error", None)
    monkeypatch.setattr(core, "error_info", None)
    return script


@pytest.fixture
def pm(monkeypatch):
    """事後デバッグに入った回数と、そのとき止まった行"""
    hits = []

    def interaction(self, frame, tb):
        self.setup(frame, tb)
        hits.append(self.curframe.f_lineno)
        self.forget()

    monkeypatch.setattr(core.VsPdb, "interaction", interaction)
    return hits


def test_f5_does_not_stop_on_error(ws, pm, capsys):
    core.run_script(ws, {})
    err = capsys.readouterr().err
    assert "ZeroDivisionError" in err, "トレースバックは出す"
    assert "Debug Last Error" in err, "後から入る方法を案内する"
    assert pm == [], "F5 ではエラーで止まらない"
    assert core.error_info == {"type": "ZeroDivisionError", "where": "bad.py:3"}


def test_alt_f5_stops_on_error(ws, pm):
    core.run_script(ws, {}, post_mortem=True)
    assert pm == [3], "Alt+F5 はエラーの行で止まる"


def test_cell_run_does_not_stop_on_error(ws, pm):
    core.run_cell(ws, 1, 3, {})
    assert pm == []
    assert core.error_info["where"] == "bad.py:3"


def test_debug_last_error_enters_at_the_error_line(ws, pm):
    ns = {}
    core.run_script(ws, ns)
    core.post_mortem_last()
    assert pm == [3], "後からでもエラーの行に入れる"
    core.post_mortem_last()
    assert pm == [3, 3], "何度でも入り直せる（次の実行までは）"


def test_next_run_forgets_the_error(ws, pm, capsys):
    core.run_script(ws, {})
    ws.write_text("a = 1\n", encoding="utf-8")
    core.run_script(ws, {})
    assert core.error_info is None, "次の実行で ⚠ は消える"
    capsys.readouterr()
    core.post_mortem_last()
    assert pm == []
    assert "直前のエラーがありません" in capsys.readouterr().out


def test_error_is_reported_to_extension(ws, tmp_path, monkeypatch):
    """⚠ 表示のため、py_session.json にエラーの種類と場所が載る"""
    sdir = tmp_path / ".vscode" / "py_sessions" / "1"
    sdir.mkdir(parents=True)
    monkeypatch.setattr(core, "session_vscode_dir", sdir)
    monkeypatch.setattr(core, "session_file", sdir / core.SESSION_NAME)
    core.run_script(ws, {})
    core.write_session(False)  # post_run_cell と同じ
    data = json.loads((sdir / core.SESSION_NAME).read_text(encoding="utf-8"))
    assert data["error"] == {"type": "ZeroDivisionError", "where": "bad.py:3"}


def test_split_pm():
    assert core.split_pm('--pm "C:\\a b\\x.py"') == (True, '"C:\\a b\\x.py"')
    assert core.split_pm('"C:\\x.py"') == (False, '"C:\\x.py"')
    assert core.split_pm('"--pmx.py"') == (False, '"--pmx.py"')


def test_startup_lines_pass_pm():
    lines = startup_lines("none", port=8988, script=r"C:\w\a.py", post_mortem=True)
    assert lines[-1] == '%ipydesk --pm "C:\\w\\a.py"'
    lines = startup_lines("none", port=8988, script=r"C:\w\a.py", cell=(2, 5))
    assert lines[-1] == '%ipydesk_cell "C:\\w\\a.py" 2 5', "既定は --pm なし"
