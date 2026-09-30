"""matplotlib webagg サーバーをバックグラウンドスレッドで常駐させる"""

from __future__ import annotations

import asyncio
import json as _jsonmod
import os
import subprocess
import sys
import tempfile
import threading
import time
from io import BytesIO
from pathlib import Path

IMAGES_DIR = Path(__file__).parent / "images"
SAVE_REQUEST_NAME = "py_save_request.json"

# webview では window.open がブロックされ Download ボタンが無反応になるため、
# 保存要求をサーバー経由（toolbar_button イベント）で VS Code 拡張へ渡す。
# mpl_tornado.js が定義する mpl_ondownload を、mpl.js の直後に上書きする。
_EXTRA_JS = """
// ---- ipydesk ----
window.mpl_ondownload = function (figure, format) {
    figure.send_message('toolbar_button', { name: 'ipydesk_save', format: format });
};
"""

_loop = None
_thread = None
url: str | None = None

# figure の描画を 1 つずつ行うためのロック。
# webagg のブラウザからの要求（描画・リサイズ・マウス操作）はサーバースレッドで処理される一方、
# savefig（Figure の履歴の記録・スクリプト中の fig.savefig）は IPython 側のメインスレッドで動く。
# 両者が同時に同じ figure を描くと壊れるので、どちらもこのロックの中で行う。
# 同じスレッドからの入れ子（Copy ボタン → savefig）があるので RLock にする。
lock = threading.RLock()

# savefig 中に来たブラウザからの要求をやり直す間隔と回数（0.05 秒 × 40 回 = 最大 2 秒待つ）
_RETRY_SEC = 0.05
_RETRY_MAX = 40


def _force_full_redraw_on_resize() -> None:
    """resize のたびにフル画像を返させる。

    ブラウザ側の mpl.js は canvas の width/height 属性を書き換えた時点で中身を捨てる
    （HTML の仕様）。一方 matplotlib の handle_resize は _png_is_old を立てるだけで
    _force_full を立てないため、「同じサイズへの resize」では差分画像しか返らない。
    その結果、空になった canvas に空の差分が重なって永久に空白のままになる。

    これは figure タブが背面で開かれると必ず起きる。背面では ResizeObserver が
    発火せず canvas が未サイズのままフル画像を受け取り、表示された瞬間に
    ResizeObserver が発火して canvas を消去 → 同サイズ resize、という順序になるため。
    """
    from matplotlib.backends import backend_webagg_core as core

    canvas_cls = core.FigureCanvasWebAggCore
    if getattr(canvas_cls.handle_resize, "_ipydesk_patched", False):
        return
    _orig = canvas_cls.handle_resize

    def handle_resize(self, event):
        self._force_full = True
        return _orig(self, event)

    handle_resize._ipydesk_patched = True
    canvas_cls.handle_resize = handle_resize


def _install_draw_lock() -> None:
    """savefig とブラウザからの描画要求がぶつからないようにする。

    matplotlib の savefig（print_figure）は、GUI を揺らさないよう保存の間だけ
    canvas.manager を None にする。そこへ別スレッドのサーバーがブラウザの "draw" 要求を
    処理すると、canvas.draw() の最後の self.manager.refresh_all() が
    AttributeError: 'NoneType' object has no attribute 'refresh_all' で落ちる。
    （Figure の履歴は実行が終わるたびに savefig で図を画像にするので、図を開いたまま
    matplotlib を使わない別のスクリプトを F5 しただけでも起きていた）

    - print_figure と handle_event を同じロックで挟み、同時に動かないようにする
    - それでも manager が無い（ロックの外で保存中など）ときは、要求を捨てずに少し後でやり直す
    """
    from matplotlib.backends import backend_webagg_core as core

    canvas_cls = core.FigureCanvasWebAggCore
    if getattr(canvas_cls, "_ipydesk_draw_lock", False):
        return
    _print, _handle = canvas_cls.print_figure, canvas_cls.handle_event

    def print_figure(self, *args, **kwargs):
        with lock:
            return _print(self, *args, **kwargs)

    def handle_event(self, event, _tries=0):
        with lock:
            if self.manager is not None and not getattr(self, "_is_saving", False):
                return _handle(self, event)
        if _loop is not None and _tries < _RETRY_MAX:
            _loop.call_later(_RETRY_SEC, handle_event, self, event, _tries + 1)
        return None

    canvas_cls.print_figure = print_figure
    canvas_cls.handle_event = handle_event
    canvas_cls._ipydesk_draw_lock = True


