"""Figure の履歴（ipydesk.fighist）の回帰テスト

描き直したときだけ前の姿が残ること、変わっていなければ何もしないこと、上限を守ることを固定する。
"""

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import pytest  # noqa: E402

from ipydesk import fighist  # noqa: E402


@pytest.fixture(autouse=True)
def fresh(monkeypatch):
    plt.close("all")
    fighist.reset()
    monkeypatch.setenv("IPYDESK_FIG_HISTORY", "3")
    yield
    plt.close("all")


def hist(num=1):
    return fighist._history.get(num, [])


def test_redraw_keeps_previous(tmp_path):
    plt.figure(1)
    plt.plot([1, 2, 3])
    fighist.set_label("main.py")
    assert not fighist.capture(tmp_path), "初めて見た図は履歴にしない"
    plt.clf()
    plt.plot([3, 2, 1])
    fighist.set_label("main.py")
    assert fighist.capture(tmp_path)
    (h,) = hist()
    assert h["label"] == "main.py" and (tmp_path / h["file"]).exists()
    assert h["w"] > 0 and h["h"] > 0


def test_untouched_or_same_look_is_ignored(tmp_path):
    plt.figure(1)
    plt.plot([1, 2])
    fighist.capture(tmp_path)
    assert not fighist.capture(tmp_path), "触っていなければ何もしない"
    plt.clf()
    plt.plot([1, 2])  # 同じ見た目に描き直す
    assert not fighist.capture(tmp_path) and hist() == []


def test_close_and_recreate_same_number(tmp_path):
    plt.figure(1)
    plt.plot([1, 2])
    fighist.capture(tmp_path)
    plt.close(1)
    plt.figure(1)
    plt.plot([5, 1])
    assert fighist.capture(tmp_path) and len(hist()) == 1


def test_empty_figure_is_not_kept(tmp_path):
    plt.figure(1)
    fighist.capture(tmp_path)
    plt.plot([1, 2])
    assert not fighist.capture(tmp_path), "空の figure は履歴に残さない"


def test_limit_drops_oldest_files(tmp_path):
    plt.figure(1)
    for i in range(6):
        plt.clf()
        plt.plot([0, i + 1])
        fighist.capture(tmp_path)
    assert len(hist()) == 3
    assert len(list((tmp_path / fighist.HIST_DIR).glob("1_*.png"))) == 3
    assert [h["seq"] for h in hist()] == sorted(h["seq"] for h in hist())


def test_disabled_with_zero(tmp_path, monkeypatch):
    monkeypatch.setenv("IPYDESK_FIG_HISTORY", "0")
    plt.figure(1)
    plt.plot([1])
    fighist.capture(tmp_path)
    plt.clf()
    plt.plot([2, 3])
    assert not fighist.capture(tmp_path)


def test_payload_only_for_live_figures(tmp_path):
    plt.figure(1)
    plt.plot([1, 2])
    fighist.capture(tmp_path)
    plt.clf()
    plt.plot([2, 1])
    fighist.capture(tmp_path)
    p = fighist.payload([1])
    assert len(p["history"]["1"]) == 1 and "1" in p["current"]
    assert fighist.payload([2]) == {"history": {}, "current": {}}


# ---- 実行の途中で描き直した図（0.0.6） ------------------------------------------


def loop_script(n):
    import numpy as np

    x = np.linspace(0, 6, 50)
    for i in range(1, n + 1):
        fig, ax = plt.subplots(clear=True, num=0)
        fig.set_size_inches(4, 3)
        ax.plot(x, np.sin(x * i))


def test_loop_redraw_keeps_intermediate(tmp_path):
    """ループで同じ番号を clear=True で描き直すと、途中の図が順に履歴へ並ぶ"""
    fighist.install(tmp_path)
    fighist.set_label("loop.py")
    loop_script(3)
    fighist.capture(tmp_path)
    labels = [h["label"] for h in hist(0)]
    assert labels == ["loop.py · 途中 1", "loop.py · 途中 2"]  # 3 枚目は「今の姿」
    assert fighist._current[0]["label"] == "loop.py"
    assert all((tmp_path / h["file"]).exists() for h in hist(0))

    # もう一度実行すると、前回の最後の姿も履歴に入る
    fighist.set_label("loop.py")
    loop_script(3)
    fighist.capture(tmp_path)
    assert len(hist(0)) == 3  # 上限 3


def test_clf_and_close_in_loop(tmp_path):
    fighist.install(tmp_path)
    fighist.set_label("a.py")
    plt.figure(1)
    plt.plot([1, 2])
    plt.clf()
    plt.plot([2, 1])
    plt.close(1)
    plt.figure(1)
    plt.plot([1, 1])
    fighist.capture(tmp_path)
    assert [h["label"] for h in hist(1)] == ["a.py · 途中 1", "a.py · 途中 2"]


def test_intermediate_limit_per_run(tmp_path, capsys):
    """途中の図は 1 回の実行で上限枚数まで。超えた分は省略して知らせる"""
    fighist.install(tmp_path)
    fighist.set_label("loop.py")
    loop_script(6)
    assert fighist._steps[0] == 3 and fighist._skipped[0] == 2
    fighist.report_skipped()
    assert "残りの 2 枚は省略" in capsys.readouterr().err


def test_not_installed_or_suspended_does_nothing(tmp_path):
    fighist.set_label("a.py")  # install していない（webagg 以外のバックエンド）
    loop_script(3)
    assert hist(0) == [] and 0 not in fighist._current
    fighist.install(tmp_path)
    with fighist.suspended():
        plt.close(0)
    assert 0 not in fighist._current
