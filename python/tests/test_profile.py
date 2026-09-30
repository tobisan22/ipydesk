"""起動時処理とユーザーの IPython プロファイルの回帰テスト（0.0.6）

- プロファイルの startup ファイル・exec_lines は 1 回だけ実行される
  （以前は ipdb が import 時に使い捨ての IPython アプリを作り、2 回実行されていた）
- プロファイルの exec_lines / extensions は ipydesk の設定で消されず、ipydesk の起動行より先に動く
"""

import os
import subprocess
import sys
from pathlib import Path

PKG = Path(__file__).resolve().parents[1]


def test_profile_runs_once_and_is_kept(tmp_path):
    ipdir = tmp_path / "ipython"
    (ipdir / "profile_default" / "startup").mkdir(parents=True)
    (ipdir / "profile_default" / "startup" / "00-test.py").write_text(
        'print("MARK-STARTUP")\n', encoding="utf-8")
    (ipdir / "profile_default" / "ipython_config.py").write_text(
        'c.InteractiveShellApp.exec_lines = ["print(\\"MARK-EXEC\\")"]\n'
        'c.InteractiveShellApp.extensions = ["storemagic"]\n',
        encoding="utf-8")
    script = tmp_path / "s.py"
    script.write_text('print("MARK-SCRIPT")\n', encoding="utf-8")
    env = {**os.environ, "IPYTHONDIR": str(ipdir), "IPYDESK_MPL": "none",
           "PYTHONPATH": str(PKG)}
    env.pop("IPYDESK_SESSION_DIR", None)
    out = subprocess.run(
        [sys.executable, "-m", "ipydesk", str(script)],
        input="print('EXT', sorted(get_ipython().extension_manager.loaded))\nexit\n",
        capture_output=True, text=True, env=env, cwd=tmp_path, timeout=120,
    ).stdout
    assert out.count("MARK-STARTUP") == 1
    assert out.count("MARK-EXEC") == 1
    assert out.index("MARK-EXEC") < out.index("MARK-SCRIPT"), "プロファイルの行が先"
    assert "'ipydesk.core'" in out and "storemagic'" in out
