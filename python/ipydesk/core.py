"""
ipydesk.core — VS Code の赤丸（ブレークポイント）で停止しつつスクリプトを実行する。

構成:
  - find_vscode_dir : スクリプト位置から上へ辿って .vscode/py_breakpoints.json を探す
  - VsPdb           : pdb (ipdb 優先) の拡張。停止位置を JSON で通知し、
                      スクリプト終了時や標準ライブラリ内では止まらない
  - run_script      : ブレークポイントを登録して名前空間 ns でスクリプトを実行
  - run_cell        : ファイルの一部の行範囲だけを、元の行番号のまま実行
                      （セル実行 / 選択範囲の実行 / 現在行の実行）
  - %ipydesk / %ipydesk_cell マジック : IPython セッション内から上の 2 つを呼ぶ
  - ワークスペースビュー : セルの終了時と停止時に変数一覧を書き出す（ipydesk.workspace）
  - Variable Editor   : 拡張からの問い合わせに、変数の一部を表で答える（ipydesk.varview）
  - Figure の履歴     : 描き直した図の前の姿を画像で残す（ipydesk.fighist）
"""

from __future__ import annotations

import ast
import fnmatch
import json
import os
import sys
import textwrap
import time
import traceback
from bdb import BdbQuit
from pathlib import Path

from . import fighist, inject, varview, workspace


def _debugger_base():
    """デバッガの基底クラス（IPython 補完・色付きの pdb）。

    以前は ipdb の _get_debugger_cls() を使っていたが、IPython がまだ起動していないと
    （python -m ipydesk はセッションを起動する前にこのモジュールを import する）、
    ipdb は設定を読むためだけに使い捨ての TerminalIPythonApp を作って initialize する。
    その時点でプロファイルの startup ファイルと exec_lines が実行され、本物のセッションの
    起動でもう一度実行されていた（起動時処理が 2 回動く）。
    ipdb が最終的に返すのは shell.debugger_cls（端末なら TerminalPdb）なので、直接使う。
    """
    try:
        from IPython import get_ipython

        shell = get_ipython()
        if shell is not None:  # 既存の IPython から %load_ext ipydesk.core された
            return shell.debugger_cls
        from IPython.terminal.debugger import TerminalPdb

        return TerminalPdb
    except ImportError:  # IPython なしでは標準 pdb
        from pdb import Pdb

        return Pdb


Pdb = _debugger_base()

# VS Code 拡張とやり取りするファイル名（すべて .vscode/ 直下）
BP_NAME = inject.BP_NAME  # 拡張 → Python : 赤丸の一覧
STATE_NAME = "py_debug_state.json"  # Python → 拡張 : 現在の停止位置
SESSION_NAME = "py_session.json"  # Python → 拡張 : IPython セッション生存通知

# この中のモジュールでは絶対に停止しない（ステップインでも潜らない）
SKIP = [
    "ipydesk.core",  # セル実行はこのモジュールの関数を経由するので、その中では止まらない
    "ipydesk.inject",  # 埋め込んだ __ipydesk_bp__ の中へはステップ実行で潜らない
    "runpy",
    "importlib*",
    "_frozen_importlib*",
    "codecs",
    "encodings*",
    "IPython*",
    "prompt_toolkit*",
    "traitlets*",
    "matplotlib*",
]

FIGURES_NAME = "py_figures.json"  # Python → 拡張 : figure 表示ページの URL
FIG_CLOSE_PREFIX = "py_figclose_"  # 拡張 → Python : 利用者が閉じた Figure タブ（1 要求 1 ファイル）

# セッションの出力先（python -m ipydesk が起動時に決める）。
# 停止位置・figure 一覧・変数一覧・保存要求をここへ書く。VS Code 拡張から起動した場合は
# IPYDESK_SESSION_DIR（.vscode/py_sessions/<番号>/）で、複数セッションが互いのファイルを
# 上書きしないようセッションごとに分かれている。赤丸 JSON だけは .vscode/ 直下を共有する。
session_vscode_dir: Path | None = None
# セッション生存通知ファイル（busy フラグも持つ）。python -m ipydesk が設定する
session_file: Path | None = None

# 直前のエラー（F5 / セル実行ではエラーで止まらないので、後から %ipydesk_pm で入れるよう取っておく）
#   _last_error : (script, vscode_dir, traceback)。次の実行が始まると消える
#   error_info  : 拡張への通知用 {"type": ..., "where": "file.py:12"}（ステータスバーの ⚠）
_last_error: tuple | None = None
error_info: dict | None = None

