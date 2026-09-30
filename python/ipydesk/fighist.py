"""
ipydesk.fighist — Figure の履歴。描き直した図の「前の姿」を画像で残す。

同じ figure 番号を描き直すと（plt.clf() して描く・close して同じ番号で作り直す・
Variable Editor の Plot を押し直す など）、前の図は消えてしまう。そこで実行の区切りごとに
figure の見た目を記録し、変わっていたら前の姿を PNG にして残す。
Figure タブでは、残した図が上に時系列で並び、いちばん下に今の図が出る（スクロールで遡る）。

記録する区切り（core から呼ばれる）:
  - F5 / セル実行の終わり
  - プロンプトで打った 1 行の後
  - ブレークポイントで停止したとき・停止中に打ったコマンドの後
  - 実行の途中で figure が消される直前（0.0.6〜）。ループの中で
    plt.subplots(num=0, clear=True) / plt.clf() / plt.close して描き直すと、
    区切りでは最後の姿しか見えないため、消される前の姿をその場で画像にする。
    Figure.clear と Gcf.destroy / destroy_all を横取りして行う（install）。
    画像化は重いので、1 回の実行で 1 figure あたり履歴の上限枚数まで（最初の N 枚）

方針:
  - 変更の検出は安い方法で行う。figure の stale 通知（中身が変わると必ず来る）を数えておき、
    数が変わった figure だけを画像にする。何も描いていない実行では何もしない
  - 画像にしても見た目が同じ（ハッシュが一致）なら履歴には足さない
  - 何も描かれていない figure（Axes が無い）は履歴に残さない
  - 1 figure あたり最大 IPYDESK_FIG_HISTORY 枚（既定 20、0 で無効）。古いものから消す
"""

from __future__ import annotations

import hashlib
import os
import sys
import time
from io import BytesIO
from pathlib import Path
from typing import Any

HIST_DIR = "fighist"


def _limit() -> int:
    try:
        return max(0, int(os.environ.get("IPYDESK_FIG_HISTORY", "20")))
    except ValueError:
        return 20


# figure 番号 → 今の姿 {"fid", "ver", "hash", "png", "time", "label", "w", "h", "empty"}
_current: dict[int, dict] = {}
# figure 番号 → 残した姿のリスト（古い順）[{"seq", "file", "time", "label", "w", "h"}]
_history: dict[int, list[dict]] = {}
_seq = 0

# 今の実行の名前（履歴の見出しに出す）。core が実行のたびに設定する
label = ""


# 実行途中の記録（install が設定する）
_folder: Path | None = None  # 途中の姿を書き出す先（webagg 稼働中のセッションだけ設定される）
_steps: dict[int, int] = {}  # 今の実行で figure ごとに途中の姿を残した枚数
_skipped: dict[int, int] = {}  # 上限を超えて残さなかった枚数（実行の終わりに一度だけ知らせる）
_suspend = 0  # Figure タブを閉じたときの plt.close など、途中の記録をしない区間


def set_label(text: str) -> None:
    """実行の区切りごとに呼ばれる。途中の記録の枚数もここで数え直す"""
    global label
    text = " ".join(str(text).split())
    label = text if len(text) <= 60 else text[:59] + "…"
    _steps.clear()
    _skipped.clear()


def _track(fig) -> None:
    """figure の中身が変わるたびに数を増やす（stale 通知を横取りして元の処理も呼ぶ）"""
    if getattr(fig, "_ipydesk_tracked", False):
        return
    orig = fig.stale_callback

    def cb(f, val):
        f._ipydesk_ver = getattr(f, "_ipydesk_ver", 0) + 1
        if orig is not None:
            orig(f, val)

    fig.stale_callback = cb
    fig._ipydesk_ver = 1
    fig._ipydesk_tracked = True


def _render(fig) -> tuple[bytes, float, float]:
    """(PNG, 表示幅 px, 表示高さ px)。高 DPI の画面では dpi が倍になっているので、表示は割り戻す"""
    buf = BytesIO()
    fig.savefig(buf, format="png", dpi="figure")
    ratio = getattr(fig.canvas, "device_pixel_ratio", 1) or 1
    return buf.getvalue(), fig.bbox.width / ratio, fig.bbox.height / ratio


