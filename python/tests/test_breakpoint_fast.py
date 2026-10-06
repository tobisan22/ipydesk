"""赤丸があっても実行が遅くならない仕組み（0.0.9）の回帰テスト — トレース方式（mode: trace）

- 続行中、赤丸のないファイルの関数呼び出しは bdb の重い処理（dispatch_call）に入らない
- 赤丸のあるファイルの関数は従来どおり止まる
- 赤丸を無視する実行（--nobp）、全赤丸の一時無効（"active": false）
- トレース実行の情報が py_session.json に載る
"""

import json
import sys
from bdb import Bdb

import pytest

from ipydesk import core
from ipydesk.__main__ import startup_lines

MAIN = """\
import helper
total = 0
for i in range(3):
    total += helper.inc(i)
"""

HELPER = """\
def inc(x):
    y = x + 1
    return y
"""


@pytest.fixture
def ws(tmp_path, monkeypatch):
    vs = tmp_path / ".vscode"
    vs.mkdir()
    main = tmp_path / "main.py"
    main.write_text(MAIN, encoding="utf-8")
    helper = tmp_path / "helper.py"
    helper.write_text(HELPER, encoding="utf-8")
    monkeypatch.syspath_prepend(str(tmp_path))
    monkeypatch.delitem(sys.modules, "helper", raising=False)
    monkeypatch.setattr(core, "session_vscode_dir", None)
    monkeypatch.setattr(core, "session_file", None)
    yield type("W", (), {"vs": vs, "main": main, "helper": helper})
    sys.modules.pop("helper", None)


def set_bps(ws, *items, form="dict", active=True, mode="trace"):
    """既定は従来のトレース方式（このファイルはトレースの高速パスのテスト）"""
    bps = [{"file": str(f), "line": ln, "enabled": True} for f, ln in items]
    data = {"active": active, "mode": mode, "breakpoints": bps} if form == "dict" else bps
    (ws.vs / core.BP_NAME).write_text(json.dumps(data), encoding="utf-8")


@pytest.fixture
def stops(monkeypatch):
    hits = []

    def interaction(self, frame, tb_or_exc):
        if frame is not None:
            hits.append((frame.f_code.co_filename, frame.f_lineno))
            self.set_continue()

    monkeypatch.setattr(core.VsPdb, "interaction", interaction)
    return hits


@pytest.fixture
def slow_calls(monkeypatch):
    """bdb の重い call 処理に入った回数（ファイル名ごと）"""
    calls = []
    orig = Bdb.dispatch_call

    def dispatch_call(self, frame, arg):
        calls.append(frame.f_code.co_filename)
        return orig(self, frame, arg)

    monkeypatch.setattr(Bdb, "dispatch_call", dispatch_call)
    return calls


def run(ws, **kw):
    core.run_script(ws.main, {}, **kw)


def test_functions_in_files_without_breakpoints_skip_dispatch(ws, stops, slow_calls):
    set_bps(ws, (ws.main, 4))  # helper.py に赤丸はない
    run(ws)
    assert len(stops) == 3
    assert str(ws.helper.resolve()) not in [str(f) for f in slow_calls]
    assert not any(f.endswith("helper.py") for f in slow_calls)


def test_breakpoint_in_another_file_still_stops(ws, stops):
    set_bps(ws, (ws.helper, 2))
    run(ws)
    assert [ln for _, ln in stops] == [2, 2, 2]
    assert all(f.endswith("helper.py") for f, _ in stops)


def test_breakpoint_elsewhere_does_not_trace_unrelated_calls(ws, stops, slow_calls):
    """実行に関係ないファイルに赤丸があるだけなら、どの呼び出しも近道で抜ける"""
    other = ws.vs.parent / "other.py"
    other.write_text("x = 1\n", encoding="utf-8")
    set_bps(ws, (other, 1))
    run(ws)
    assert stops == []
    assert not any(f.endswith("helper.py") for f in slow_calls)


def test_old_list_format_is_still_read(ws, stops):
    set_bps(ws, (ws.main, 4), form="list")
    run(ws)
    assert len(stops) == 3


def test_all_breakpoints_off_runs_without_tracing(ws, stops):
    set_bps(ws, (ws.main, 4), active=False)
    ns = {}
    core.run_script(ws.main, ns)
    assert stops == []
    assert ns["total"] == 6


def test_nobp_ignores_breakpoints(ws, stops):
    set_bps(ws, (ws.main, 4))
    ns = {}
    core.run_script(ws.main, ns, use_breakpoints=False)
    assert stops == []
    assert ns["total"] == 6


def test_nobp_for_cells(ws, stops):
    set_bps(ws, (ws.main, 4))
    core.run_cell(ws.main, 1, 4, {}, use_breakpoints=False)
    assert stops == []


def test_trace_info_is_reported_in_session_file(ws, stops, monkeypatch):
    seen = []
    sf = ws.vs / core.SESSION_NAME
    monkeypatch.setattr(core, "session_file", sf)

    orig = core.write_session

    def spy(busy):
        orig(busy)
        seen.append(json.loads(sf.read_text(encoding="utf-8")))

    monkeypatch.setattr(core, "write_session", spy)
    set_bps(ws, (ws.main, 4))
    run(ws)
    assert seen[0]["busy"] is True
    assert seen[0]["trace"]["bps"] == [{"file": str(ws.main.resolve()), "line": 4}]
    assert core.trace_info is None
    done = core.trace_done
    assert done["bps"] == seen[0]["trace"]["bps"] and done["sec"] >= 0
    core.write_session(False)
    assert json.loads(sf.read_text(encoding="utf-8"))["trace_done"]["id"] == done["id"]


def test_no_trace_info_without_breakpoints(ws, stops):
    set_bps(ws)
    core.trace_done = None
    run(ws)
    assert core.trace_info is None and core.trace_done is None


def test_split_flags():
    assert core.split_flags('--nobp "C:\\a b\\x.py"') == (False, True, '"C:\\a b\\x.py"')
    assert core.split_flags('--pm --nobp x.py') == (True, True, "x.py")
    assert core.split_flags('--nobp --pm x.py') == (True, True, "x.py")
    assert core.split_flags('"--nobpx.py"') == (False, False, '"--nobpx.py"')


def test_startup_lines_pass_nobp():
    lines = startup_lines("none", port=8988, script=r"C:\w\a.py", no_breakpoints=True)
    assert lines[-1] == r'%ipydesk --nobp "C:\w\a.py"'