# 赤丸のトレース（sys.settrace）で実行している間の情報と、直前のトレース実行の結果。
# どちらも py_session.json に載せて拡張へ知らせる（ステータスバーと低速実行の通知）
#   trace_info : {"bps": [{"file", "line"}, ...]}。トレース中だけ
#   trace_done : {"id", "sec", "bps"}。次のトレース実行が始まると消える
trace_info: dict | None = None
trace_done: dict | None = None
_trace_runs = 0

# ブレークポイント・事後デバッグで停止中のデバッガ（Variable Editor がそのフレームの変数を見る）
active_debugger = None


def out_dir(vscode_dir: Path | None) -> Path | None:
    """拡張へ通知するファイルの書き出し先。セッション専用ディレクトリがあればそちら"""
    return session_vscode_dir if session_vscode_dir is not None else vscode_dir


def write_session(busy: bool) -> None:
    """セッション生存通知を書く。busy は「コードを実行中か」— 拡張が F5 の送り先を
    選ぶのに使う（実行中のセッションへは送らず、別のセッションで実行する）。
    trace は実行中にトレースを入れているか（ステータスバーの ⚠）、trace_done は直前の
    トレース実行の結果（拡張が、遅かったときに通知を出す）"""
    if session_file is None:
        return
    data = json.dumps(
        {
            "pid": os.getpid(),
            "busy": busy,
            "error": error_info,
            "trace": trace_info,
            "trace_done": trace_done,
        }
    )
    tmp = session_file.with_name(session_file.name + ".tmp")
    try:
        tmp.write_text(data, encoding="utf-8")
        try:
            os.replace(tmp, session_file)
        except PermissionError:  # Windows で拡張が読んでいる瞬間に当たった
            session_file.write_text(data, encoding="utf-8")
            tmp.unlink(missing_ok=True)
    except OSError as e:
        print(f"[ipydesk] セッション通知の書き出しに失敗: {e}", file=sys.stderr)


_last_figures: str | None = None


def apply_figure_closes(vscode_dir: Path | None) -> None:
    """Figure タブを閉じた figure を plt.close する（MATLAB で図のウィンドウを閉じるのと同じ）。

    タブを閉じても figure は Python に残るため、放っておくと次に一覧を通知したとき
    タブが開き直され、plt.plot も閉じたはずの図に描き足してしまう。
    拡張は閉じたタブごとに py_figclose_*.json（{"num", "id"}）を書くので、
    次のコマンドを実行する直前（とプロンプトへ戻る前）にまとめて閉じる。
    id が違う＝その番号で既に作り直された figure は閉じない。
    閉じた図は Figure の履歴からも消す（同じ番号で作った新しい図の履歴に混ざらないように）。
    """
    if vscode_dir is None:
        return
    try:
        reqs = sorted(vscode_dir.glob(FIG_CLOSE_PREFIX + "*.json"))
    except OSError:
        return
    if not reqs:
        return
    targets: list[tuple[int, str | None]] = []
    for f in reqs:
        try:
            r = json.loads(f.read_text(encoding="utf-8"))
            targets.append((int(r["num"]), r.get("id")))
        except (OSError, ValueError, KeyError, TypeError):
            pass
        try:
            f.unlink()
        except OSError:
            pass
    if "matplotlib.pyplot" not in sys.modules:
        return
    import matplotlib.pyplot as plt
    from matplotlib._pylab_helpers import Gcf

    for num, fid in targets:
        m = Gcf.figs.get(num)
        if m is None or (fid and f"{id(m):x}" != fid):
            continue
        with fighist.suspended():  # 閉じたタブの図は履歴ごと捨てるので、途中の姿も記録しない
            plt.close(m.canvas.figure)
        fighist.forget(num, vscode_dir)


def start_figure_history(vscode_dir: Path | None) -> None:
    """実行の途中で描き直された図も履歴に残せるようにする（実行の前に呼ぶ）。

    Figure の履歴は webagg（Figure タブ）のときだけ使うので、それ以外では書き出し先を
    None にして何もしない。webagg の起動時点では pyplot はまだ読み込まれていない
    （最初のスクリプトが import する）ので、pyplot の有無では判断しない。
    """
    folder = None
    if vscode_dir is not None and "matplotlib" in sys.modules:
        try:
            from ipydesk import webagg

            if webagg.url:
                folder = vscode_dir
        except ImportError:
            pass
    fighist.install(folder)


