# IPyDesk — 変数も図も残る Python 実行環境

F5 で Python スクリプトを **常駐 IPython セッション**の中で実行します。エディタの赤丸（ブレークポイント）で
停止でき、**実行が終わっても変数と figure は生きたまま**残ります。実行後にそのまま変数を確認したり、
続きの計算をしたりできます。MATLAB のコマンドウィンドウに近い使い心地です。

debugpy は使いません（中身は IPython + ipdb）。赤丸を1つも置かなければトレースは入らないので、
通常の `python script.py` と同じ速度で走ります。

---

## 動作環境

**この拡張機能は Windows 専用です。** macOS / Linux では動作しません。
Marketplace にも Windows (win32-x64) 向けのプラットフォーム限定パッケージとして公開しています。

## インストール

1. `.vsix` を受け取ったフォルダで:

   ```
   code --install-extension ipydesk-0.0.1.vsix
   ```

2. **VS Code を完全に終了して、開き直してください。** ウィンドウの再読み込みだけでは足りません。

3. 入ったか確認するには:

   ```
   code --list-extensions
   ```

   `bisan.ipydesk` が出れば OK です。

### 必要なもの

**OS: Windows のみ。**

**Python 3.9 以上**（3.9 〜 3.13 で動作します）。

使う Python に以下が入っている必要があります。

| パッケージ | 用途 |
|---|---|
| `ipython` | セッション本体 |
| `ipdb` | 赤丸での停止・ステップ実行 |
| `matplotlib` | 図の表示 |
| `tornado` | 既定の webagg バックエンド（図を VS Code のタブに出すのに必須） |

**不足していても大丈夫です。** 初回の F5 で拡張が自動的に検出し、
「IPyDesk: 依存パッケージが不足しています（…）」という通知で **［インストール］** を選べば
`python -m pip install …` を実行します。［あとで］を選んでもセッション自体は起動します。

自分で入れるなら:

```
python -m pip install ipython ipdb matplotlib tornado
```

Python 3.9 の場合、pip が自動的にその版に対応するバージョン
（ipython 8.18 系 / matplotlib 3.9 系）を選びます。バージョン指定は不要です。

**`ipydesk` パッケージ本体はこの拡張に同梱されています。`pip install ipydesk` は不要です。**

---

## はじめての実行

1. **フォルダを開きます**（ファイル → フォルダーを開く）。
   これは重要です。IPyDesk は開いたフォルダの `.vscode/` を通して拡張と Python がやり取りするため、
   **ファイル単体で開いた状態では赤丸が効きません。** スクリプトも、開いたフォルダの中に置いてください。
2. `.py` ファイルを開きます。
3. 行番号の左をクリックして赤丸を置きます（VS Code の標準機能です）。
4. **F5**。ターミナル「IPyDesk」が開き、`[ipydesk] session started (webagg backend)` と表示されます。
5. 赤丸の行で実行が止まり、その行がハイライトされます。ステータスバーに
   `IPyDesk: ファイル名:行番号` が黄色く出ます。
6. **F5** で続行、**F10** で次の行へ。最後まで走ると IPython プロンプト `In [n]:` に戻ります。
7. **ここで変数がそのまま残っています。** プロンプトで変数名を打てば中身を確認できます。

---

## 使い方

### キー操作

| キー | 状態 | 動作 |
|---|---|---|
| **F5** | 通常 | 初回: セッション起動 + 実行 / 2回目以降: **同じセッションで再実行**（実行中なら別のセッションで実行）。エラーでは止まらない |
| **Alt+F5** | 通常 | 実行し、**エラーが出たらその行で止まる** |
| **Ctrl+Alt+F5** | 通常 | **新しいセッション**を起動して実行 |
| **Ctrl+Enter** | 通常 | カーソルのある**セルを実行** |
| **Shift+Enter** | 通常 | セルを実行して**次のセルへ進む** |
| **Ctrl+Shift+Enter** | 通常 | **選択範囲**（選択が無ければ**現在行**）を実行 |
| **F5** | 停止中 | 続行 (`c`) |
| **F10** | 停止中 | ステップオーバー (`n`) |
| **F11** | 停止中 | ステップイン (`s`) |
| **Shift+F11** | 停止中 | ステップアウト (`r`) |
| **Shift+F5** | 停止中 | デバッガを抜ける (`q`) → IPython プロンプトへ |
| **Ctrl+Shift+F5** | 通常 | アクティブなセッションを破棄して最初から起動し直す |
| **Ctrl+C** | Figure タブ | その figure の画像をクリップボードへコピー |

