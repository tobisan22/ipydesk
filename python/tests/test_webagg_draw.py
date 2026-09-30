"""savefig とブラウザからの描画要求がぶつかる問題（0.0.6）の回帰テスト

savefig は保存の間だけ canvas.manager を None にする。webagg のサーバースレッドが
その間に "draw" 要求を処理すると、canvas.draw() の最後の
self.manager.refresh_all() が AttributeError で落ちていた。
（Figure の履歴は実行が終わるたびに savefig するので、図を開いたまま
matplotlib を使わない別スクリプトを F5 しただけで起きた）
"""

import threading
import time

import matplotlib

matplotlib.use("Agg")
import pytest  # noqa: E402
from matplotlib.backends import backend_webagg_core as core  # noqa: E402
from matplotlib.figure import Figure  # noqa: E402

from ipydesk import webagg  # noqa: E402


class FakeLoop:
    def __init__(self):
        self.later = []

    def call_later(self, delay, fn, *args):
        self.later.append((fn, args))


@pytest.fixture
def canvas(monkeypatch):
    webagg._install_draw_lock()
    loop = FakeLoop()
    monkeypatch.setattr(webagg, "_loop", loop)
    fig = Figure()
    fig.add_subplot().plot(range(100))
    c = core.FigureCanvasWebAggCore(fig)
    core.FigureManagerWebAgg(c, 1)  # c.manager が設定される
    c.loop = loop
    return c


def test_draw_while_manager_is_none_is_deferred(canvas):
    """manager が None（savefig 中）の draw 要求は落ちずに後でやり直す"""
    mgr = canvas.manager
    canvas.manager = None
    canvas.handle_event({"type": "draw"})  # 以前は AttributeError
    assert len(canvas.loop.later) == 1
    canvas.manager = mgr
    fn, args = canvas.loop.later.pop()
    fn(*args)  # やり直しは普通に描ける
    assert canvas.loop.later == []


def test_retry_gives_up(canvas):
    """manager が戻らない場合でも、やり直しは有限回で止まる"""
    canvas.manager = None
    canvas.handle_event({"type": "draw"})
    for _ in range(100):
        if not canvas.loop.later:
            break
        fn, args = canvas.loop.later.pop()
        fn(*args)
    assert canvas.loop.later == []


def test_savefig_and_draw_in_parallel(canvas):
    """メインスレッドの savefig と、別スレッドの draw 要求を同時に流しても落ちない"""
    errors = []
    stop = threading.Event()

    def browser():
        while not stop.is_set():
            try:
                canvas.handle_event({"type": "draw"})
            except Exception as e:  # noqa: BLE001
                errors.append(e)

    t = threading.Thread(target=browser)
    t.start()
    try:
        t0 = time.time()
        while time.time() - t0 < 1.5:
            import io

            canvas.figure.savefig(io.BytesIO(), format="png", dpi=50)
    finally:
        stop.set()
        t.join()
    assert errors == []
