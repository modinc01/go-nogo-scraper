// ============================================================
// LINE 相場判定 Bot v6.0 — OpenAI Responses API + オークファン MCP サーバー
// ChatGPT の本番 MCP サーバーと同じデータソースを LINE から利用
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

// ── オークファン MCP サーバー設定 ──────────────────────
const AUCFAN_MCP_URL = process.env.AUCFAN_MCP_URL || 'https://mcp.aucfan.com/aucfan-api/mcp';
const AUCFAN_OAUTH_TOKEN = process.env.AUCFAN_OAUTH_TOKEN || '';
// ── システムプロンプト ──────────────────────────────
const SYSTEM_PROMPT = `あなたは日本のオークション・フリマ市場に精通した相場分析のプロフェッショナルです。
ユーザーから商品名（型番）と仕入れ価格が送られてきたら、aucfan_search_api ツールを使って正確な相場判定を行ってください。

## 分析手順
1. まず aucfan_search_api で商品を検索し、実際の落札データを取得する
2. データが少ない場合はキーワードを調整して再検索する
   - 例: 「iPhone 15 Pro 256GB」→「iPhone15Pro 256」でも試す
   - 型番がある場合は型番のみでも検索する
3. 検索時は period パラメータで直近6ヶ月を指定する

## 分析ルール
- **Yahoo!オークションの落札済みデータのみ**を相場の根拠にする
- 明らかに状態が異なるもの（ジャンク品、付属品なし等）は分けて考慮する
- 外れ値（相場から極端に外れた価格）は分析に含めるが注記する

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
データ件数: {N}件

📋 【直近の実際の取引】
・{日付} {価格}円 — {商品タイトル要約}
・{日付} {価格}円 — {商品タイトル要約}
・{日付} {価格}円 — {商品タイトル要約}
（最大5件表示）

💰 【仕入れ判定】（仕入れ価格が提示された場合）
仕入れ価格: {X,XXX}円
総コスト（税込手数料込）: {X,XXX}円
想定売値: {X,XXX}円
想定手取り（メルカリ手数料後）: {X,XXX}円
想定利益: {±X,XXX}円（利益率{XX}%）

{🟢 仕入れ推奨 / 🟡 検討 / 🔴 見送り推奨}
{判定理由を1-2行で}

## 重要な注意
- データが取得できなかった場合は正直に「相場データが不足しています」と伝える
- 推測で価格を出さない。必ずツールで取得したデータに基づく
- 金額は全てカンマ区切りで表示する
- LINEメッセージとして読みやすいよう、簡潔に整理する`;
// ── LINE 署名検証 ────────────────────────────────
function verifySignature(body, signature) {
  if (!LINE_CONFIG.channelSecret) return true;
  const hash = crypto
    .createHmac('SHA256', LINE_CONFIG.channelSecret)
    .update(body)
    .digest('base64');
  return hash === signature;
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
// ── OpenAI Responses API + MCP でオークファンに問い合わせ ──
async function askGPTwithMCP(userMessage) {
  console.log('🤖 [GPT+MCP] 処理開始:', userMessage.slice(0, 50));

  const mcpTool = {
    type: 'mcp',
    server_label: 'aucfan',
    server_url: AUCFAN_MCP_URL,
    require_approval: 'never',
  };

  if (AUCFAN_OAUTH_TOKEN) {
    mcpTool.headers = {
      Authorization: `Bearer ${AUCFAN_OAUTH_TOKEN}`,
    };
  }

  try {
    const response = await openai.responses.create({
      model: 'gpt-4o',
      instructions: SYSTEM_PROMPT,
      tools: [mcpTool],
      input: userMessage,
      temperature: 0.3,
    });

    console.log('✅ [GPT+MCP] 応答取得');

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

    return '申し訳ございません。回答を生成できませんでした。';
  } catch (err) {
    console.error('❌ [GPT+MCP] エラー:', err.message);
    console.error('❌ [GPT+MCP] 詳細:', JSON.stringify(err.error || err.response?.data || {}).slice(0, 500));

    if (err.message?.includes('responses') || err.status === 404) {
      console.log('⚠️ Responses API 未対応、Chat Completions にフォールバック');
      return await askGPTFallback(userMessage);
    }

    return `❌ エラーが発生しました: ${err.message}\n\nMCPサーバーへの接続に問題がある可能性があります。`;
  }
}
// ── フォールバック: Chat Completions API (MCP ツールを手動で呼ぶ) ──
async function askGPTFallback(userMessage) {
  console.log('🔄 [Fallback] Chat Completions API を使用');

  let aucfanData = null;
  try {
    aucfanData = await callAucfanMCPDirectly(userMessage);
  } catch (err) {
    console.error('❌ [MCP Direct] エラー:', err.message);
  }

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userMessage },
  ];

  if (aucfanData) {
    messages.push({
      role: 'system',
      content: `以下はオークファンMCPサーバーから取得した実際の落札データです。このデータに基づいて回答してください:\n\n${JSON.stringify(aucfanData, null, 2)}`,
    });
  }

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages,
      temperature: 0.3,
      max_tokens: 2000,
    });
    return completion.choices[0].message.content;
  } catch (err) {
    console.error('❌ [Fallback] エラー:', err.message);
    return `❌ エラーが発生しました: ${err.message}`;
  }
}