def _clipboard_ps(png_path: Path) -> None:
    """PNG を Windows のクリップボードへ入れる（拡張側と同じ PowerShell 経由）"""
    subprocess.run(
        [
            "powershell.exe", "-STA", "-NoProfile", "-ExecutionPolicy", "Bypass",
            "-Command",
            "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; "
            "$i=[System.Drawing.Image]::FromFile($env:IPYDESK_CLIP_PNG); "
            "[System.Windows.Forms.Clipboard]::SetImage($i); $i.Dispose()",
        ],
        env={**os.environ, "IPYDESK_CLIP_PNG": str(png_path)},
        check=True,
        capture_output=True,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )


def _install_toolbar_items(W) -> None:
    """ツールバーに Copy を足し、Download を VS Code の保存ダイアログへ繋ぐ"""
    from matplotlib.backends import backend_webagg_core as core

    TB = core.NavigationToolbar2WebAgg
    if getattr(TB, "_ipydesk_toolbar", False):
        return

    def ipydesk_copy(self):
        """figure を PNG にしてクリップボードへ入れる"""
        if sys.platform != "win32":
            # 非 Windows では powershell.exe が無く、分かりにくいエラーになるため先に断る
            self.set_message("クリップボードへのコピーは Windows のみ対応です")
            return
        buf = BytesIO()
        self.canvas.figure.savefig(buf, format="png")
        data = buf.getvalue()

        def work():
            tmp = Path(tempfile.gettempdir()) / f"ipydesk-clip-{os.getpid()}.png"
            try:
                tmp.write_bytes(data)
                _clipboard_ps(tmp)
                self.set_message("クリップボードにコピーしました")
            except Exception as e:  # noqa: BLE001 - 画面にそのまま出す
                self.set_message(f"コピーに失敗しました: {e}")
            finally:
                tmp.unlink(missing_ok=True)

        # PowerShell の起動で tornado のループを止めない
        threading.Thread(target=work, name="ipydesk-clip", daemon=True).start()
        self.set_message("クリップボードにコピー中…")

    def ipydesk_save(self, fmt="png"):
        """保存要求を書き出し、VS Code 拡張に保存ダイアログを開いてもらう"""
        from ipydesk.core import find_vscode_dir, out_dir

        num = getattr(self.canvas.manager, "num", 1)
        vsdir = out_dir(find_vscode_dir(Path.cwd()))
        if vsdir is None:
            self.set_message("保存先を決める VS Code 拡張が見つかりません")
            return
        (vsdir / SAVE_REQUEST_NAME).write_text(
            _jsonmod.dumps({"figure": num, "format": fmt or "png", "ts": time.time()}),
            encoding="utf-8",
        )
        self.set_message(f"Figure {num} の保存ダイアログを開いています…")

    TB.ipydesk_copy = ipydesk_copy
    TB.ipydesk_save = ipydesk_save
    TB.toolitems = [
        *TB.toolitems,
        ("Copy", "画像をクリップボードにコピー", "ipydesk_copy", "ipydesk_copy"),
    ]
    TB._ipydesk_toolbar = True

    # ボタン押下の振り分け。標準の handle_toolbar_button は引数を渡さないため、
    # 保存形式（ドロップダウンの選択）を受け取れるようここで分岐する。
    canvas_cls = core.FigureCanvasWebAggCore
    _orig = canvas_cls.handle_toolbar_button

    def handle_toolbar_button(self, event):
        name = event.get("name")
        if name == "ipydesk_copy":
            return self.toolbar.ipydesk_copy()
        if name == "ipydesk_save":
            return self.toolbar.ipydesk_save(event.get("format") or "png")
        return _orig(self, event)

    canvas_cls.handle_toolbar_button = handle_toolbar_button


