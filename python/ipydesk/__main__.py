"""
python -m ipydesk [script.py] [--cell START END] [--pm]

IPython セッションを起動し、%ipydesk / %ipydesk_cell マジックを登録する。
script.py が渡されていれば起動直後にそれを実行し、終了後もセッションを維持する。
--cell を付けると、スクリプト全体ではなくその行範囲（1 始まり・両端含む）だけを実行する。
VS Code からセル実行したときに、セッションがまだ無い場合の起動で使われる。
--pm を付けると、その最初の実行でエラーが出たときにその行で止まる（VS Code の Alt+F5）。

環境変数:
  IPYDESK_MPL   matplotlib バックエンド (既定 "webagg")。"qt", "tk", "inline",
             "none"（表示しない = Agg。webagg サーバーもポートも使わない）、
             および "auto"（Qt → Tk → webagg の順に、入っているものを選ぶ）。
             VS Code から起動した場合は設定 ipydesk.figureDisplay が決める
  IPYDESK_PORT  webagg のポート (既定 8988)。VS Code 設定 ipydesk.webaggPort から渡される
  IPYDESK_FILE  赤丸 JSON のパスを明示したい場合
  IPYDESK_SESSION_DIR  停止位置・figure・変数一覧などの通知ファイルを書くディレクトリ。
             VS Code 拡張が .vscode/py_sessions/<番号>/ を渡し、複数セッションを
             同時に動かせるようにする。未設定なら .vscode/ 直下（単一セッション）
"""

from __future__ import annotations

import atexit
import json
import os
import sys
from pathlib import Path

# Intel Fortran ランタイム（conda の MKL 版 numpy / scipy）は、読み込まれた時点で
# 独自の Ctrl+C ハンドラを入れ、Ctrl+C を受けると "forrtl: error (200)" でプロセスごと
# 終了させる。これだとセッション全体が落ち、実行中のコマンドだけを止められない。
# DLL が読み込まれる前（numpy / scipy を import する前）に無効化しておく。
# VS Code 拡張からは環境変数でも渡しているが、ターミナルから直接起動した場合に備える。
os.environ.setdefault("FOR_DISABLE_CONSOLE_CTRL_HANDLER", "1")

from IPython.terminal.ipapp import TerminalIPythonApp
from traitlets import List, Unicode
from traitlets.config import Config

from . import core
from .core import FIGURES_NAME, SESSION_NAME, find_vscode_dir
from .workspace import WORKSPACE_NAME


# "auto" を解決するときに探す GUI バインディング。先に見つかった方を使う。
_GUI_BINDINGS = (
    ("qt", ("PyQt5", "PyQt6", "PySide6", "PySide2")),
    ("tk", ("tkinter",)),
)


def resolve_backend(mpl: str) -> str:
    """"auto" を、その環境で実際に使えるバックエンド名へ解決する。

    別ウィンドウ表示（VS Code 設定 ipydesk.figureDisplay = window）で使う。
    Qt も Tk も無い環境で %matplotlib qt に失敗すると、バックエンドが既定のまま
    残って図が一切出なくなるため、ここで webagg へ落としておく。
    """
    if mpl != "auto":
        return mpl

    import importlib.util as u

    for gui, mods in _GUI_BINDINGS:
        for mod in mods:
            try:
                found = u.find_spec(mod) is not None
            except (ImportError, ValueError):
                found = False
            if found:
                return gui
    print("[ipydesk] 警告: Qt / Tk が見つからないため webagg で表示します")
    return "webagg"


def startup_lines(
    mpl: str,
    port: int,
    script: str | Path | None,
    cell: tuple[int, int] | None = None,
    post_mortem: bool = False,
) -> list[str]:
    """IPython の exec_lines を組む。

    webagg だけは %matplotlib を通さない。%matplotlib は gui 名を IPython 側の
    テーブルで解決するため、'webagg' を知らない IPython では例外になる。
    exec_lines の例外はセッションを止めないので、バックエンドは既定
    （Qt binding が入っていれば QtAgg）のまま残り、figure が Qt マネージャで
    作られる。その状態で figure タブを開くと webagg サーバーの WebSocket が
    manager.add_web_socket を呼び、FigureManagerQT には無いため
    AttributeError になる。切り替えは matplotlib へ直接指示する。

    Qt/Tk はイベントループ統合が必要なので %matplotlib に任せる。
    """
    lines: list[str] = []
    if mpl == "webagg":
        lines += [
            "import matplotlib as _mpl; _mpl.use('WebAgg', force=True);"
            " _mpl.interactive(True);"
            " _mpl.rcParams['webagg.open_in_browser'] = False; del _mpl",
            f"from ipydesk.webagg import start_server as _s;"
            f" print('[ipydesk] figures:', _s({port})); del _s",
        ]
    elif mpl == "none":
        # 図は作るが表示しない。放っておくと matplotlib が既定の GUI バックエンド
        # （Windows なら TkAgg）を選び、plt.show() がブロックしてしまうので、
        # 明示的に Agg を選んで非対話にする。savefig はそのまま使える。
        lines.append(
            "import matplotlib as _mpl; _mpl.use('Agg', force=True);"
            " _mpl.interactive(False); del _mpl"
        )
    else:
        lines.append(f"%matplotlib {mpl}")
    lines += ["%load_ext autoreload", "%autoreload 2"]
    pm = "--pm " if post_mortem else ""
    if script and cell:
        lines.append(f'%ipydesk_cell {pm}"{script}" {cell[0]} {cell[1]}')
    elif script:
        lines.append(f'%ipydesk {pm}"{script}"')
    return lines