// ── MCP サーバーに直接接続してツールを呼び出す ──────────
async function callAucfanMCPDirectly(query) {
  console.log('🔌 [MCP Direct] aucfan_search_api 呼び出し:', query.slice(0, 50));

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (AUCFAN_OAUTH_TOKEN) {
    headers.Authorization = `Bearer ${AUCFAN_OAUTH_TOKEN}`;
  }

  const initResponse = await axios.post(
    AUCFAN_MCP_URL,
    {
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'line-aucfan-bot', version: '6.0.0' },
      },
      id: 1,
    },
    { headers, timeout: 15000 }
  );
  console.log('🔌 [MCP] Initialize:', JSON.stringify(initResponse.data).slice(0, 200));

  const searchResponse = await axios.post(
    AUCFAN_MCP_URL,
    {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'aucfan_search_api',
        arguments: { keyword: query },
      },
      id: 2,
    },
    { headers, timeout: 30000 }
  );
  console.log('🔌 [MCP] Search result:', JSON.stringify(searchResponse.data).slice(0, 500));

  return searchResponse.data?.result || searchResponse.data;
}
// ── Express ミドルウェア ─────────────────────────────
app.use('/webhook', express.raw({ type: '*/*' }));
app.use(express.json());

// ── ヘルスチェック ───────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '6.0.0-mcp',
    mcpServer: AUCFAN_MCP_URL,
    hasOAuthToken: !!AUCFAN_OAUTH_TOKEN,
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime() / 60) + '分',
  });
});

app.get('/', (req, res) => {
  res.json({
    service: 'LINE 相場判定 Bot (MCP版)',
    version: '6.0.0-mcp',
    status: 'running',
  });
});

// ── LINE Webhook ─────────────────────────────────
app.post('/webhook', async (req, res) => {
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

    try {
      await replyMessage(replyToken, '🔍 オークファンMCPサーバーで相場データを検索中...\n少々お待ちください（10〜30秒）');
    } catch (err) {
      console.error('⚠️ 初期応答エラー:', err.message);
    }

    (async () => {
      try {
        const answer = await askGPTwithMCP(userMessage);
        await pushMessage(userId, answer);
      } catch (err) {
        console.error('❌ 処理エラー:', err.message);
        await pushMessage(userId, '❌ 相場分析中にエラーが発生しました。しばらく経ってからもう一度お試しください。');
      }
    })();
  }
});

// ── Keep-alive (Render 無料枠のスリープ対策) ──────────
setInterval(() => {
  axios.get(`https://go-nogo-scraper.onrender.com/health`).catch(() => {});
}, 14 * 60 * 1000);

// ── サーバー起動 ─────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 サーバー起動: http://localhost:${PORT}`);
  console.log(`✅ OpenAI Responses API + MCP 相場分析エンジン`);
  console.log(`✅ MCP Server: ${AUCFAN_MCP_URL}`);
  console.log(`✅ OAuth Token: ${AUCFAN_OAUTH_TOKEN ? '設定済み' : '未設定'}`);
  console.log(`✅ LINE Webhook: /webhook`);
});
