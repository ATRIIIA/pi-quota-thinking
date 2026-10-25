# Pi Coding Agent: Quota-aware Thinking

[English](README_EN.md)

ChatGPT Plus / Codex の**5時間利用枠**を、残り時間と比較してthinkingレベルを自動調整する非公式のPi拡張機能です。

Piの`openai-codex`プロバイダーに対応しています。OpenAIとの提携・承認を受けたものではありません。

OpenAI Codexの支援を受けて開発しました。

## インストール

1. Piで `/login openai-codex` を実行し、ChatGPTアカウントでログインします。
2. `quota-thinking.ts` を `~/.pi/agent/extensions/quota-thinking.ts` に配置します。グローバル配置の場合、同じOSユーザーで起動するPiで作業フォルダーに関係なく読み込まれます。
3. 起動中のPiで `/reload` を実行するか、Piを再起動します。
4. `/quota-thinking refresh` で利用枠の取得と制御を確認します。

プロジェクト専用で使う場合は `.pi/extensions/quota-thinking.ts` に配置できます。二重読み込みを避けるため、グローバル版とプロジェクト版のどちらか一方だけを有効にしてください。

## 使い方

- `/quota-thinking status`: 最後の利用枠データに基づく状態確認
- `/quota-thinking refresh`: 利用枠を再取得しthinkingを適用
- `/quota-thinking off`: 自動制御を一時停止（現在のthinkingレベルを維持）
- `/quota-thinking on`: 自動制御を再開

## 制御ルール

目標残量（%）＝リセットまでの残り秒数÷5時間×100。

実際の残量と目標残量の差（パーセントポイント）により、次のthinkingを選びます。

| 差（実際 - 目標） | Thinking |
| --- | --- |
| +20以上 | `openai-codex/gpt-6.1-sol` / medium |
| +10以上 +20未満 | `openai-codex/gpt-6-luna` / xhigh |
| -10超 +10未満 | `openai-codex/gpt-6-luna` / high |
| -10以下 | `openai-codex/gpt-6-luna` / medium |

5時間枠の残量が3%以下の場合はminimal。週間枠は、残量3%以下または目標ペースより30ポイント以上不足ならminimal以下、残量10%以下または15ポイント以上不足ならlow以下に制限します。ただし、5時間枠の差が+20ポイント以上の場合は、これらの制限より指定モデルへの切替とmediumを優先します。差が+20未満に戻ると `openai-codex/gpt-6-luna` に自動で切り替え、thinkingレベルも通常の判定に戻ります。

対応していないthinkingレベルはPiが対応レベルに丸めます。

## 実装と注意点

- Piの公式 `pi.setModel()` / `pi.setThinkingLevel()` と `before_agent_start` / `turn_end` フックを使用。差が+20ポイント未満では `openai-codex/gpt-6-luna`、+20ポイント以上では `openai-codex/gpt-6.1-sol` に切り替えます（後者はmedium）。
- 利用率は、Piに保存された`openai-codex`のOAuthアクセストークンを使って `https://chatgpt.com/backend-api/wham/usage` から取得します。このAPIは**非公開・非保証**です。変更や失効により取得できない場合は、現在のthinkingを維持します。
- 認証情報を書き換えたり、トークンを更新したり、外部サイトに認証情報を送ったりしません（リクエスト送信先はChatGPTの利用率取得エンドポイントのみ）。
- Pi本体がアクセストークンを更新した後に再取得できます。認証が失効している場合、Piで再ログインしてください。
- 最短60秒キャッシュ。各プロンプトの開始前と各モデルターン終了後に調整します。**実行中の1つのモデル応答を途中から変更することはできません。**
- `pi-adaptive-thinking` を同時に有効にすると、AIがthinkingを書き換える可能性があるため、この機能を優先したい場合は併用しない方が確実です。
- 調整が利用枠消費量を一定比率で変えることは保証されません。残量の減り方はモデル、入力規模、キャッシュなどにも依存します。利用枠の上限に達した場合、minimalでもリクエストできなくなる場合があります。
- Codexの**週間枠**とモデル固有の追加制限は別です。週間枠は利用率が見える場合のみペース制御します。モデル固有の追加制限はこのサンプルでは監視しません。
- 5時間枠がAPIに存在しないプラン・状態では、自動変更せず停止します。
- 認証がChatGPT PlusでなくAPIキー方式の場合、この拡張機能は動作しません。
- 旧閾値（差が+50ポイント以上）での動作確認記録: Pi RPCで利用率を取得し、`openai-codex/gpt-6.1-sol` / `medium` への切替を一時セッションで読み戻し確認済みです。モデル応答は生成していません。非公開APIの将来互換性は保証しません。

## 実際の目標例

残り4h → 目標80%、残り3h → 目標60%、残り2h → 目標40%、残り1h → 目標20%、残り0h → 目標0%。