def _figures() -> dict[int, Any]:
    """番号 → Figure（plt.figure(num) はアクティブな figure を変えてしまうので使わない）"""
    from matplotlib._pylab_helpers import Gcf

    return {num: m.canvas.figure for num, m in sorted(Gcf.figs.items())}


def capture(folder: Path | None) -> bool:
    """figure の今の姿を記録し、変わっていれば前の姿を履歴に移す。履歴が増えたら True"""
    global _seq
    limit = _limit()
    if folder is None or limit == 0 or "matplotlib.pyplot" not in sys.modules:
        return False
    changed = False
    for num, fig in _figures().items():
        try:
            _track(fig)
            cur = _current.get(num)
            if cur is not None and cur["fid"] == id(fig) and cur["ver"] == fig._ipydesk_ver:
                continue  # 前回から触られていない
            empty = len(fig.axes) == 0
            png, w, h = _render(fig) if not empty else (b"", 0.0, 0.0)
            digest = hashlib.sha1(png).hexdigest()
            ver = fig._ipydesk_ver  # 描画で stale が立つことがあるので、描いた後の数を覚える
            if cur is not None and cur["hash"] == digest:
                cur.update(fid=id(fig), ver=ver)
                continue  # 見た目は同じ
            if cur is not None and not cur["empty"]:
                changed |= _push(folder, num, cur, limit)
            _current[num] = {
                "fid": id(fig), "ver": ver, "hash": digest, "png": png, "empty": empty,
                "time": time.strftime("%H:%M:%S"), "label": label, "w": w, "h": h,
            }
        except Exception as e:  # 図の記録で実行を止めない
            print(f"[ipydesk] Figure {num} の履歴の記録に失敗: {e}", file=sys.stderr)
    return changed


# ---- 実行途中の記録 ---------------------------------------------------------


class suspended:
    """この中の close / clear では途中の姿を記録しない（with fighist.suspended(): ...）"""

    def __enter__(self):
        global _suspend
        _suspend += 1

    def __exit__(self, *exc):
        global _suspend
        _suspend -= 1


def _num_of(fig) -> int | None:
    from matplotlib._pylab_helpers import Gcf

    for num, m in Gcf.figs.items():
        if m.canvas.figure is fig:
            return num
    return None


def before_erase(fig, num: int | None = None) -> None:
    """figure が消される（clear / close）直前に呼ぶ。前回の記録から変わっていれば、
    今の姿を「今の姿」として記録し、それまでの「今の姿」を履歴へ移す。

    実行の終わりの capture は「今の姿」と比べて前の姿を履歴に積むので、ここで
    途中の姿を「今の姿」に入れておけば、ループで描き直した分が順に履歴へ並ぶ。
    """
    global _seq
    folder, limit = _folder, _limit()
    if folder is None or limit == 0 or _suspend:
        return
    try:
        if num is None:
            num = _num_of(fig)
        if num is None or len(fig.axes) == 0:
            return  # pyplot 管理外の figure・何も描いていない figure
        _track(fig)
        cur = _current.get(num)
        if cur is not None and cur["fid"] == id(fig) and cur["ver"] == fig._ipydesk_ver:
            return  # 前回の記録から触られていない（その姿は記録済み）
        if _steps.get(num, 0) >= limit:
            _skipped[num] = _skipped.get(num, 0) + 1
            return
        png, w, h = _render(fig)
        digest = hashlib.sha1(png).hexdigest()
        if cur is not None and cur["hash"] == digest:
            return
        if cur is not None and not cur["empty"]:
            _push(folder, num, cur, limit)
        _steps[num] = _steps.get(num, 0) + 1
        _current[num] = {
            "fid": id(fig), "ver": fig._ipydesk_ver, "hash": digest, "png": png,
            "empty": False, "time": time.strftime("%H:%M:%S"),
            "label": f"{label} · 途中 {_steps[num]}" if label else f"途中 {_steps[num]}",
            "w": w, "h": h,
        }
    except Exception as e:  # 図の記録で実行を止めない
        print(f"[ipydesk] Figure {num} の途中の図の記録に失敗: {e}", file=sys.stderr)