エディタ右上のツールバーにも同じボタンが並びます（▷ 実行 / 再起動 / 📈 Figure を開く）。
停止中は ▷ のすぐ隣に **■ デバッガを抜ける**（`q`）が出て、その右に 続行 / ステップオーバー / ステップイン / ステップアウト が並びます。
すべて `Ctrl+Shift+P` のコマンドパレットから `IPyDesk:` で呼ぶこともできます。

F5 を押すとファイルは自動保存されてから実行されます。

### セル実行（`# %%`）

MATLAB のセクション（`%%`）と同じ感覚で、スクリプトの一部だけを繰り返し実行できます。
コメント行 `# %%`（`#%%` でも可）を書くと、そこがセルの区切りになります。

```python
# %% データの準備
import numpy as np
x = np.linspace(0, 10, 100)

# %% ここだけ何度も試す
y = np.sin(x * 2)
y.max()
```

- **Ctrl+Enter** でカーソルのあるセルだけを実行します。上のセルで作った変数はそのまま残っているので、
  重い前処理を一度だけ走らせて、下のセルを何度も書き換えながら試せます
- **Shift+Enter** は実行してから次のセルへ進みます。上から順に試すときはこれを押し続けてください
- **Ctrl+Shift+Enter** は選択範囲（何も選んでいなければカーソル行）を実行します。
  `for` の中身のように字下げされた部分だけを選んでも実行できます
- セルの**最後が式なら、その値が `Out[n]` に表示されます**（`y.max()` の行など）
- **赤丸はセル実行でも効きます。** 例外が起きた行で止まるのも F5 と同じです
- 区切り行には線が引かれ、カーソルのあるセルが薄く強調されます。左端の折りたたみでセル単位に畳めます
  （`ipydesk.showCellDecorations` で切り替え）
- セッションがまだ無ければ、セル実行がそのままセッションの起動も兼ねます
- ファイルは実行前に自動保存されます（Python 側がファイルを読み直すため）

- セル区切りが 1 つも無いファイルでは、全体が 1 セルです（Ctrl+Enter は F5 と同じ範囲を実行します）

> **Jupyter 拡張を入れていると Ctrl+Enter / Shift+Enter を取られます。**
> Jupyter / Python 拡張も同じキーを使っており、拡張どうしの優先順位は選べないため、
> そのままではインタラクティブウィンドウが開くことがあります。
> `Ctrl+Shift+P` →「**IPyDesk: Use IPyDesk Cell Keys**」を実行すると、あなたのキー設定
> （`keybindings.json`。拡張の割り当てより必ず優先されます）に IPyDesk の割り当てを追加します。
> Jupyter 拡張が入っていれば、初回起動時にも確認のメッセージが出ます。
> 手で書く場合は次の 3 行です。
>
> ```json
> { "key": "ctrl+enter",       "command": "ipydesk.runCell",           "when": "editorTextFocus && editorLangId == python && !ipydesk.stopped && !inDebugMode && !suggestWidgetVisible" },
> { "key": "shift+enter",      "command": "ipydesk.runCellAndAdvance", "when": "editorTextFocus && editorLangId == python && !ipydesk.stopped && !inDebugMode && !suggestWidgetVisible" },
> { "key": "ctrl+shift+enter", "command": "ipydesk.runSelection",      "when": "editorTextFocus && editorLangId == python && !ipydesk.stopped && !inDebugMode && !suggestWidgetVisible" }
> ```

