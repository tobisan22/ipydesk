# 設定

[← README に戻る](../README.md)

`Ctrl+,` で設定を開き、「ipydesk」で検索すると一覧が出ます。

## よく使う設定

| 設定 | 既定 | 内容 |
|---|---|---|
| `ipydesk.pythonPath` | （未設定） | 使う Python の実行ファイル。未設定なら VS Code 右下で選んだ環境を使う（[詳しく](#python-環境の選び方)） |
| `ipydesk.uvPath` | （未設定） | uv の実行ファイル。空なら PATH・`~/.local/bin`・`~/.cargo/bin` から探す |
| `ipydesk.figureDisplay` | `tab` | 図の表示先: `tab` / `manual`（自動で開かない）/ `window`（別ウィンドウ）/ `none`（[詳しく](figures.md#表示先を変える)） |
| `ipydesk.webaggPort` | `8988` | 図の表示に使うポート |

`figureDisplay` を変えたら、通知の「置き換える」を押すか、Ctrl+Shift+F5 で新しいセッションを作ってください。

## すべての設定

**実行・赤丸**

| 設定 | 既定 | 内容 |
|---|---|---|
| `ipydesk.breakpointMode` | `trace` | 赤丸で止まる方式。`trace`: 従来のトレース / `inject`: 赤丸の行に到達するまで全速で実行（試験的） |
| `ipydesk.slowRunNotifySec` | `5` | 赤丸のトレースで実行がこの秒数以上かかったら、赤丸なしでの再実行などを案内する（0 で通知しない） |
| `ipydesk.maxOutputChars` | `200000` | コンソールに表示する出力（`Out[n]` など）の上限文字数。巨大な表示でターミナルが固まるのを防ぐ（0 で無制限） |
| `ipydesk.showCellDecorations` | `true` | `# %%` の区切り線とセルの強調を表示する |
| `ipydesk.useBundledPython` | `true` | 同梱の `ipydesk` を使う（通常は変更不要） |

**図**

| 設定 | 既定 | 内容 |
|---|---|---|
| `ipydesk.figureDisplay` | `tab` | 図の表示先 |
| `ipydesk.windowBackend` | `auto` | `figureDisplay` が `window` のときのバックエンド: `auto` / `qt` / `tk` |
| `ipydesk.webaggPort` | `8988` | 図の表示に使うポート |
| `ipydesk.figureHistory` | `20` | 描き直した図を Figure タブに残す枚数（figure ごと。0 で無効） |

**Variable Editor・ファイルの実行**

| 設定 | 既定 | 内容 |
|---|---|---|
| `ipydesk.variableEditor.zoom` | `100` | Variable Editor の表示倍率の既定値（%、50〜200） |
| `ipydesk.runFileExtraExtensions` | `[]` | エクスプローラーから実行できるファイルに足す拡張子（`.bat` `.cmd` `.exe` `.ps1` は常に対象） |

`figureHistory`・`maxOutputChars` の変更は、新しいセッションから有効です。

## Python 環境の選び方

セッションを起動するとき、次の順で Python を決めます。

1. `ipydesk.pythonPath` を設定していれば、その Python（`${workspaceFolder}` が使え、相対パスはワークスペース基準）
2. Python 拡張（ms-python.python）で選んでいる環境 — VS Code 右下に出ているもの
3. ワークスペース直下の `.venv`
4. PATH 上の `python`

uv や venv の環境を使うときは、右下で `.venv` を選ぶだけで切り替わります。セッションを動かしたまま右下の環境を切り替えると、新しい環境で置き換えるかを聞いてきます（置き換えると変数は消えます）。使っている Python は、ステータスバーの「IPyDesk session」にマウスを載せると確認できます。

## Python のパッケージ

- 必要なパッケージは `ipython` `ipdb` `matplotlib` `tornado` です。不足していれば、初回の F5 で［インストール］を選ぶだけで入ります
- 自分で入れる場合: `python -m pip install ipython ipdb matplotlib tornado`
- `ipydesk` パッケージは拡張に同梱されているため、`pip install ipydesk` は不要です
- 依存パッケージの確認が毎回出るときは、右下で、パッケージを入れた環境を選んでください（または `ipydesk.pythonPath` にその Python のフルパスを指定）
- **uv の環境**（pip が入っていない）では、`uv pip install` で入れます。uv プロジェクト（`pyproject.toml` と `uv.lock` がある）では、`uv add --dev` で pyproject に追加するか、この環境にだけ入れるかを選べます。この環境にだけ入れたものは、次の `uv sync` で消えます

## .vscode に作られるファイル

| ファイル | 内容 | Git |
|---|---|---|
| `.vscode/py_*`（`py_breakpoints.json`・`py_workspace.json`・`py_sessions/` など） | 拡張と Python の連携用。実行のたびに書き換わります | `.gitignore` に入れる |
| `.vscode/py_ext_log.txt` | 拡張の動作ログ | `.gitignore` に入れる |
| `.vscode/ipydesk_args.json` | スクリプトの引数の履歴（[詳しく](arguments.md)） | 共有するならコミットする |

`.gitignore` に `.vscode/py_*` と書いておくと、連携用のファイルとログをまとめて除外できます。
