"""複数セッション（IPYDESK_SESSION_DIR）の回帰テスト

VS Code 拡張は、セッションごとに .vscode/py_sessions/<番号>/ を渡して
複数の IPython セッションを同時に動かす。赤丸 JSON だけは .vscode/ 直下を共有し、
停止位置・変数一覧・figure 一覧・保存要求はセッション専用ディレクトリへ書く。
"""

import json
import types

import pytest

from ipydesk import core, workspace

SAMPLE = """\
def f(k):
    z = k * 10
    return z

value = f(TAG)
"""


@pytest.fixture(autouse=True)
def fresh():
    workspace._previous.clear()


@pytest.fixture
def ws(tmp_path):
    """赤丸を 1 つ置いたワークスペースと、2 つのセッション用ディレクトリ"""
    vs = tmp_path / ".vscode"
    vs.mkdir()
    script = tmp_path / "s.py"
    script.write_text(SAMPLE, encoding="utf-8")
    (vs / core.BP_NAME).write_text(
        json.dumps([{"file": str(script), "line": 2, "enabled": True}]), encoding="utf-8")
    dirs = []
    for n in (1, 2):
        d = vs / "py_sessions" / str(n)
        d.mkdir(parents=True)
        dirs.append(d)
    return types.SimpleNamespace(vs=vs, script=script, dirs=dirs)


def use_session(monkeypatch, d):
    monkeypatch.setattr(core, "session_vscode_dir", d)
    monkeypatch.setattr(core, "session_file", d / core.SESSION_NAME if d else None)


def test_two_sessions_do_not_overwrite_each_other(ws, monkeypatch):
    """同じスクリプトを別セッションで走らせても、通知は各自のディレクトリに残る"""
    seen = {}

    def interaction(self, frame, tb):
        self.setup(frame, tb)
        self._write_state(frame)
        self.preloop()
        seen[self.out_dir.name] = json.loads(
            (self.out_dir / core.STATE_NAME).read_text(encoding="utf-8"))
        self.forget()
        self.set_continue()

    monkeypatch.setattr(core.VsPdb, "interaction", interaction)

    for d, tag in zip(ws.dirs, (1, 2)):
        use_session(monkeypatch, d)
        core.run_script(ws.script, {"TAG": tag})

    assert set(seen) == {"1", "2"}, "赤丸（共有）でどちらのセッションも止まる"
    assert all(s["line"] == 2 for s in seen.values())
    for d, tag in zip(ws.dirs, (1, 2)):
        data = json.loads((d / workspace.WORKSPACE_NAME).read_text(encoding="utf-8"))
        assert {v["name"]: v["value"] for v in data["vars"]}["k"] == str(tag), \
            "変数一覧はそのセッションの値"
    assert not (ws.vs / core.STATE_NAME).exists(), ".vscode/ 直下には書かない"
    assert not (ws.vs / workspace.WORKSPACE_NAME).exists()


def test_session_flag_is_per_session(ws, monkeypatch):
    """busy フラグ（F5 の送り先の判定に使う）はセッションごと"""
    use_session(monkeypatch, ws.dirs[0])
    core.write_session(True)
    use_session(monkeypatch, ws.dirs[1])
    core.write_session(False)

    def busy(d):
        return json.loads((d / core.SESSION_NAME).read_text(encoding="utf-8"))["busy"]

    assert busy(ws.dirs[0]) is True
    assert busy(ws.dirs[1]) is False


def test_without_session_dir_falls_back_to_vscode_dir(ws, monkeypatch):
    """IPYDESK_SESSION_DIR なし（ターミナルから python -m ipydesk）は従来どおり .vscode/ 直下"""
    use_session(monkeypatch, None)
    assert core.out_dir(ws.vs) == ws.vs


def test_save_request_goes_to_session_dir(ws, monkeypatch):
    """Figure の Download（保存要求）は、そのセッションのディレクトリに出る"""
    pytest.importorskip("matplotlib")
    pytest.importorskip("tornado")
    from matplotlib.backends import backend_webagg as W
    from matplotlib.backends import backend_webagg_core as wcore

    from ipydesk import webagg

    webagg._install_toolbar_items(W)
    use_session(monkeypatch, ws.dirs[1])
    monkeypatch.chdir(ws.vs.parent)

    messages = []
    toolbar = types.SimpleNamespace(
        canvas=types.SimpleNamespace(manager=types.SimpleNamespace(num=3)),
        set_message=messages.append,
    )
    wcore.NavigationToolbar2WebAgg.ipydesk_save(toolbar, "svg")

    req = json.loads((ws.dirs[1] / webagg.SAVE_REQUEST_NAME).read_text(encoding="utf-8"))
    assert req["figure"] == 3 and req["format"] == "svg"
    assert not (ws.vs / webagg.SAVE_REQUEST_NAME).exists(), ".vscode/ 直下には書かない"
    assert not (ws.dirs[0] / webagg.SAVE_REQUEST_NAME).exists(), "別セッションには書かない"