def notify_figures(vscode_dir: Path | None, only_if_changed: bool = False) -> None:
    """webagg 稼働中なら、現在の figure 番号一覧と履歴を拡張に通知する。

    先に Figure の履歴を記録する（描き直された図の前の姿を画像で残す）。
    only_if_changed=True は、プロンプトで打った 1 行や停止中のコマンドの後に使う。
    一覧も履歴も変わっていなければ書かない（書くと拡張が既存の Figure タブを前に出すため）。
    F5 / セル実行の後は、変わっていなくても書いて図を前に出す。
    """
    global _last_figures
    if vscode_dir is None:
        return
    apply_figure_closes(vscode_dir)  # 閉じられたタブの figure を一覧に載せない
    if "matplotlib.pyplot" not in sys.modules:  # 図を使っていないセッションで import しない
        return
    try:
        import matplotlib.pyplot as plt

        from ipydesk import webagg
    except ImportError:
        return
    if not webagg.url:
        return
    fighist.capture(vscode_dir)
    nums = plt.get_fignums()
    from matplotlib._pylab_helpers import Gcf

    labels = {}  # plt.figure("名前") の名前（タブの見出しに出す）
    # figure の実体の識別子。plt.close してから同じ番号で作り直すと変わる。
    # タブ（webagg のページ）は古い figure に繋がったままなので、拡張はこれを見て繋ぎ直す
    ids = {}
    for n in nums:
        m = Gcf.figs.get(n)
        lab = m.canvas.figure.get_label() if m is not None else ""
        if lab:
            labels[str(n)] = lab
        if m is not None:
            ids[str(n)] = f"{id(m):x}"
    data = json.dumps(
        {"url": webagg.url, "figures": nums, "labels": labels, "ids": ids,
         **fighist.payload(nums)},
        ensure_ascii=False,
    )
    if only_if_changed and data == _last_figures:
        return
    _last_figures = data
    try:
        (vscode_dir / FIGURES_NAME).write_text(data, encoding="utf-8")
    except OSError as e:
        print(f"[ipydesk] figure 一覧の書き出しに失敗: {e}", file=sys.stderr)


_MISSING = object()


def _loaded_files() -> set[str]:
    """import 済みのモジュールのファイル（正規化済み）"""
    # 数百のモジュールがあるので、Path.resolve（ファイルシステムを引く）は使わない。
    # 照合する側は canon と abspath の両方の綴りで探す（_is_loaded）
    files = set()
    for m in list(sys.modules.values()):
        f = getattr(m, "__file__", None)
        if isinstance(f, str):
            files.add(os.path.normcase(os.path.abspath(f)))
    return files


def _is_loaded(file: str, loaded: set[str]) -> bool:
    return inject.canon(file) in loaded or os.path.normcase(os.path.abspath(file)) in loaded


def find_vscode_dir(start: Path) -> Path | None:
    """start から親ディレクトリへ辿り、赤丸 JSON を持つ .vscode/ を返す"""
    if env := os.environ.get("IPYDESK_FILE"):
        return Path(env).parent
    for d in [start, *start.parents]:
        if (d / ".vscode" / BP_NAME).exists():
            return d / ".vscode"
    return None