> **Ctrl+Enter は VS Code 標準の「下に行を挿入」を Python ファイル上で置き換えます。**
> 元の動作が必要なら、キーボードショートカット設定で `ipydesk.runCell` を別のキーに変えてください。

### 2回目以降が速い理由

1回目の F5 で IPython セッションが立ち上がり、**そのセッションは実行後も生き続けます。**
2回目以降の F5 は同じセッションに再実行を投げるだけなので、起動のオーバーヘッドがありません。
スクリプトはセッションの名前空間の中で実行されるため、**定義された変数はそのまま残ります。**

- `%reset` でワークスペースをクリア
- `exit` でセッション終了
- 自作モジュールは `autoreload` が有効なので、編集すると次の実行に自動で反映されます
  （挙動が怪しくなったら **Ctrl+Shift+F5** でセッションごと作り直してください）
- IPython プロンプトから `%ipydesk "C:\path\to\script.py"` と手で打っても同じ実行ができます

### 複数のセッションを同時に動かす

重いスクリプトを実行している間に、別のスクリプト（同じスクリプトでも可）を並行して実行できます。

- 実行中のセッションがある状態で F5 / セル実行すると、**空いている別のセッション**で実行します。
  空きが無ければ新しいセッションを起動します（ターミナル `IPyDesk 2`, `IPyDesk 3`, …）
- **Ctrl+Alt+F5**（▷ の隣のボタン / `IPyDesk: Run in New Session`）は、必ず新しいセッションで実行します
- F5 の送り先は「アクティブなセッション」です。IPyDesk のターミナルを切り替えるとそのセッションがアクティブになり、
  ワークスペースビューもそのセッションの変数に切り替わります。ステータスバーのクリックか
  `IPyDesk: Select Session` からも選べます
- 2 つ目以降のセッションの図は `Figure 1 (IPyDesk 2)` のように名前付きのタブに出ます
- **赤丸は全セッション共通です。** 置くとどのセッションも同じ行で止まり、F10 などは最後に止まったセッション
  （またはターミナルを前に出しているセッション）に届きます
- スクリプトが保存するファイル（`savefig` や CSV など）は、名前が同じだと後から書いた方で上書きされます

### 赤丸について

- **条件付きブレークポイントに対応しています。** 赤丸を右クリック →「条件付きブレークポイントの編集」
- 赤丸を無効化（グレー）すると、その行では止まりません
- **停止中に赤丸を足したり消したりできます。** 次の続行・ステップ操作から反映されます
- 赤丸が1つも無ければトレースは一切入らず、素の速度で走ります

### エラーが出たとき

F5 とセル実行では、例外が起きても**止まらずにトレースバックを出してプロンプトに戻ります**。
ステータスバーに **⚠ エラーの種類（ファイル名:行）** が出るので、それをクリックすると
**エラーが起きた行で停止した状態**に入れます（ポストモーテムデバッグ。`IPyDesk: Debug Last Error` / `%ipydesk_pm` でも同じ）。
走り直さずに入れるので、重い計算の後で落ちたときもその時点の変数をそのまま調べられます。

最初からエラーの行で止めたいときは **Alt+F5**（`IPyDesk: Run (Stop on Error)`）で実行してください。

- エディタ上でエラー行がハイライトされ、`ipdb>` プロンプトでその時点の変数を調べられます
- ライブラリの内部ではなく、**自分のコードの一番深い場所**が選ばれます
- 調べ終わったら `q`（または Shift+F5）で抜けてください
- 直前のエラーに入れるのは、次の実行（F5 / セル実行）を始めるまでです

---

## 図（figure）について

matplotlib の figure は webagg バックエンドでノンブロッキング表示され、**figure ごとに VS Code のタブが開きます。**
`plt.show()` で実行が止まることはありません。実行が終わってもタブは残ります。