def report_skipped() -> None:
    """上限で残さなかった途中の図があれば一度だけ知らせる（実行の終わりに呼ぶ）"""
    for num, n in sorted(_skipped.items()):
        print(
            f"[ipydesk] Figure {num}: 途中の図は最初の {_limit()} 枚だけ履歴に残しました"
            f"（残りの {n} 枚は省略。上限は設定 ipydesk.figureHistory）",
            file=sys.stderr,
        )
    _skipped.clear()


def install(folder: Path | None) -> None:
    """途中の記録の書き出し先を決め、matplotlib の clear / close を横取りする（何度呼んでもよい）"""
    global _folder
    _folder = folder
    if folder is None and "matplotlib.figure" not in sys.modules:
        return  # 図を使わないセッションでは matplotlib を読み込まない
    # webagg 稼働中でも、起動直後は matplotlib.figure がまだ読み込まれていない
    # （最初のスクリプトの import matplotlib.pyplot で読み込まれる）。
    # その前に横取りしておかないと、1 回目の実行の途中の図が残らない
    from matplotlib._pylab_helpers import Gcf
    from matplotlib.figure import Figure

    if not getattr(Figure.clear, "_ipydesk_hist", False):
        _clear = Figure.clear

        def clear(self, *args, **kwargs):
            before_erase(self)
            return _clear(self, *args, **kwargs)

        clear._ipydesk_hist = True
        Figure.clear = clear
        Figure.clf = _wrap_clf(Figure.clf)

    if not getattr(Gcf.destroy, "_ipydesk_hist", False):
        _destroy, _destroy_all = Gcf.destroy.__func__, Gcf.destroy_all.__func__

        def destroy(cls, num):
            m = num if hasattr(num, "canvas") else cls.figs.get(num)
            if m is not None and cls.figs.get(m.num) is m:
                before_erase(m.canvas.figure, m.num)
            return _destroy(cls, num)

        def destroy_all(cls):
            for n, m in list(cls.figs.items()):
                before_erase(m.canvas.figure, n)
            return _destroy_all(cls)

        destroy._ipydesk_hist = True
        Gcf.destroy = classmethod(destroy)
        Gcf.destroy_all = classmethod(destroy_all)


def _wrap_clf(clf):
    """clf は中で clear を呼ぶ版と呼ばない版がある。呼ぶ版で二重に記録しても、
    2 回目は「触られていない」扱いで何もしないので、常に包んでおく"""
    if getattr(clf, "_ipydesk_hist", False):
        return clf

    def wrapped(self, *args, **kwargs):
        before_erase(self)
        return clf(self, *args, **kwargs)

    wrapped._ipydesk_hist = True
    return wrapped


def _push(folder: Path, num: int, snap: dict, limit: int) -> bool:
    global _seq
    _seq += 1
    d = folder / HIST_DIR
    d.mkdir(parents=True, exist_ok=True)
    name = f"{num}_{_seq:05d}.png"
    (d / name).write_bytes(snap["png"])
    items = _history.setdefault(num, [])
    items.append({
        "seq": _seq, "file": f"{HIST_DIR}/{name}", "time": snap["time"],
        "label": snap["label"], "w": round(snap["w"]), "h": round(snap["h"]),
    })
    while len(items) > limit:
        old = items.pop(0)
        try:
            (folder / old["file"]).unlink()
        except OSError:
            pass
    return True


def payload(nums: list[int]) -> dict:
    """py_figures.json に載せる履歴と今の姿の見出し"""
    return {
        "history": {str(n): _history.get(n, []) for n in nums if _history.get(n)},
        "current": {
            str(n): {"time": c["time"], "label": c["label"]}
            for n in nums if (c := _current.get(n)) is not None
        },
    }


def forget(num: int, folder: Path | None = None) -> None:
    """figure を閉じたとき（Figure タブを閉じた）に、その番号の今の姿と履歴を捨てる"""
    _current.pop(num, None)
    for h in _history.pop(num, []):
        if folder is not None:
            try:
                (folder / h["file"]).unlink()
            except OSError:
                pass


def reset() -> None:
    """テスト用"""
    global _seq, label, _folder
    _current.clear()
    _history.clear()
    _steps.clear()
    _skipped.clear()
    _seq = 0
    label = ""
    _folder = None
