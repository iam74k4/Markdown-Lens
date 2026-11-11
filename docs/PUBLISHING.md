# Marketplace公開ガイド

## 公開用の情報

| 項目 | 設定 |
| --- | --- |
| 表示名 | Markdown Lens — WYSIWYG & Review |
| 発行者ID | iam74k4 |
| パッケージ名 | markdown-lens-review |
| 拡張ID | iam74k4.markdown-lens-review |
| リリース対象 | 0.14.0 |
| ライセンス | MIT |
| アイコン | media/icon.png（256 × 256、原稿はicon.svg） |
| リポジトリ | https://github.com/iam74k4/Markdown-Lens |
| 問い合わせ | https://github.com/iam74k4/Markdown-Lens/issues |

掲載本文はREADME.md、更新履歴はCHANGELOG.mdを使用します。表示名は「Markdown Lens — WYSIWYG & Review」、パッケージ名は `markdown-lens-review` です。旧候補 `markdown-review` はMarketplaceで名前の重複により拒否されたため使用しません。MarketplaceとOpen VSXで同じIDを使用します。

0.14.0には、編集時の記法保持（折り返し・HTML・frontmatter・アラート・脚注・数式など）、リンク操作とリンク切れの表示、Git連携、テキストエディターでの未確認表示、変更の要約、英語表示、設定とコマンドの追加を含みます。0.14.0は2026-11-11（日本時間）にMarketplaceで公開しました（記録: [evidence/marketplace-0.14.0](../evidence/marketplace-0.14.0/status.json)）。Open VSXは未公開です。パッケージ生成、アップロード受理、一般公開、各エディターでのインストール確認は別々に記録します。

## 配布物の作成

```sh
npm ci
npm run check
npm test
npm run package -- --out markdown-lens-0.14.0.vsix
```

VSIXにはビルド済みコード、PNGアイコン、README、画面例、MITライセンス、依存ライブラリのライセンス表記を含めます。テスト用文書・検証ログ・node_modulesは含めません。パッケージ内容は `npx vsce ls --no-dependencies` で確認できます。

## Visual Studio Marketplaceの初回公開