- Figure タブは**コードの隣のグループにまとめて**開きます。開いてもアクティブなグループはコード側のままなので、
  F5 の後もそのままキー入力を続けられます
- 赤丸やエラーで止まったときの停止行は、**コード側のグループ**に表示します（Figure 側に同じスクリプトは開きません）

- **コピー**: タブ右上の 📋、グラフのツールバーの **Copy**、または **Ctrl+C** で、その figure の画像を
  クリップボードへ入れます。Word / PowerPoint にそのまま貼り付けられます
  （**Windows のみ**。VS Code のクリップボード API がテキスト専用のため、PowerShell 経由で実装しています）
- **保存**: ツールバーの 💾 は VS Code の保存ダイアログを開きます。形式は隣のドロップダウン
  （png / svg / pdf など）に従います
- `plt.close(n)` で閉じた figure のタブは自動的に閉じます。`plt.close("all")` で全部閉じます
- タブを自分で閉じても figure 自体は生きているので、**IPyDesk: Open Figures**（📈 ボタン）で開き直せます
- 自動で開いてほしくない場合は設定 `ipydesk.figureDisplay` を `manual` に。
  figure は作られたままなので、**IPyDesk: Open Figures**（📈）で必要なときだけ開けます
- **タブではなく OS の別ウィンドウに出したい場合は `ipydesk.figureDisplay` を `window`** に。
  matplotlib の Qt / Tk バックエンドに切り替わり、webagg サーバーは起動しません
  （どちらを使うかは `ipydesk.windowBackend`。`auto` なら PyQt / PySide → tkinter の順に探します）。
  この場合 Figure タブが無いので、📋 コピーと VS Code の保存ダイアログは使えません。
  matplotlib のウィンドウに付いている標準のツールバーを使ってください
- **図を一切出したくない場合は `ipydesk.figureDisplay` を `none`** に。webagg サーバーを
  起動しないのでポート（既定 8988）も使いません。`Agg` バックエンドになるため
  `plt.show()` は何もせず、`fig.savefig("out.png")` でのファイル出力はそのまま使えます

---

## 設定

`Ctrl+,` の設定画面で `ipydesk` を検索してください。

| 設定 | 既定 | 内容 |
|---|---|---|
| `ipydesk.pythonPath` | `python` | セッション起動に使う Python 実行ファイル。フルパス可 |
| `ipydesk.webaggPort` | `8988` | 図の表示に使うポート。他のアプリと衝突する場合に変更 |
| `ipydesk.useBundledPython` | `true` | 同梱の `ipydesk` を使う。**通常は `true` のままにしてください** |
| `ipydesk.figureDisplay` | `tab` | 図の表示先。`tab`（タブを自動で開く）/ `manual`（タブだが自動で開かない）/ `window`（別ウィンドウ）/ `none`（表示しない） |
| `ipydesk.windowBackend` | `auto` | `figureDisplay` が `window` のときのバックエンド。`auto` / `qt` / `tk` |
| `ipydesk.showCellDecorations` | `true` | `# %%` の区切り線と、カーソルのあるセルの強調を表示する |
| `ipydesk.autoOpenFigures` | `true` | 非推奨。`ipydesk.figureDisplay` に統合されました（`false` は `manual` と同じ） |

`ipydesk.figureDisplay` を変えたら **Ctrl+Shift+F5** でセッションを作り直してください
（バックエンドは起動時に決まります）。確認のダイアログも出ます。

ターミナルから `python -m ipydesk` を直接起動する場合は、環境変数 `IPYDESK_MPL` で
バックエンドを指定できます（既定 `webagg`。`qt` / `tk` / `inline` / `none` / `auto`）。

---

## うまく動かないとき