def _install_assets(W) -> None:
    """ipydesk 独自のツールバーアイコン配信と、mpl.js への追記"""
    import tornado.web

    app_cls = W.WebAggApplication
    if getattr(app_cls, "_ipydesk_assets", False):
        return

    _app_init = app_cls.__init__

    def __init__(self, url_prefix=""):
        _app_init(self, url_prefix)
        # add_handlers は __init__ で渡したハンドラ群より前に挿入される。
        # matplotlib のインストール先は変更せず、ipydesk_ で始まる画像だけを横取りする。
        self.add_handlers(
            r".*",
            [(url_prefix + r"/_images/(ipydesk_[^/]+\.png)",
              tornado.web.StaticFileHandler, {"path": str(IMAGES_DIR)})],
        )

    app_cls.__init__ = __init__

    _mpljs_get = app_cls.MplJs.get

    def get(self):
        _mpljs_get(self)
        self.write(_EXTRA_JS)

    app_cls.MplJs.get = get
    app_cls._ipydesk_assets = True


def _install_threadsafe_send(W) -> None:
    """WebSocket への書き込みをサーバースレッドのループへ委譲する。

    メインスレッド（IPython 側）の描画更新が、別スレッドで回っている tornado の
    WebSocket へ直接書き込むのを防ぐ。
    """
    ws = W.WebAggApplication.WebSocket
    if getattr(ws, "_ipydesk_threadsafe", False):
        return
    _json, _bin = ws.send_json, ws.send_binary

    def send_json(self, content):
        _loop.add_callback(_json, self, content)

    def send_binary(self, blob):
        _loop.add_callback(_bin, self, blob)

    ws.send_json = send_json
    ws.send_binary = send_binary
    ws._ipydesk_threadsafe = True


def start_server(port: int = 8988, address: str = "127.0.0.1") -> str:
    global _loop, _thread, url
    if _thread is not None:
        return url

    import matplotlib as mpl
    import tornado.ioloop
    from matplotlib.backends import backend_webagg as W

    # WebAggApplication.initialize は受け取った port 引数を使わず rcParams を見る。
    # さらにそのポートが埋まっていると黙って隣のポートへずらすので、
    # 「要求したポート」ではなく実際に bind された WebAggApplication.port で url を作る。
    mpl.rcParams["webagg.port"] = port
    mpl.rcParams["webagg.address"] = address

    _force_full_redraw_on_resize()
    _install_draw_lock()
    _install_toolbar_items(W)
    _install_assets(W)
    _install_threadsafe_send(W)

    ready = threading.Event()

    def _serve():
        global _loop
        asyncio.set_event_loop(asyncio.new_event_loop())
        _loop = tornado.ioloop.IOLoop.current()
        W.WebAggApplication.initialize(port=port, address=address)
        W.WebAggApplication.started = (
            True  # plt.show() が mainloop を回さないようにする
        )
        ready.set()
        _loop.start()

    _thread = threading.Thread(target=_serve, name="ipydesk-webagg", daemon=True)
    _thread.start()
    if not ready.wait(timeout=5):
        raise RuntimeError("ipydesk: webagg サーバーの起動がタイムアウトしました")

    actual = getattr(W.WebAggApplication, "port", port)
    if actual != port:
        print(f"[ipydesk] 警告: ポート {port} は使用中のため {actual} で起動しました")
    url = f"http://{address}:{actual}"
    return url