1. [パブリッシャー管理](https://marketplace.visualstudio.com/manage)へMicrosoftアカウントでログイン。
2. 発行者名・IDを `iam74k4` として登録。作成ボタンは出版契約への同意を兼ねるため、アカウント所有者が契約を確認してから実行します。
3. 発行者の管理画面から「New extension」→「Visual Studio Code」を選択。
4. `markdown-lens-0.14.0.vsix` をアップロードし、名称、発行者、アイコン、README、ライセンスを確認して公開。
5. 処理完了後に掲載ページを確認し、VS Codeで `@id:iam74k4.markdown-lens-review` を検索してインストール。

手動アップロードの場合、チャットにPATを渡す必要はありません。管理画面上の検証エラーがあれば修正したVSIXを作り直します。

## Open VSX / Cursorへの公開

1. [Open VSXの公開手順](https://github.com/eclipse-openvsx/openvsx/wiki/Publishing-Extensions)に従い、Eclipseアカウント・GitHub連携・Publisher Agreementへの同意を済ませます。
2. `iam74k4` の名前空間を作成し、必要に応じて所有者の確認手続きを行います。Marketplace側の登録とは別です。
3. Open VSXの認証を設定し、同じVSIXを `npx ovsx publish markdown-lens-0.14.0.vsix` で公開します。PAT方式なら端末／CIの `OVSX_PAT` を使い、トークンをソースやチャットに記載しません。
4. Open VSXの掲載を確認した後、Cursorで同じ拡張IDを検索し、インストール・起動を確認します。Cursor側の検査・反映状況により、Open VSXへの公開と検索可能になる時点は一致しない場合があります。

## 公開後の確認

- 両エディターで発行者が `iam74k4`、表示名が「Markdown Lens — WYSIWYG & Review」、バージョンが0.14.0であること。
- Markdown LensのコマンドでPreviewを開き、Markdownソースの表示・編集・保存ができること。
- 変更マーカー、確認／復元、表・画像・Mermaidが動作すること。
- アイコン、READMEの画像・リンク、ライセンス・問い合わせ先がストア上でも表示されること。
- READMEの「未公開」を実際の掲載URLに置き換えること。掲載前に公開済みと記載しないこと。

旧ローカル版からの切り替えは [移行案内](guide.md#ローカル版からの移行) を参照してください。

## 更新の自動化

`.github/workflows/publish.yml` は、所有者がGitHubの「Actions → Publish → Run workflow」から手動で実行する公開用ワークフローです。pushでは動かず、`main` 以外から実行した場合は何も公開しません。型チェック・単体テスト・ビルドの後にVSIXを作り（SHA-256をログに記録）、同じVSIXをMarketplaceとOpen VSXへ送ります。どちらか片方だけの公開も選べます。

### 初回だけ必要な設定

**1. GitHubの環境（公開前の承認）**

1. [Settings → Environments](https://github.com/iam74k4/Markdown-Lens/settings/environments) で **New environment** を選び、`marketplace` と `openvsx` を作ります。
2. それぞれ **Required reviewers** に自分（`iam74k4`）を追加し、**Deployment branches and tags** を `main` に限定します。公開のたびに承認が必要になります。
   - 状況（2026-11-11）: 環境 `marketplace` は初回の公開実行で自動作成されました。承認者は未設定です。環境 `openvsx` はまだありません。

**2. Visual Studio Marketplace（Trusted Publishing、PATは不要）**

1. [発行者の管理画面](https://marketplace.visualstudio.com/manage/publishers/iam74k4) で、Trusted Publishing（信頼された公開）のポリシーを追加します。
2. 値は、GitHubの所有者 `iam74k4`、リポジトリ `Markdown-Lens`、ワークフロー `publish.yml`、環境 `marketplace` です（環境を指定する欄がある場合）。
3. ワークフローは `npx vsce publish --oidc --packagePath <VSIX>` を実行します。GitHubのOIDCトークン（audience `marketplace.visualstudio.com`）を最長15分有効な公開用トークンに交換し、PATへの切り替えはしません。必要な権限 `id-token: write` は公開ジョブだけに付けています。
4. 状況（2026-11-11）: ポリシーは登録済みで、0.14.0の公開に使いました。ポリシー登録前の最初の実行は401（`The token could not be exchanged for the specified publisher`）で失敗し、何も公開されませんでした。

**3. Open VSX（アクセストークン）**

1. GitHubのユーザー名を入力して [Eclipseアカウント](https://accounts.eclipse.org/user/register) を作ります。open-vsx.orgへのログインと同じGitHubアカウントを使います。
2. [open-vsx.org](https://open-vsx.org) にGitHubでログインし、[Settings → Profile](https://open-vsx.org/user-settings/profile) の **Log in with Eclipse** で連携します。**Show Publisher Agreement** を開き、最後まで読んで **Agree** を押します。
3. [Access Tokens](https://open-vsx.org/user-settings/tokens) の **Generate New Token** でトークンを作ります（閉じると再表示されません）。
4. GitHubの環境 `openvsx` の **Environment secrets** に、名前 `OVSX_PAT` で保存します。トークンをソースやチャットに書きません。
5. 名前空間 `iam74k4` は、まだなければワークフローが初回の公開時に作ります。作っただけでは他の人も同じ名前空間に公開できるため、[所有権を申請](https://github.com/EclipseFdn/open-vsx.org/issues/new/choose)して検証済みにします。検証後は、Open VSXの [Trusted publishers](https://open-vsx.org/user-settings/trusted-publishers) に登録して `ovsx publish --trusted-publishing` に切り替えると、`OVSX_PAT` を削除できます。

### 公開の実行

1. [Actions → Publish](https://github.com/iam74k4/Markdown-Lens/actions/workflows/publish.yml) で **Run workflow** を選び、ブランチ `main` と公開先（Marketplace / Open VSX）を選んで実行します。
2. 検証とVSIXの作成が終わると、環境ごとに承認を求められます。承認すると公開されます。
3. 公開後は「公開後の確認」を実施し、記録を更新します。

公式資料: [VS Code公開手順](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)、[拡張マニフェスト](https://code.visualstudio.com/api/references/extension-manifest)、[Cursorの拡張配布](https://cursor.com/help/customization/extensions)。