class VsPdb(Pdb):
    def __init__(
        self,
        script: Path,
        vscode_dir: Path | None,
        out_dir: Path | None = None,
        **kw,
    ):
        super().__init__(skip=SKIP, **kw)
        self.script = script.resolve()
        self.vscode_dir = vscode_dir  # 赤丸 JSON を読む場所（全セッション共有）
        self.out_dir = out_dir if out_dir is not None else vscode_dir  # 通知の書き出し先
        self.state_file = self.out_dir / STATE_NAME if self.out_dir else None
        self._bp_mtime: float | None = None
        # co_filename → bdb.breaks のキー（trace_dispatch の近道用）
        self._canon: dict[str, str] = {}
        self.loaded: list[dict] = []  # トレース（bdb）で止める赤丸 {"file", "line"}
        self.plan: inject.ScriptPlan | None = None  # 今回の実行の注入計画
        self.inj_conds: dict[tuple[str, int], str | None] = {}  # 注入で止める赤丸 → 条件
        self.last_stop: tuple | None = None  # ステップ実行で最後に止まった (フレーム, 行)
        self._from_hit = False  # 対話が埋め込んだ呼び出しからの停止か
        self._started = False  # 最初の同期を終えたか（実行中に足された赤丸の扱いが変わる）
        self.hit_used = False  # 埋め込んだ呼び出しからトレースを入れたか

    def setup(self, f, tb):
        super().setup(f, tb)
        if f is not None:
            return  # 通常停止時はそのまま
        # 事後デバッグ: skip 対象モジュール（ライブラリ内部）を避け、
        # 最も深いユーザーコードのフレームを現在フレームにする
        for i in range(len(self.stack) - 1, -1, -1):
            frame = self.stack[i][0]
            if not self.is_skipped_module(frame.f_globals.get("__name__", "")):
                self.curindex = i
                self.curframe = frame
                if hasattr(self, "curframe_locals"):
                    self.curframe_locals = frame.f_locals
                break
        self._write_state(self.curframe)  # エディタ側で例外行をハイライト

    def trace_dispatch(self, frame, event, arg):
        # 続行中（stoplineno == -1）に、赤丸のないファイルの関数が呼ばれたときの近道。
        # bdb の dispatch_call は、SKIP との fnmatch・IPython の隠しフレーム判定
        # （f_locals の読み取り）・stopframe までのフレーム遡りを呼び出しのたびにやるので、
        # pandas のように Python の関数を大量に呼ぶコードでは、これだけで数十倍遅くなる。
        # 辞書を 1 回引いて None を返せば、そのフレームはトレースの対象から外れる。
        # botframe が決まる前（最初の call）と、ステップ実行中は従来どおりの処理に流す。
        if (
            event == "call"
            and self.stoplineno == -1
            and self.botframe is not None
            and not self.quitting
        ):
            fn = frame.f_code.co_filename
            canon = self._canon.get(fn)
            if canon is None:
                canon = self._canon[fn] = self.canonic(fn)
            if canon not in self.breaks:
                return None
        return super().trace_dispatch(frame, event, arg)

    def stop_here(self, frame):
        # IPython 9 の stop_here は skip 対象モジュールを通過するたびに
        # "[... skipped 1 ignored module(s)]" を無条件に print する。
        # ここで先に判定して抜けることで、その出力を抑止する。
        if self.skip and self.is_skipped_module(frame.f_globals.get("__name__", "")):
            return False
        return super().stop_here(frame)

    # --- 赤丸の同期 ---------------------------------------------------------
    def sync_breakpoints(self, force: bool = False) -> None:
        """JSON が更新されていれば、pdb 側のブレークポイントを作り直す"""
        if self.vscode_dir is None:
            return
        bp_file = self.vscode_dir / BP_NAME
        try:
            mtime = bp_file.stat().st_mtime
        except FileNotFoundError:
            mtime = None
        if not force and mtime == self._bp_mtime:
            return
        self._bp_mtime = mtime

        self.clear_all_breaks()
        self.loaded = []
        self.inj_conds = {}
        mode, bps = inject.read_bp_file(self.vscode_dir)
        loaded_files: set[str] | None = None
        for bp in bps:
            file = str(Path(bp["file"]).resolve())
            line = bp["line"]
            cond = bp.get("condition") or None
            key = inject.canon(file)
            route = "bdb"
            if mode == "inject":
                if line in inject.injected_by_file.get(key, ()):
                    route = "inj"  # 埋め込み済み
                elif self.plan is not None and key == self.plan.file:
                    # 今回 compile した範囲の外。最初の同期では、関数の中のものだけトレースで止める。
                    # 実行中（停止中）に足された赤丸は、どの行でも止められるようトレースにする
                    if not self._started and line not in self.plan.bdb_lines:
                        route = "skip"
                elif not os.path.exists(file):
                    route = "skip"
                else:
                    if loaded_files is None:
                        loaded_files = _loaded_files()
                    # import 済みならもう注入できない（トレース）。まだなら import 時に注入する
                    route = "bdb" if _is_loaded(file, loaded_files) else "inj"
            if route == "inj":
                self.inj_conds[(key, line)] = cond
            elif route == "bdb":
                self.set_break(file, line, cond=cond)
                self.loaded.append({"file": file, "line": line})
        self._started = True

    # --- 埋め込んだ呼び出しからの停止 ---------------------------------------------
    def inject_hit(self, key, frame) -> None:
        """__ipydesk_bp__ / __ipydesk_bp_cond__ から呼ばれる。有効な赤丸なら frame で止まる"""
        cond = self.inj_conds.get(key, _MISSING)
        if cond is _MISSING:  # 外された・無効にされた・今回の実行の対象ではない
            return
        stop = self.last_stop
        if stop is not None and stop[0] is frame and stop[1] == frame.f_lineno:
            # ステップ実行でこの行に止まったあと、続けて呼び出しを通るところ（二重に止まらない）
            self.last_stop = None
            return
        if cond:
            try:
                if not eval(cond, frame.f_globals, frame.f_locals):
                    return
            except Exception:  # 条件が評価できないときは、bdb と同じく止まる
                pass
        self.stop_at(frame)

    def stop_at(self, frame) -> None:
        """frame にトレースを入れて、その行で対話に入る（set_trace と同じ処理のあと user_line）。
        set_trace だけだと同じ行では line イベントが出ず、1 文遅れて止まってしまう"""
        self.hit_used = True
        self._from_hit = True
        try:
            self.reset()
            f = frame
            while f is not None:  # _execute より外（IPython 本体）にはトレースを広げない
                f.f_trace = self.trace_dispatch
                self.botframe = f
                if f.f_code is _EXECUTE_CODE:
                    break
                f = f.f_back
            self.set_step()
            sys.settrace(None)  # 対話の中（pdb 自身の関数）をトレースしない
            self.user_line(frame)
            if self.quitting:  # q で抜けた。直接呼んだので、トレースの側からは BdbQuit が出ない
                raise BdbQuit
            if self.breaks or self.stoplineno != -1:  # c で全速に戻るとき以外は、トレースを戻す
                sys.settrace(self.trace_dispatch)
        finally:
            self._from_hit = False

    def precmd(self, line: str) -> str:
        self.sync_breakpoints()  # c / n / s 等の直前に最新の赤丸へ揃える
        apply_figure_closes(self.out_dir)  # 停止中に閉じたタブの図へ描き足さない
        return super().precmd(line)

    # reset / user_return / interaction / _write_state / _clear_state は変更なし

    # --- 停止制御 -----------------------------------------------------------
    def reset(self):
        super().reset()
        # 既定では stopframe=None（= 全行で停止）なので、実行開始直後に止まってしまう。
        # トレース対象にならないフレームを stopframe に入れ、stoplineno=-1 にすることで
        # 「ブレークポイントでのみ停止」から開始する。
        self._set_stopinfo(sys._getframe(), None, -1)

    def user_return(self, frame, return_value):
        code = frame.f_code
        if (
            code.co_name == "<module>"
            and Path(code.co_filename).resolve() == self.script
        ):
            self.set_continue()  # スクリプト本体の終了では止まらず抜ける
            return
        super().user_return(frame, return_value)

    # --- ワークスペースビュー（停止中はそのフレームの変数を出す） --------------
    def _write_workspace(self) -> None:
        frame = getattr(self, "curframe", None)
        if frame is None or self.out_dir is None:
            return
        ns = getattr(self, "curframe_locals", None)
        if ns is None:
            ns = frame.f_locals
        scope, label, where = workspace.frame_scope(frame)
        hidden = None
        try:
            from IPython import get_ipython

            ip = get_ipython()
            if ip is not None and ns is ip.user_ns:
                hidden = ip.user_ns_hidden  # スクリプト本体で停止 = IPython の名前空間そのもの
        except ImportError:
            pass
        workspace.write(
            self.out_dir, ns, hidden=hidden, scope=scope, label=label, where=where
        )

    def preloop(self):
        self._write_workspace()  # 停止するたび（ステップごと・事後デバッグ）
        frame = getattr(self, "curframe", None)
        if frame is not None:  # ステップで描き直した図も履歴に残す
            fighist.set_label(f"⏸ {Path(frame.f_code.co_filename).name}:{frame.f_lineno}")
            notify_figures(self.out_dir, only_if_changed=True)
        super().preloop()

    def postcmd(self, stop, line):
        if not stop:  # `x = 3` や `p x` など、停止したまま打ったコマンドの後
            self._write_workspace()
            fighist.set_label(f"ipdb> {line}")
            notify_figures(self.out_dir, only_if_changed=True)  # 停止中に描いた図もタブに出す
        return super().postcmd(stop, line)

    # u / d でフレームを移ったら、そのフレームの変数に切り替える
    def do_up(self, arg):
        r = super().do_up(arg)
        self._write_workspace()
        return r

    def do_down(self, arg):
        r = super().do_down(arg)
        self._write_workspace()
        return r

    do_u = do_up
    do_d = do_down

    # --- 停止位置の通知（拡張側がハイライトに使う） ---------------------------
    def interaction(self, frame, tb_or_exc):
        global active_debugger
        if frame is not None and not self._from_hit:
            self.last_stop = (frame, frame.f_lineno)
        self._write_state(frame)
        prev, active_debugger = active_debugger, self
        try:
            super().interaction(frame, tb_or_exc)
        finally:
            active_debugger = prev
            self._clear_state()

    def _write_state(self, frame):
        if self.state_file is None or frame is None:
            return
        self.state_file.write_text(
            json.dumps(
                {
                    "file": str(Path(frame.f_code.co_filename).resolve()),
                    "line": frame.f_lineno,
                }
            ),
            encoding="utf-8",
        )

    def _clear_state(self):
        if self.state_file is not None:
            self.state_file.unlink(missing_ok=True)


