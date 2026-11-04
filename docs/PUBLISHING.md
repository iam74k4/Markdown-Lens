# Marketplace公開ガイド

## 公開用の情報

| 項目 | 設定 |
| --- | --- |
| 表示名 | Markdown Lens — WYSIWYG & Review |
| 発行者ID | iam74k4 |
| パッケージ名 | markdown-lens-review |
| 拡張ID | iam74k4.markdown-lens-review |
| リリース対象 | 0.12.2 |
| ライセンス | MIT |
| アイコン | media/icon.png（256 × 256、原稿はicon.svg） |
| リポジトリ | https://github.com/iam74k4/Markdown-Lens |
| 問い合わせ | https://github.com/iam74k4/Markdown-Lens/issues |

掲載本文はREADME.md、更新履歴はCHANGELOG.mdを使用します。表示名は「Markdown Lens — WYSIWYG & Review」、パッケージ名は `markdown-lens-review` です。旧候補 `markdown-review` はMarketplaceで名前の重複により拒否されたため使用しません。MarketplaceとOpen VSXで同じIDを使用します。

0.12.2には統合Preview、外部AI編集の自動反映、コピー＆ペーストとMarkdown保存の保持修正を含みます。Marketplaceでの処理状況は管理画面と公開ページで確認します。Open VSXは未公開です。パッケージ生成、アップロード受理、一般公開、各エディターでのインストール確認は別々に記録します。

## 配布物の作成

```sh
npm ci
npm run check
npm test
npm run package -- --out markdown-lens-0.12.2.vsix
```

VSIXにはビルド済みコード、PNGアイコン、README、画面例、MITライセンス、依存ライブラリのライセンス表記を含めます。テスト用文書・検証ログ・node_modulesは含めません。パッケージ内容は `npx vsce ls --no-dependencies` で確認できます。

## Visual Studio Marketplaceの初回公開

1. [パブリッシャー管理](https://marketplace.visualstudio.com/manage)へMicrosoftアカウントでログイン。
2. 発行者名・IDを `iam74k4` として登録。作成ボタンは出版契約への同意を兼ねるため、アカウント所有者が契約を確認してから実行します。
3. 発行者の管理画面から「New extension」→「Visual Studio Code」を選択。
4. `markdown-lens-0.12.2.vsix` をアップロードし、名称、発行者、アイコン、README、ライセンスを確認して公開。
5. 処理完了後に掲載ページを確認し、VS Codeで `@id:iam74k4.markdown-lens-review` を検索してインストール。

手動アップロードの場合、チャットにPATを渡す必要はありません。管理画面上の検証エラーがあれば修正したVSIXを作り直します。

## Open VSX / Cursorへの公開

1. [Open VSXの公開手順](https://github.com/eclipse-openvsx/openvsx/wiki/Publishing-Extensions)に従い、Eclipseアカウント・GitHub連携・Publisher Agreementへの同意を済ませます。
2. `iam74k4` の名前空間を作成し、必要に応じて所有者の確認手続きを行います。Marketplace側の登録とは別です。
3. Open VSXの認証を設定し、同じVSIXを `npx ovsx publish markdown-lens-0.12.2.vsix` で公開します。PAT方式なら端末／CIの `OVSX_PAT` を使い、トークンをソースやチャットに記載しません。
4. Open VSXの掲載を確認した後、Cursorで同じ拡張IDを検索し、インストール・起動を確認します。Cursor側の検査・反映状況により、Open VSXへの公開と検索可能になる時点は一致しない場合があります。

## 公開後の確認

- 両エディターで発行者が `iam74k4`、表示名が「Markdown Lens — WYSIWYG & Review」、バージョンが0.12.2であること。
- Markdown LensのコマンドでPreviewを開き、Markdownソースの表示・編集・保存ができること。
- 変更マーカー、確認／復元、表・画像・Mermaidが動作すること。
- アイコン、READMEの画像・リンク、ライセンス・問い合わせ先がストア上でも表示されること。
- READMEの「未公開」を実際の掲載URLに置き換えること。掲載前に公開済みと記載しないこと。

旧ローカル版からの切り替えは [移行案内](guide.md#ローカル版からの移行) を参照してください。

## 更新の自動化

現在のCIは検証とVSIX生成までで、Release作成による自動公開は設定していません。初回掲載を確認した後、[MarketplaceのTrusted Publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#publish-with-github-actions-and-trusted-publishing)を設定すると、GitHub ActionsからPATを保存せずに公開できます。

信頼ポリシーには所有者 `iam74k4`、リポジトリ `Markdown-Lens`、実際に用意したワークフロー名を登録します。公開ジョブだけに `id-token: write` を与え、検証済みVSIXを `npx vsce publish --oidc --packagePath <VSIX>` で送信する構成にします。公開用ワークフローと信頼ポリシーの設定は、今回の準備では未実施です。

公式資料: [VS Code公開手順](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)、[拡張マニフェスト](https://code.visualstudio.com/api/references/extension-manifest)、[Cursorの拡張配布](https://cursor.com/help/customization/extensions)。
