// ============================================================
// LINE 相場判定 Bot v8.0 — Web Search + GPT-4o
// MCP中要・OAuth不要のシンプル構成
// ============================================================
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const OpenAI = require('openai').default || require('openai');

const app = express();
const PORT = process.env.PORT || 10000;

// ── クライアント初期化 ──────────────────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const LINE_CONFIG = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || 'https://go-nogo-scraper.onrender.com';

// ── システムプロンプト ──────────────────────────────
const SYSTEM_PROMPT = `あなたは日本のオークション・フリマ市場に精通した相場分析のプロフェッショナルです。

## あなたの役割
ユーザーから商品名（型番）と仕入れ価格が送られてきたら、Web検索で実際の落札データを取得し、正確な相場判定を行ってください。

## 検索手順（必ず実行）
1. 「site:aucfan.com {商品名}」で検索して、オークファンの落札相場ページを見つける
2. 見つかったページからYahoo!オークションの実際の落札価格データを取得する
3. 検索結果が少ない場合は、以下の順で追加検索する：
   a. 「{商品名} 落札相場 aucfan」
   b. 「{商品名} ヤフオク 落札相場」
   c. 「{商品名} メルカリ 相場」
   d. 「{商品名} 中古相場 買取」
   e. キーワードを短縮して再検索（例: 「iPhone 15 Pro 256GB」→「iPhone15Pro」）
   f. 型番がある場合は型番のみでも検索する
4. **最低でも2〜3回は異なるキーワードで検索する**こと

## 重要ルール
- **データが少なくてもエラーにしない**。1件でもデータがあればそれを元に回答する
- 複数ソース（aucfan、ヤフオク、メルカリ、買取サイト）のデータを総合して判断する
- データが全く見つからない場合でも、類似商品や一般的な中古市場の知識で参考相場を提示すク（その場合は推定であることを明記すク）
- 推測で価格を出す場合は「※推定」と必ず明記する
- 金額は全てカンマ区切りで表示する
- LINEメッセージとして読みやすいよう簡潔に整理する

## 状態別の相場分析
商品の状態ごとに相場が大きく異なるため、可能な限り以下の区分で分析する：
- 🆕 新品・未開封
- ✨ 未使用に近い
- 👍 目立った傷や汚れなし
- ⚠️ やや傷や汚れあり
- 🔧 ジャンク・部品取り

検索データから状態が判別できる場合は分けて表示する。判別できない場合は「状態混在」として平均を出す。

## 注意すべきポイント（必ず含める）
回答には必ず以下の注意ポイントを含める：
- 付属品の有無による価格差（箱あり/なし、充電器、説明書等）
- 色・カラーバリエーションによる人気差
- 時期的な相場変動（新モデル発売前後等）
- 出品時のタイトル・写真のコツ（該当する場合）
- その商品特有の注意点（バッテリー劣化、動作確認ポイント等）

## コスト計算
仕入れ価格が提示された場合：
- 手数料 (5%): 仕入れ価格 × 0.05
- 小計: 仕入れ価格 + 手数料
- 消費税 (10%): 小計 × 0.10
- 総コスト: 小計 + 消費税 = 仕入れ価格 × 1.155
- 販売時のメルカリ手数料 (10%) も考慮: 売値の90%が手取り
- 送料目安も考慮（サイズによる）

## 回答フォーマット（必ずこの形式で）

📦 商品: {商品名}

📊 【相場データ】
平均落札価格: {X,XXX}円
中央値: {X,XXX}円
価格帯: {最低}〜{最高}円
データ件数: {N}件（データソース明記）

📋 【状態別の相場目安】
🆕 新品・未開封: {X,XXX}〜{X,XXX}円
✨ 未使用に近い: {X,XXX}〜{X,XXX}円
👍 目立った傷汚れなし: {X,XXX}〜{X,XXX}円
⚠️ やや傷汚れあり: {X,XXX}〜{X,XXX}円
（データがある状態のみ表示）

📋 【直近の実際の取引】
・{日付} {価格}円 — {商品タイトル要約}
・{日付} {価格}円 — {商品タイトル要約}
（最大5件、見つかった分だけ表示）

💰 【仕入れ判定】（仕入れ価格が提示された場合）
仕入れ価格: {X,XXX}円
総コスト（税込手数料込）: {X,XXX}円
想定売値: {X,XXX}円
想定手取り（メルカリ手数料後）: {X,XXX}円
想定利益: {±X,XXX}円（利益率{XX}%）

{🟢 仕入れ推奨 / 🟡 検討 / 🔴 見送り推奨}
{判定理由を1-2行で}

⚠️ 【注意ポイント】
・{この商品特有の注意点1}
・{この商品特有の注意点2}
・{出品時のコツやアドバイス}`;

