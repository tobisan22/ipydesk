# Change Log

All notable changes to the "ipydesk" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [0.0.5] - 2026-09-29

### Fixed

- Windows で conda の MKL 版 numpy / scipy を使っていると、実行中に Ctrl+C を押したときに `forrtl: error (200)` でセッション（ターミナル）ごと終了していた問題を修正しました。Intel Fortran ランタイムの Ctrl+C ハンドラを無効にし（`FOR_DISABLE_CONSOLE_CTRL_HANDLER=1`）、実行中のコマンドだけが `KeyboardInterrupt` で止まるようにしました。

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
