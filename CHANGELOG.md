# Change Log

All notable changes to the "ipydesk" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

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