def load_breakpoints(vscode_dir: Path | None) -> list[dict]:
    """有効な赤丸の一覧。拡張が「全赤丸を一時無効」にしている間（"active": false）は空"""
    return inject.read_bp_file(vscode_dir)[1]


def _user_frame_where(tb) -> str | None:
    """トレースバックの中で最も深いユーザーコードの「ファイル名:行」"""
    where = None
    for frame, lineno in traceback.walk_tb(tb):
        name = frame.f_globals.get("__name__", "")
        if not any(fnmatch.fnmatch(name, pat) for pat in SKIP):
            where = f"{Path(frame.f_code.co_filename).name}:{lineno}"
    return where


def _remember_error(script: Path, vsdir, etype, evalue, tb) -> None:
    """%ipydesk_pm と IPython の %debug が使えるよう、直前のエラーを取っておく"""
    global _last_error, error_info
    _last_error = (script, vsdir, tb)
    error_info = {"type": etype.__name__, "where": _user_frame_where(tb)}
    sys.last_type, sys.last_value, sys.last_traceback = etype, evalue, tb
    if sys.version_info >= (3, 12):
        sys.last_exc = evalue


def _stop_tracing(dbg) -> None:
    """埋め込んだ呼び出しで入れたトレースを、実行の終わりで外す（runcall の後始末と同じ）"""
    dbg.quitting = True
    sys.settrace(None)
    f = sys._getframe()
    while f is not None:
        f.f_trace = None
        if f.f_code is _EXECUTE_CODE:
            break
        f = f.f_back