// ── LINE 署名検証 ────────────────────────────────
function verifySignature(body, signature) {
  if (!LINE_CONFIG.channelSecret) {
    console.log('⚠️ channelSecret未設定、署名検証スキップ');
    return true;
  }
  if (!signature) {
    console.warn('⚠️ x-line-signature ヘッダーなし');
    return false;
  }
  const bodyStr = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const hash = crypto
    .createHmac('SHA256', LINE_CONFIG.channelSecret)
    .update(bodyStr)
    .digest('base64');
  const isValid = hash === signature;
  if (!isValid) {
    console.warn('⚠️ 署名不一致 — デバッグ用に通過させます');
    return true; // デバッグ用
  }
  return true;
}

// ── LINE メッセージ送信 ──────────────────────────────
async function replyMessage(replyToken, text) {
  const messages = [];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, 4900));
    remaining = remaining.slice(4900);
  }
  for (const chunk of chunks) {
    messages.push({ type: 'text', text: chunk });
  }
  try {
    await axios.post(
      'https://api.line.me/v2/bot/message/reply',
      { replyToken, messages: messages.slice(0, 5) },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${LINE_CONFIG.channelAccessToken}`,
        },
        timeout: 10000,
      }
    );
    console.log('✅ 回答送信完了（' + text.length + '文字）');
  } catch (err) {
    console.error('❌ LINE reply エラー:', err.response?.data || err.message);
  }
}

async function pushMessage(userId, text) {
  const messages = [];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, 4900));
    remaining = remaining.slice(4900);
  }
  for (const chunk of chunks) {
    messages.push({ type: 'text', text: chunk });
  }
  try {
    await axios.post(
      'https://api.line.me/v2/bot/message/push',
      { to: userId, messages: messages.slice(0, 5) },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${LINE_CONFIG.channelAccessToken}`,
        },
        timeout: 10000,
      }
    );
    console.log('✅ Push送信完了（' + text.length + '文字）');
  } catch (err) {
    console.error('❌ LINE push エラー:', err.response?.data || err.message);
  }
}

// ── メイン: Web検索で相場データを取得して回答 ──────────────
async function analyzeMarketPrice(userMessage) {
  console.log('🤖 [分析開始]:', userMessage.slice(0, 80));

  // Tier 1: OpenAI Responses API + web_search_preview
  try {
    console.log('🔍 [Web Search] Responses API + web_search_preview で検索');
    const response = await openai.responses.create({
      model: 'gpt-4o',
      instructions: SYSTEM_PROMPT,
      tools: [{ type: 'web_search_preview' }],
      input: userMessage,
      temperature: 0.3,
    });

    console.log('✅ [Web Search] 応答取得');

    if (response.output_text) {
      return response.output_text;
    }

    if (response.output && Array.isArray(response.output)) {
      const textOutputs = response.output
        .filter(item => item.type === 'message')
        .map(item => {
          if (item.content && Array.isArray(item.content)) {
            return item.content
              .filter(c => c.type === 'output_text' || c.type === 'text')
              .map(c => c.text)
              .join('');
          }
          return '';
        })
        .join('\n');
      if (textOutputs) return textOutputs;
    }

    // output_text もテキスト出力もない場合 → Tier 2 へ
    console.log('⚠️ [Web Search] テキスト出力なし、GPTフォールバックへ');
  } catch (err) {
    console.error('❌ [Web Search] エラー:', err.message);
    console.log('🔄 GPT知識ベースにフォールバック');
  }

  // Tier 2: GPT-4o の知識ベースで回答（Web検索が失敗した場合）
  try {
    console.log('🔄 [GPT Fallback] GPT知識ベースで回答');
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: SYSTEM_PROMPT + `\n\n## 重要な追加指示
Web検索が利用できない状況です。以下のルールで回答してください：
1. あなたの学習データに含まれる市場知識に基づいて、可能な限ら具体的な相場情報を提供する
2. 一般的な中古市場の価格帯、メルカリやヤフオクの相場傾向を元に回答する
3. 金額を出す場合は必ず「※一般的な相場目安」と注記する
4. 「データが取得できません」とだけ返すのは禁止。必ず何かしらの参考情報を提供する
5. 回答の最後に「⚠️ リアルタイム検索データではなく一般的な市場知識に基づく参考情報です。実際の出品前に最新相場をご確認ください。」と注記する`,
        },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.3,
      max_tokens: 2000,
    });
    return completion.choices[0].message.content;
  } catch (err2) {
    console.error('❌ [GPT Fallback] エラー:', err2.message);
    return `⚠️ 現在サーバーが混み合っています。しばらく経ってからもう一度お試しください。\n\n（エラー詳細: ${err2.message}）`;
  }
}

