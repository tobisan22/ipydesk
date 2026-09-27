# 開発者向けメモ

## フォルダ構成

```
ipydesk/
├── .vscode/            F5 デバッグ・ビルドタスク
├── src/                拡張本体（TypeScript）
│   ├── extension.ts
│   ├── workspaceView.ts
│   └── test/
├── python/             Python 側
│   ├── ipydesk/        vsix にそのまま同梱される（拡張は <拡張>/python を PYTHONPATH に追加）
│   ├── tests/          pytest
│   └── pyproject.toml
├── media/              アイコン類
├── package.json        拡張マニフェスト
└── README.md / CHANGELOG.md / LICENSE
```

## よく使うコマンド

| 目的 | コマンド |
|---|---|
| 依存の導入 | `npm install` |
| TypeScript のビルド | `npm run compile`（`npm run watch` で常時） |
| 拡張のデバッグ | VS Code で F5（Run Extension） |
| Python のテスト | `cd python && pip install -e . && pytest` |
| vsix の作成 | `npx @vscode/vsce package` |

## リリース手順

1. `package.json` と `python/pyproject.toml` の `version` を揃えて上げる
2. `CHANGELOG.md` に追記
3. `git tag vX.Y.Z`