def _execute(
    script: Path,
    vsdir,
    run,
    post_mortem: bool = False,
    use_breakpoints: bool = True,
    plan: inject.ScriptPlan | None = None,
) -> None:
    """赤丸を仕込んだデバッガの下で run() を実行する（スクリプト実行・セル実行の共通部）

    赤丸が1つも無ければ（use_breakpoints=False＝赤丸を無視する実行も）トレースを一切入れない。
    例外はトレースバックを出して取っておき、post_mortem=True（Alt+F5）のときだけ
    その場で事後デバッグに入る。それ以外（F5 / セル実行）は止まらず、後から %ipydesk_pm で入れる。
    終わったら停止状態と figure 一覧を拡張へ通知する。
    """
    global _last_error, error_info, trace_info, trace_done, _trace_runs
    _last_error = error_info = None  # 前のエラーは、次の実行を始めた時点で見られなくなる
    out = out_dir(vsdir)
    start_figure_history(out)
    dbg = VsPdb(script, vsdir, out)
    dbg.plan = plan
    inject.install(vsdir)  # import されるファイルの赤丸にも、読み込み時に注入する
    inject.state.suppress = not use_breakpoints
    if use_breakpoints:
        dbg.sync_breakpoints(force=True)
    inject.state.dbg = dbg  # 埋め込んだ呼び出しが、この実行のデバッガで止まる
    # 注入で止める赤丸だけならトレースは入れない（止まった時点で初めて入れる）
    tracing = bool(dbg.breaks)  # {filename: [lines]}
    bps = []
    started = 0.0
    if tracing:
        trace_done = None
        bps = list(dbg.loaded)
        trace_info = {"bps": bps}
        write_session(True)  # 拡張のステータスバーを「トレース中」にする
        started = time.perf_counter()

    try:
        if tracing:
            dbg.runcall(run)
        else:
            run()
    except (SystemExit, BdbQuit):
        pass
    except BaseException:
        traceback.print_exc()
        etype, evalue, tb = sys.exc_info()
        _remember_error(script, vsdir, etype, evalue, tb)
        if post_mortem:
            dbg.reset()  # 赤丸なし（runcall を通っていない）でも q で抜けられるように
            dbg.interaction(None, tb)
        else:
            print(
                "[ipydesk] エラーの行で止まるには IPyDesk: Debug Last Error"
                "（ステータスバーの ⚠ / %ipydesk_pm）",
                file=sys.stderr,
            )
    finally:
        inject.state.dbg = None
        inject.state.suppress = False
        if dbg.hit_used and not tracing:
            _stop_tracing(dbg)
        if tracing:
            _trace_runs += 1
            trace_done = {
                "id": _trace_runs,
                "sec": round(time.perf_counter() - started, 3),
                "bps": bps,
            }
            trace_info = None
        dbg._clear_state()
        dbg.clear_all_breaks()
        notify_figures(out)
        fighist.report_skipped()