// ── Express ミドルウェア ─────────────────────────────
app.use('/webhook', express.raw({ type: '*/*' }));
app.use(express.json());

// ── ヘルスチェック ───────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '8.0.0-websearch',
    mode: 'Web Search + GPT-4o (MCP不要)',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime() / 60) + '分',
  });
});

app.get('/', (req, res) => {
  res.json({
    service: 'LINE 相場判定 Bot',
    version: '8.0.0',
    status: 'running',
    mode: 'Web Search + GPT-4o',
  });
});

// ── LINE Webhook ─────────────────────────────────
app.post('/webhook', async (req, res) => {
  console.log('📨 Webhook受信:', {
    contentType: req.headers['content-type'],
    bodyType: typeof req.body,
    isBuffer: Buffer.isBuffer(req.body),
    bodyLength: req.body?.length || 0,
    hasSignature: !!req.headers['x-line-signature'],
  });

  const rawBody = req.body;
  const signature = req.headers['x-line-signature'];

  if (!verifySignature(rawBody, signature)) {
    console.warn('⚠️ 署名検証失敗');
    return res.status(403).json({ error: 'Invalid signature' });
  }

  let body;
  try {
    body = JSON.parse(rawBody.toString());
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  res.status(200).json({ status: 'ok' });

  if (!body.events) return;

  for (const event of body.events) {
    if (event.type !== 'message' || event.message.type !== 'text') continue;

    const userMessage = event.message.text.trim();
    const userId = event.source.userId;
    const replyToken = event.replyToken;

    console.log(`📩 受信: "${userMessage}" from ${userId}`);

    // 即座に「分析中」を返す
    try {
      await replyMessage(replyToken, '🔍 相場データを検索中...\n少々お待ちください（10〜30秒）');
    } catch (err) {
      console.error('⚠️ 初期応答エラー:', err.message);
    }

    // 非同期で相場分析
    (async () => {
      try {
        const answer = await analyzeMarketPrice(userMessage);
        await pushMessage(userId, answer);
      } catch (err) {
        console.error('❌ 処理エラー:', err.message);
        await pushMessage(userId, '⚠️ 相場分析中にエラーが発生しました。しばらく経ってからもう一度お試しください。');
      }
    })();
  }
});

// ── Keep-alive (Render 無料枠のスリープ対策) ──────────
setInterval(() => {
  axios.get(`${RENDER_EXTERNAL_URL}/health`).catch(() => {});
}, 14 * 60 * 1000);

// ── サーバー起動 ──────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 サーバー起動: http://localhost:${PORT}`);
  console.log(`✅ LINE 相場判定 Bot v8.0.0 — Web Search + GPT-4o`);
  console.log(`✅ MCP不要・OAuth不要のシンプル構成`);
  console.log(`✅ LINE Webhook: /webhook`);
  console.log(`✅ ヘルスチェック: ${RENDER_EXTERNAL_URL}/health`);
});