def parse_args(argv: list[str]) -> tuple[Path | None, tuple[int, int] | None]:
    """[script.py] [--cell START END] を (script, cell) に分解する"""
    cell: tuple[int, int] | None = None
    if "--cell" in argv:
        i = argv.index("--cell")
        try:
            cell = (int(argv[i + 1]), int(argv[i + 2]))
        except (IndexError, ValueError):
            print("[ipydesk] --cell の後ろには開始行と終了行が必要です")
            cell = None
        argv = argv[:i] + argv[i + 3 :]
    script = Path(argv[0]).resolve() if argv else None
    return script, cell


class IPyDeskApp(TerminalIPythonApp):
    """ipydesk のセッション。プロファイルの設定の後ろに ipydesk の拡張と起動行を足す。

    extensions / exec_lines を Config で渡すと、その値がプロファイルの ipython_config.py より
    優先され、ユーザーの設定が丸ごと消える（append / extend の遅延指定でも同じ）。
    そこで設定ファイルを読み終えた後、拡張の読み込み・起動行の実行の直前に足す。
    実行順: プロファイルの extensions → ipydesk.core → startup ファイル →
            プロファイルの exec_lines → ipydesk の起動行（バックエンド・最初のスクリプト）
    """

    ipydesk_lines = List(Unicode()).tag(config=False)

    def init_extensions(self):
        if "ipydesk.core" not in self.extensions:
            self.extensions = [*self.extensions, "ipydesk.core"]
        super().init_extensions()

    def init_code(self):
        self.exec_lines = [*self.exec_lines, *self.ipydesk_lines]
        super().init_code()


def ipython_config() -> Config:
    """セッションの IPython 設定（テストから検証できるよう分けてある）。
    ここに書いた値はプロファイルの設定より優先される"""
    c = Config()
    # 既定（True）では exec_lines で作られた変数が user_ns_hidden に入り、%who からも
    # ワークスペースビューからも消える。起動時のスクリプト実行（%ipydesk / %ipydesk_cell）も
    # exec_lines の 1 行なので、1 回目の F5 で作った変数がすべて隠れてしまう。
    # exec_lines 側の一時変数（_mpl, _s）は del 済みで、_ 始まりはビューにも出さない。
    c.InteractiveShellApp.hide_initial_ns = False
    c.TerminalInteractiveShell.confirm_exit = False
    c.TerminalInteractiveShell.banner1 = ""
    return c


def main() -> None:
    argv = sys.argv[1:]
    post_mortem = "--pm" in argv  # 位置は問わない（parse_args は従来の形のまま）
    script, cell = parse_args([a for a in argv if a != "--pm"])

    # --- セッション生存通知（拡張側が「2回目以降は %ipydesk を送る」判定に使う） ---
    vsdir = find_vscode_dir(script.parent if script else Path.cwd())
    if env_dir := os.environ.get("IPYDESK_SESSION_DIR"):
        vsdir = Path(env_dir)
        vsdir.mkdir(parents=True, exist_ok=True)
    if vsdir:
        session = vsdir / SESSION_NAME
        figures = vsdir / FIGURES_NAME
        ws = vsdir / WORKSPACE_NAME
        figures.unlink(missing_ok=True)  # 前回の残骸を消す
        ws.unlink(missing_ok=True)
        core.session_vscode_dir = vsdir
        core.session_file = session
        core.write_session(busy=True)  # 起動直後はスクリプト実行が控えている
        atexit.register(lambda: session.unlink(missing_ok=True))
        atexit.register(lambda: figures.unlink(missing_ok=True))
        atexit.register(lambda: ws.unlink(missing_ok=True))

    # --- IPython 設定 ---
    mpl = resolve_backend(os.environ.get("IPYDESK_MPL", "webagg").lower())
    port = int(os.environ.get("IPYDESK_PORT", "8988"))
    exec_lines = startup_lines(mpl, port, script, cell, post_mortem)

    c = ipython_config()

    print(f"[ipydesk] session started ({mpl} backend). F5 で再実行 / exit で終了")
    IPyDeskApp.launch_instance(argv=[], config=c, ipydesk_lines=exec_lines)


if __name__ == "__main__":
    main()