_EXECUTE_CODE = _execute.__code__


def post_mortem_last() -> None:
    """直前のエラーの位置で事後デバッグに入る（%ipydesk_pm）。停止行のハイライトと
    ワークスペースビューは、実行中に止まったときと同じように動く"""
    if _last_error is None:
        print(
            "[ipydesk] 直前のエラーがありません（実行し直すと消えます。"
            "プロンプトで打った行のエラーは %debug）"
        )
        return
    script, vsdir, tb = _last_error
    dbg = VsPdb(script, vsdir, out_dir(vsdir))
    dbg.reset()  # pdb.post_mortem と同じく、対話の前に初期化する（q で抜けるのに必要）
    try:
        dbg.interaction(None, tb)
    except BdbQuit:
        pass
    finally:
        dbg._clear_state()


def run_script(
    script: Path, ns: dict, post_mortem: bool = False, use_breakpoints: bool = True
) -> None:
    """VS Code の赤丸で停止しつつ、名前空間 ns でスクリプトを実行する"""
    script = script.resolve()
    if not script.exists():
        print(f"ipydesk: file not found: {script}")
        return

    vsdir = find_vscode_dir(script.parent)

    ns["__file__"] = str(script)
    ns.setdefault("__name__", "__main__")
    # dont_inherit: このモジュールの `from __future__ import annotations` をスクリプトへ
    # 持ち込まない（持ち込むと注釈が文字列になり、%run -i と挙動が変わる）
    plan = inject.make_plan(vsdir, script, use_breakpoints)
    code = plan.compile_script(script.read_text(encoding="utf-8"), str(script))
    fighist.set_label(script.name)

    _execute(
        script, vsdir, lambda: _exec_as_script(script, code, ns), post_mortem,
        use_breakpoints, plan,
    )


def _exec_as_script(script: Path, code, ns: dict) -> None:
    """%run -i と同じく、実行中だけ sys.argv をスクリプト名にして ns で実行する"""
    saved = sys.argv
    sys.argv = [str(script)]
    try:
        exec(code, ns)
    finally:
        sys.argv = saved


# ---- セル実行（# %% 区切り / 選択範囲 / 現在行） --------------------------------


def compile_range(
    src: str,
    start: int,
    filename: str,
    plan: inject.ScriptPlan | None = None,
    full_src: str | None = None,
):
    """行範囲のソースを「本体」と「末尾の式」に分けてコンパイルする。

    - 先頭に空行を詰めて、コード中の行番号をファイル上の行番号に合わせる。
      こうしないと赤丸もトレースバックもエディタの行とずれる
    - 末尾が式なら切り離して eval 用にする。IPython のセルと同じく、
      最後の式の値を Out[n] として表示するため
    - `for` の中だけを選んで実行したときのように、範囲全体が字下げされている
      場合に備え、IndentationError のときだけ字下げを外して作り直す
    """
    pad = "\n" * (start - 1)
    try:
        mod = ast.parse(pad + src, filename, "exec")
    except IndentationError:
        mod = ast.parse(pad + textwrap.dedent(src), filename, "exec")

    if plan is not None:  # 赤丸の呼び出しを埋め込む（末尾の式を切り離す前に）
        plan.apply_range(mod, start, start + len(src.splitlines()) - 1, full_src)

    tail = None
    if mod.body and isinstance(mod.body[-1], ast.Expr):
        expr = mod.body.pop()
        tail = compile(ast.Expression(expr.value), filename, "eval", dont_inherit=True)
    return compile(mod, filename, "exec", dont_inherit=True), tail


def run_cell(
    script: Path,
    start: int,
    end: int,
    ns: dict,
    post_mortem: bool = False,
    use_breakpoints: bool = True,
) -> None:
    """script の start..end 行（1 始まり・両端含む）だけを ns で実行する。

    セル実行・選択範囲の実行・現在行の実行はすべてここを通る。
    ファイルは拡張側が保存済みで、行番号はそのファイル上の番号。
    """
    script = script.resolve()
    if not script.exists():
        print(f"ipydesk: file not found: {script}")
        return

    full_src = script.read_text(encoding="utf-8")
    lines = full_src.splitlines(keepends=True)
    start = max(1, start)
    end = min(len(lines), end)
    if start > end:
        return
    src = "".join(lines[start - 1 : end])
    if not src.strip():
        return

    vsdir = find_vscode_dir(script.parent)
    plan = inject.make_plan(vsdir, script, use_breakpoints)
    try:
        code, tail = compile_range(src, start, str(script), plan, full_src)
    except SyntaxError as e:
        print("".join(traceback.format_exception_only(type(e), e)), end="")
        return

    ns["__file__"] = str(script)
    ns.setdefault("__name__", "__main__")

    def run():
        _exec_as_script(script, code, ns)
        if tail is not None:
            sys.displayhook(eval(tail, ns))  # 末尾の式は Out[n] として表示

    fighist.set_label(f"{script.name}:{start}-{end}")
    _execute(script, vsdir, run, post_mortem, use_breakpoints, plan)


