# Change Log

All notable changes to the "ipydesk" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

## [0.0.9] - 2026-10-06

### Added

- **IPyDesk: Run Without Breakpoints（Ctrl+F5）**: 赤丸を無視して実行します。赤丸があるとトレースが入って遅くなる実行を、赤丸を消さずに全速で流せます（`when` は F5 と同じ。VS Code 標準の「デバッグなしで実行」より優先）。
- **IPyDesk: Toggle All Breakpoints**: すべての赤丸を一時的に無効にします（個々の赤丸の有効・無効は変えません）。状態はワークスペースごとに保存されます。
- **ステータスバーの赤丸表示**: `● BP 3`（有効な赤丸の数）/ `⚠ BP トレース中`（赤丸のトレースで実行中）/ `○ BP 無効`。クリックすると赤丸の一覧（トレース中は原因の赤丸）を表示し、選ぶとその位置を開きます。
- **低速実行の通知**: 赤丸のトレースで `ipydesk.slowRunNotifySec`（既定 5 秒、0 で通知しない）以上かかったとき、[赤丸なしで再実行] [この赤丸を無効化] [新しいセッションで実行] を案内します。

### Changed

- **赤丸があっても遅くなりにくくしました**: 続行中、赤丸のないファイルの関数呼び出しは、bdb の重い処理（SKIP の照合・IPython の隠しフレーム判定・フレームの遡り）を通さず、ファイル名の辞書を 1 回引いて抜けます。10 万行規模の DataFrame 処理で、関係ないファイルの赤丸があるときの遅さが大きく減ります。
- `py_breakpoints.json` の形を `{"active": true, "breakpoints": [...]}` にしました（従来の配列だけの形も読めます）。

## [0.0.8] - 2026-10-04

### Added

- **Notes ビュー（メモ）**: アクティビティバーの IPyDesk に NOTES を追加しました。入力すると自動で保存します。
  - メモを**セクション**に分けられます。セクションごとに名前の変更・折りたたみ・本文のコピー（⧉）・削除ができます。折りたたみの状態も保存されます。
  - 中身は Markdown の `notes.md` で、`## 名前` の行がセクションの区切りです。
  - セクションは ⋮⋮ のドラッグ、または Alt+↑ / Alt+↓ で並べ替えられます。
  - **デフォルトのメモ**（IPyDesk のショートカット、matplotlib の subplots、軸の範囲・目盛り、外部 exe の実行）を入れます。普通のセクションと同じく削除でき、消しても再び入ることはありません（今後の更新で増えたデフォルトのメモは、増えた分だけ入ります）。「IPyDesk: Restore Default Notes」で、消したものだけを戻せます。
  - 保存先はユーザー単位（拡張の globalStorage の `notes.md`）で、どのフォルダを開いても同じメモが出ます。複数ウィンドウで開いていても内容が同期します。
  - 「IPyDesk: Add Selection to Notes」（エディタの右クリック）で、選択範囲（無ければ現在行）をファイル名・行番号・時刻つきで、最後に入力したセクションへ追記します。
  - 「IPyDesk: Open Notes File」（NOTES 右上）で `notes.md` をエディタで開けます。

## [0.0.7] - 2026-09-30

### Changed

- README（Marketplace のページ）に、F5 で実行 → 図のタブで拡大・コピー・履歴を確認する流れのデモ GIF を追加しました。
- `package.json` にリポジトリ（GitHub）・Issues・ホームページの URL を追加しました。

## [0.0.6] - 2026-09-30

### Added

- **実行途中の図も Figure の履歴に残す**: ループの中で同じ番号の figure を描き直すと（`plt.subplots(num=0, clear=True)`・`plt.clf()`・`plt.close()` してから同じ番号で作り直す）、これまでは実行が終わった時点の図しか残りませんでした。消される直前の図をその場で画像にし、「スクリプト名 · 途中 1」「途中 2」… の見出しで履歴に並べます。
  - 画像にするのに時間がかかるため、1 回の実行で figure ごとに `ipydesk.figureHistory` の枚数（既定 20）まで記録します（最初の N 枚）。超えた分は省略し、ターミナルに一度だけ知らせます。
  - `ax.cla()` で Axes だけを消す描き直しは対象外です（figure 全体が消えるときだけ記録します）。

### Fixed

- 図を開いたまま、matplotlib を使わない別のスクリプトを同じセッションで実行すると、ターミナルに `Uncaught exception GET /0/ws ... AttributeError: 'NoneType' object has no attribute 'refresh_all'` が出る問題を修正しました。
  - 原因: 実行が終わるたびに Figure の履歴が `savefig` で図を画像にしており、matplotlib は保存の間だけ `canvas.manager` を `None` にします。そこへ webagg のサーバースレッドが Figure タブ（ブラウザ）からの描画要求を処理すると、`canvas.draw()` の最後の `self.manager.refresh_all()` で落ちていました（スクリプト中の `fig.savefig` でも起こり得ました）。
  - `savefig` とブラウザからの要求（描画・リサイズ・マウス操作）を同じロックで順番に処理するようにし、保存中に届いた要求は捨てずに少し後でやり直します。
