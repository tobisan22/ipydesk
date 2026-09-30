"""%ipydesk が %run -i と同じ条件でスクリプトを実行することの回帰テスト（0.0.6）

- ipydesk.core の `from __future__ import annotations` がスクリプトへ漏れない
  （漏れると注釈が文字列になる）
- 実行中の sys.argv はスクリプト名（終わったら戻す）
- スクリプトの変数は名前空間 ns に入り、関数の中から参照できる
"""

import sys

from ipydesk import core

SCRIPT = """\
import sys
g = 5
def f(x: int) -> float:
    return x + g
ann = f.__annotations__
argv = list(sys.argv)
r = f(1)
"""


def test_run_script(tmp_path):
    p = tmp_path / "s.py"
    p.write_text(SCRIPT, encoding="utf-8")
    ns = {}
    before = sys.argv
    core.run_script(p, ns)
    assert ns["ann"] == {"x": int, "return": float}
    assert ns["argv"] == [str(p.resolve())]
    assert sys.argv is before
    assert ns["r"] == 6


def test_run_cell(tmp_path):
    p = tmp_path / "s.py"
    p.write_text(SCRIPT, encoding="utf-8")
    ns = {}
    core.run_cell(p, 1, 7, ns)
    assert ns["ann"] == {"x": int, "return": float}
    assert ns["r"] == 6


def test_function_sees_globals_of_previous_run(tmp_path):
    """前の実行で作った変数を、次のスクリプトの関数から参照できる（%run -i と同じ）"""
    a = tmp_path / "a.py"
    a.write_text("a = 10\n", encoding="utf-8")
    b = tmp_path / "b.py"
    b.write_text("def h():\n    return a * 2\nr = h()\n", encoding="utf-8")
    ns = {}
    core.run_script(a, ns)
    core.run_script(b, ns)
    assert ns["r"] == 20
