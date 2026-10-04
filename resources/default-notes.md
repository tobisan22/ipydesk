## IPyDesk のショートカット

実行
| キー | 動作 |
|---|---|
| F5 | 実行（2 回目以降は同じセッションで再実行。実行中なら別のセッションで実行） |
| Alt+F5 | 実行し、エラーが出たらその行で止まる |
| Ctrl+Alt+F5 | 新しいセッションで実行 |
| Ctrl+Shift+F5 | 空のセッションを追加（スクリプトは実行しない） |
| Ctrl+Enter | カーソルのあるセル（`# %%` 区切り）を実行 |
| Shift+Enter | セルを実行して次のセルへ |
| Ctrl+Shift+Enter | 選択範囲（選択が無ければ現在行）を実行 |


## matplotlib: subplots の基本

import matplotlib.pyplot as plt
import numpy as np
plt.rcParams.update(
    {
        "font.family": "Meiryo",
        "font.size": 10,
        "axes.grid": True,
        "axes.grid.which": "both",
        "grid.linestyle": ":",
        "grid.alpha": 0.6,
        "xtick.direction": "in",
        "ytick.direction": "in",
        # "xtick.minor.visible": True,
        # "ytick.minor.visible": True,
    }
)

t = np.linspace(0, 10, 100)

figset = {"clear":True, "constrained_layout":True, "sharex":True}

fig, axs = plt.subplots(2, 1, num=1, **figset)
axs[0].plot(t, np.sin(t))
axs[1].plot(t, np.cos(t))

axs[0].set_ylabel("x [m]")
axs[1].set_ylabel("v [m/s]")
axs[-1].set_xlabel("time [s]")


## matplotlib: 軸の範囲・目盛り

import matplotlib.ticker as mticker

# 刻み幅・個数で指定
ax.xaxis.set_major_locator(mticker.MultipleLocator(0.5))    # 0.5 刻み
ax.xaxis.set_minor_locator(mticker.AutoMinorLocator(5))     # 主目盛りの間を 5 分割する補助目盛り
ax.yaxis.set_major_locator(mticker.MaxNLocator(6))          # 目盛りの数を 6 個程度に

# ラベルの書式（既定の書式のまま調整する）
ax.ticklabel_format(axis="y", useOffset=False)              # 「+1.234e3」のようなオフセット表示をやめる
ax.ticklabel_format(axis="y", style="sci", scilimits=(-3, 3))  # 指数表記

# ラベルの書式（書式を差し替える。使うのはどれか 1 つ。差し替えた後は ticklabel_format は使えない）
ax.yaxis.set_major_formatter(mticker.FormatStrFormatter("%.2f"))
ax.yaxis.set_major_formatter(mticker.PercentFormatter(1.0)) # 0.25 → 25%

## 外部 exe の実行（subprocess）

import os
from subprocess import runm Popen, PIPE, STDOUT

path = "C:\tools"
exe = "sim.exe"

# 終わるまで待つ。check=True: 終了コードが 0 以外なら CalledProcessError
r = subprocess.run(path, cwd=path, capture_output=True, text=True, check=True, timeout=600)
print(r.returncode)
print(r.stdout)

# 出力を 1 行ずつ表示しながら待つ（長い計算向け）
p = Popen(exe, stdout=PIPE, stderr=STDOUT, text=True)
while p.poll() is None:
    for line in p.stdout:
        print(line, end="")
p.wait()     # 終わるまで待つ
print("終了コード", p.returncode)