# ---- IPython 拡張: %ipydesk / %ipydesk_cell マジック ---------------------------------
from IPython.core.magic import Magics, line_magic, magics_class


def split_pm(line: str) -> tuple[bool, str]:
    """先頭の --pm（エラーで止まる）を取り出す"""
    line = line.strip()
    if line == "--pm" or line.startswith("--pm "):
        return True, line[4:].strip()
    return False, line


def split_flags(line: str) -> tuple[bool, bool, str]:
    """先頭の --pm（エラーで止まる）と --nobp（赤丸を無視する）を、順不同で取り出す"""
    pm = nobp = False
    while True:
        line = line.strip()
        for flag in ("--pm", "--nobp"):
            if line == flag or line.startswith(flag + " "):
                line = line[len(flag) :]
                pm = pm or flag == "--pm"
                nobp = nobp or flag == "--nobp"
                break
        else:
            return pm, nobp, line


@magics_class
class IPyDeskMagics(Magics):
    @line_magic
    def ipydesk(self, line: str):
        """%ipydesk [--pm] [--nobp] script.py — 赤丸で停止しつつ、現在の名前空間でスクリプトを実行。
        --pm を付けるとエラーの行で止まる（事後デバッグ）。--nobp は赤丸を無視する"""
        pm, nobp, rest = split_flags(line)
        path = rest.strip('"').strip("'")
        if not path:
            print("usage: %ipydesk [--pm] [--nobp] script.py")
            return
        run_script(Path(path), self.shell.user_ns, post_mortem=pm, use_breakpoints=not nobp)

    @line_magic
    def ipydesk_cell(self, line: str):
        """%ipydesk_cell [--pm] script.py START END — その行範囲だけを現在の名前空間で実行"""
        pm, nobp, rest = split_flags(line)
        try:
            head, start, end = rest.rsplit(None, 2)
            span = (int(start), int(end))
        except ValueError:
            print("usage: %ipydesk_cell [--pm] script.py START END")
            return
        path = head.strip().strip('"').strip("'")
        run_cell(
            Path(path), span[0], span[1], self.shell.user_ns,
            post_mortem=pm, use_breakpoints=not nobp,
        )

    @line_magic
    def ipydesk_pm(self, line: str):
        """%ipydesk_pm — 直前の %ipydesk / %ipydesk_cell のエラーの行で事後デバッグに入る"""
        post_mortem_last()


def load_ipython_extension(ip):
    ip.register_magics(IPyDeskMagics)

    bp_dir = find_vscode_dir(Path.cwd())
    inject.install(bp_dir)  # import されるファイルの赤丸にも、読み込み時に注入する
    vsdir = out_dir(bp_dir)

    def update_workspace(*_):
        workspace.write(vsdir, ip.user_ns, hidden=ip.user_ns_hidden)

    def mark_busy(info=None, *_):
        write_session(True)
        apply_figure_closes(vsdir)  # 閉じたタブの図へ plt.plot が描き足さないよう、実行前に閉じる
        start_figure_history(vsdir)  # プロンプトで打ったループの途中の図も履歴に残す
        raw = getattr(info, "raw_cell", None)
        if raw:  # プロンプトで打った行。%ipydesk なら実行側がスクリプト名で上書きする
            fighist.set_label(raw.strip().splitlines()[0] if raw.strip() else "")

    def mark_idle(*_):
        write_session(False)
        update_workspace()
        notify_figures(vsdir, only_if_changed=True)  # プロンプトで描いた図もタブに出す
        fighist.report_skipped()

    # F5 / セル実行（%ipydesk・%ipydesk_cell もセルの 1 つ）/ プロンプトで打った 1 行、すべての前後
    ip.events.register("pre_run_cell", mark_busy)
    ip.events.register("post_run_cell", mark_idle)
    update_workspace()  # 起動直後の空の一覧（拡張が「セッションあり」と分かるように）
    varview.start(vsdir, ip)  # Variable Editor の問い合わせに答えるスレッド
