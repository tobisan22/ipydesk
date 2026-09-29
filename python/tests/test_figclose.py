"""Figure タブを閉じたときの close 要求（py_figclose_*.json）の回帰テスト

タブを閉じた figure が Python に残ると、次の通知でタブが開き直され、
plt.plot も閉じたはずの図に描き足してしまう。要求どおりに閉じることを固定する。
"""

import json

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import pytest  # noqa: E402
from matplotlib._pylab_helpers import Gcf  # noqa: E402

from ipydesk import core, fighist  # noqa: E402


@pytest.fixture(autouse=True)
def fresh(monkeypatch):
    plt.close("all")
    fighist.reset()
    monkeypatch.setenv("IPYDESK_FIG_HISTORY", "3")
    yield
    plt.close("all")


def fid(num):
    return f"{id(Gcf.figs[num]):x}"


def request(d, num, id_, name="a"):
    (d / f"{core.FIG_CLOSE_PREFIX}{name}_{num}.json").write_text(
        json.dumps({"num": num, "id": id_}), encoding="utf-8")


def test_closes_requested_figure_and_removes_request(tmp_path):
    plt.figure(1)
    plt.plot([1, 2])
    plt.figure(2)
    plt.plot([2, 1])
    request(tmp_path, 1, fid(1))
    core.apply_figure_closes(tmp_path)
    assert plt.get_fignums() == [2]
    assert not list(tmp_path.glob(core.FIG_CLOSE_PREFIX + "*"))


def test_plot_after_close_goes_to_new_figure(tmp_path):
    """閉じたタブの図に描き足さない（MATLAB で図を閉じてから plot したのと同じ）"""
    plt.plot([1, 2, 3])
    old = plt.gcf()
    request(tmp_path, 1, fid(1))
    core.apply_figure_closes(tmp_path)
    plt.plot([3, 2, 1])
    assert plt.gcf() is not old
    assert len(plt.gcf().axes[0].lines) == 1


def test_recreated_figure_is_not_closed(tmp_path):
    """要求を書いた後に同じ番号で作り直された figure は閉じない"""
    plt.figure(1)
    stale = fid(1)
    plt.close(1)
    plt.figure(1)
    plt.plot([1, 2])
    if fid(1) == stale:  # 同じアドレスが使い回されたら判定できないので飛ばす
        pytest.skip("id reused")
    request(tmp_path, 1, stale)
    core.apply_figure_closes(tmp_path)
    assert plt.get_fignums() == [1]


def test_closed_figure_history_is_forgotten(tmp_path):
    """閉じた図の履歴は、同じ番号で作った新しい図に引き継がない"""
    plt.figure(1)
    plt.plot([1, 2, 3])
    fighist.capture(tmp_path)
    plt.clf()
    plt.plot([3, 2, 1])
    assert fighist.capture(tmp_path)
    assert fighist._history.get(1)
    request(tmp_path, 1, fid(1))
    core.apply_figure_closes(tmp_path)
    assert not fighist._history.get(1)
    assert not list((tmp_path / fighist.HIST_DIR).glob("*.png"))
    plt.figure(1)
    plt.plot([5, 5])
    assert not fighist.capture(tmp_path), "新しい図は初めて見た図として扱う"


def test_broken_request_is_ignored(tmp_path):
    plt.figure(1)
    (tmp_path / f"{core.FIG_CLOSE_PREFIX}x_1.json").write_text("{", encoding="utf-8")
    core.apply_figure_closes(tmp_path)
    assert plt.get_fignums() == [1]
    assert not list(tmp_path.glob(core.FIG_CLOSE_PREFIX + "*"))
