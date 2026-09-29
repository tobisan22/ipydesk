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