- セッションの起動時に、IPython プロファイルの startup ファイル（`~/.ipython/profile_default/startup/`）と `ipython_config.py` の `exec_lines` が 2 回実行されていた問題を修正しました。
  - 原因: ipydesk が IPython の起動前に ipdb からデバッガのクラスを取得しており、そのとき ipdb が設定を読むためだけに使い捨ての IPython を初期化していました。IPython のデバッガ（`TerminalPdb`）を直接使うようにしました。
  - あわせて、プロファイルの `exec_lines` と `extensions` が ipydesk の設定で上書きされ、本物のセッションでは実行されていなかった問題も修正しました。プロファイルの分を先に実行し、その後に ipydesk の起動処理（図のバックエンド・最初のスクリプト）を続けます。
- `%ipydesk` / セル実行を `%run -i` と同じ条件にそろえました。
  - ipydesk 内部の `from __future__ import annotations` がスクリプトへ漏れ、関数の型注釈が文字列になっていたのを修正しました（`f.__annotations__` が `{'x': 'int'}` ではなく `{'x': int}` になります）。
  - 実行中の `sys.argv` をスクリプト名にしました（終わったら元に戻します）。

## [0.0.5] - 2026-09-29

### Fixed

- Windows で conda の MKL 版 numpy / scipy を使っていると、実行中に Ctrl+C を押したときに `forrtl: error (200)` でセッション（ターミナル）ごと終了していた問題を修正しました。Intel Fortran ランタイムの Ctrl+C ハンドラを無効にし（`FOR_DISABLE_CONSOLE_CTRL_HANDLER=1`）、実行中のコマンドだけが `KeyboardInterrupt` で止まるようにしました。
- タブを閉じたときにipyセッション中ではfigureが残る挙動を修正。タブを閉じる動作でセッションからfigure及び履歴を削除するようにしました。

## [0.0.4] - 2026-09-29

### Added

- **Figure の履歴**: 同じ figure を描き直すと、前の図が Figure タブの上側に積み上がります（いちばん下が今の図。上へスクロールで遡る）。F5・セル実行・プロンプトの 1 行・ステップ実行の区切りごとに、見た目が変わった figure だけを記録します。履歴の図は 📋 でコピー、「履歴を消す」で非表示にできます。設定 `ipydesk.figureHistory`（既定 20、0 で無効）。
  - `plt.figure("名前")` の名前をタブの見出しに出すようにしました（例: `Figure 3: x`）

### Changed

- Variable Editor のプロットは、押すたびに新しい figure を作るのをやめ、変数ごとに 1 枚（`plt.figure("x")`）に描き直すようにしました。前の図は Figure の履歴に残ります。

### Fixed

- スクリプトの先頭で `plt.close("all")` してから同じ番号の figure を作り直すと（`plt.subplots(num=0)` など）、Figure タブが閉じた古い figure に繋がったままで、F5 しても図が更新されなかった問題を修正しました。作り直しを検出してタブを繋ぎ直します。

## [0.0.3] - 2026-09-28

### Added

- **Variable Editor**（IPyDesk: Open Variable…）: 配列・DataFrame・Series・list を表形式で開きます。Workspace ビューのダブルクリック・右クリック・⊞ から開けます。
  - 見えている範囲だけを Python に問い合わせる仮想スクロール（巨大な配列でも軽い）。実行・ステップのたびに自動で更新
  - 範囲を選んで **Plot / X–Y / Scatter / Hist / Image** をワンクリック。プロットは `plt.plot(x[2:7, 1:3])` のようなコードとしてセッションへ送られ、履歴に残ります
  - Ctrl+C で選択範囲をタブ区切りでコピー、3 次元以上の配列は `[:, :, k]` で面を切り替え
  - ブレークポイントで停止中は、そのフレームの変数を表示
- **Open Desk**（IPyDesk: Open Desk）: コード（左）・Figure と Variable Editor（右）・コンソール（下）・Workspace（サイドバー）を 1 コマンドで MATLAB 風に並べます。

### Changed

- プロンプトで打った行や、ブレークポイントで停止中に作った figure も、自動でタブに出るようになりました（figure の一覧が変わったときだけ通知）。

## [0.0.2] - 2026-09-28

### Changed

- **IPyDesk: Restart Session** を **IPyDesk: New Session** に置き換えました（Ctrl+Shift+F5、エディタ右上のボタン）。既存のセッションを残したまま**空のセッションを 1 つ追加**し、F5 の送り先にします。スクリプトは実行しません（実行したいときは続けて F5）。前のセッションの変数や計算中の処理はそのまま残るので、ターミナルやステータスバーから切り替えて戻れます。要らなくなったセッションはターミナルを閉じてください。
  - コマンド ID は `ipydesk.restart` → `ipydesk.newSession` に変わりました。
  - 図の表示先の設定を変えたときは、通知の「置き換える」でアクティブなセッションを空のセッションに置き換えます（古い設定のセッションが残らないように）。

## [0.0.1] - 2026-09-27

### Added

- 旧名 PyBP（pybp 0.4.5）から IPyDesk に名前を変え、バージョンを 0.0.1 から数え直しました。機能は pybp 0.4.5 と同じです。
  - コマンド ID・設定キー・ビュー ID・コンテキストキーの接頭辞を `pybp.` から `ipydesk.` に変更（例: `pybp.figureDisplay` → `ipydesk.figureDisplay`）
  - Python パッケージ名を `pybp` から `ipydesk` に変更（`python -m ipydesk`）
  - 環境変数を `PYBP_*` から `IPYDESK_*` に変更
- リポジトリの構成を VS Code 拡張の一般的な形に合わせました（拡張をルートに置き、Python 側は `python/` に置く）。Python は `python/` からそのまま vsix に同梱されます。