| 症状 | 原因と対処 |
|---|---|
| **赤丸を置いても止まらない** | フォルダを開かずファイル単体で開いています。**フォルダーを開く**で開き直し、スクリプトをそのフォルダ内に置いてください |
| `IPyDesk: Python を実行できません` | `ipydesk.pythonPath` が正しい Python を指していません。フルパスで指定してみてください |
| **依存パッケージの確認が毎回出る** | `ipydesk.pythonPath` が、依存を入れた Python と別のものを指しています。ターミナルで `python -c "import sys; print(sys.executable)"` を実行し、その結果を `ipydesk.pythonPath` に設定してください |
| **F5 が反応しない / コマンドが無い** | VS Code を完全終了して開き直してください。それでも駄目なら `code --uninstall-extension bisan.ipydesk` の後に再インストール |
| **`ipydesk を import できません` と出る** | 拡張に同梱された `ipydesk` に PYTHONPATH が通っていません。設定 `ipydesk.useBundledPython` が `true` になっているか確認し、拡張を入れ直して VS Code を完全終了・再起動してください |
| **`No module named 'IPython'` などで落ちる** | `ipydesk.pythonPath` の Python に依存が入っていません。F5 で出る［インストール］を選ぶか、`python -m pip install ipython ipdb matplotlib tornado` を実行してください |
| **図が出ない / タブが空白** | `ipydesk.webaggPort`（既定 8988）が他のアプリと衝突しています。別の番号に変えてセッションを再起動（Ctrl+Shift+F5）してください。タブが空白のままならパネルの境界をドラッグしてサイズを変えると描画されます |
| **図のコピーができない** | Windows のみ対応です。macOS / Linux では 💾 での保存を使ってください |
| **Ctrl+Enter でインタラクティブウィンドウが開く** | Jupyter 拡張に取られています。`Ctrl+Shift+P` →「IPyDesk: Use IPyDesk Cell Keys」を実行してください（あなたのキー設定は拡張より優先されます） |
| **Ctrl+Enter で何も起きない** | 拡張が古い可能性があります。最新版が入っているか確認してください（`Ctrl+Shift+X` で `ipydesk` を検索） |
| **セッションがおかしくなった** | **Ctrl+Shift+F5** でセッションを作り直してください。それでも駄目ならターミナル「IPyDesk」を閉じてから F5 |

原因が分からないときは、ワークスペースの `.vscode/py_ext_log.txt` に拡張側の動作ログが残っています
（セッション起動のたびに書き直されます）。これを添えて報告してもらえると調査できます。

### `.vscode/` に出てくるファイル

IPyDesk は拡張と Python の間のやり取りに、開いているフォルダの `.vscode/` を使います。
自動で作られ、セッション終了時に消えます。**手で編集する必要はありません。**

| ファイル | 中身 |
|---|---|
| `py_breakpoints.json` | 拡張 → Python : 赤丸の一覧（全セッション共通） |
| `py_ext_log.txt` | 拡張の動作ログ（調査用） |
| `py_sessions/<番号>/` | セッションごとの通知（下の 4 つ）。番号はターミナル `IPyDesk`, `IPyDesk 2`, … に対応 |
| 　`py_session.json` | Python → 拡張 : セッションが生きているか・実行中か・直前のエラー |
| 　`py_debug_state.json` | Python → 拡張 : 現在の停止位置 |
| 　`py_figures.json` / `py_workspace.json` | Python → 拡張 : 表示中の figure 番号 / 変数一覧 |
| 　`py_save_request.json` | Python → 拡張 : 図の保存ダイアログ要求 |

git で管理しているフォルダなら、`.gitignore` に `.vscode/py_*` を足しておくと邪魔になりません。

---

## 制約

- 赤丸がある実行では pdb のトレースが入るため、重い数値計算は遅くなります（赤丸ゼロなら素の速度）
- 停止中のマウスホバーによる変数表示には未対応です。`ipdb>` プロンプトで変数名を打ってください
- 標準ライブラリ・IPython・matplotlib の内部には F11（ステップイン）でも入りません
- 図のクリップボードコピーは Windows のみです
