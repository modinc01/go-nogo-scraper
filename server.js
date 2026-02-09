const express = require('express');
const OpenAI = require('openai');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;

// OpenAI設定
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// LINE設定
const LINE_CONFIG = {
          channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
          channelSecret: process.env.LINE_CHANNEL_SECRET,
};

// ユーザーごとの会話履歴（メモリ内）
const conversationHistory = new Map();
const MAX_HISTORY = 20;

// LINE署名検証
function validateSignature(body, signature) {
          const hash = crypto
            .createHmac('SHA256', LINE_CONFIG.channelSecret)
            .update(body)
            .digest('base64');
          return hash === signature;
}

// LINE APIでメッセージ送信
async function pushMessage(userId, text) {
          const res = await fetch('https://api.line.me/v2/bot/message/push', {
                      method: 'POST',
                      headers: {
                                    'Content-Type': 'application/json',
                                    'Authorization': 'Bearer ' + LINE_CONFIG.channelAccessToken,
                      },
                      body: JSON.stringify({
                                    to: userId,
                                    messages: [{ type: 'text', text: text }],
                      }),
          });
          if (!res.ok) {
                      console.error('LINE push error:', res.status, await res.text());
          }
}

// LINE APIでリプライ送信
async function replyMessage(replyToken, text) {
          const res = await fetch('https://api.line.me/v2/bot/message/reply', {
                      method: 'POST',
                      headers: {
                                    'Content-Type': 'application/json',
                                    'Authorization': 'Bearer ' + LINE_CONFIG.channelAccessToken,
                      },
                      body: JSON.stringify({
                                    replyToken: replyToken,
                                    messages: [{ type: 'text', text: text }],
                      }),
          });
          if (!res.ok) {
                      console.error('LINE reply error:', res.status, await res.text());
          }
}

// ChatGPTに質問を投げる
async function askChatGPT(userId, userMessage) {
          // 会話履歴を取得
  if (!conversationHistory.has(userId)) {
              conversationHistory.set(userId, []);
  }
          const history = conversationHistory.get(userId);

  // ユーザーメッセージを追加
  history.push({ role: 'user', content: userMessage });

  // 履歴が長すぎたら古いものを削除
  while (history.length > MAX_HISTORY) {
              history.shift();
  }

  const systemPrompt = `あなたはハイブランド中古品の相場・転売に詳しいプロアドバイザーです。

  ユーザーからブランド品の相場や仕入れ判定について質問が来ます。
  以下のルールで回答してください：

  1. 商品名・型番が送られたら、その商品の中古相場観を回答
  2. 「商品名 + 価格」が送られたら、仕入れ判定（GO/NO-GO）を回答
  3. 相場データがない場合は正直に「データが不十分」と伝える
  4. 回答はLINEメッセージとして読みやすい形式で、簡潔に（300文字以内目安）
  5. 絵文字を適度に使って親しみやすく

  回答フォーマット例（仕入れ判定時）：
  🟢 仕入れ推奨 / 🟡 検討 / 🔴 NG

  📊 商品: [商品名]
  💰 相場観: [相場レンジ]
  💵 提示価格: [ユーザー提示額]
  📈 判定理由: [簡潔な理由]
  💡 アドバイス: [一言]`;

  try {
              const completion = await openai.chat.completions.create({
                            model: 'gpt-4o-mini',
                            messages: [
                                    { role: 'system', content: systemPrompt },
                                            ...history,
                                          ],
                            max_tokens: 500,
                            temperature: 0.7,
              });

            const assistantMessage = completion.choices[0].message.content;

            // アシスタントの回答を履歴に追加
            history.push({ role: 'assistant', content: assistantMessage });

            return assistantMessage;
  } catch (error) {
              console.error('OpenAI API error:', error.message);
              return 'すみません、現在AIが応答できません。しばらくしてからもう一度お試しください。';
  }
}

// Webhookエンドポイント（LINE）
app.post('/webhook', express.raw({ type: '*/*' }), async (req, res) => {
          // 署名検証
           const signature = req.headers['x-line-signature'];
          if (!signature || !validateSignature(req.body, signature)) {
                      console.error('Invalid signature');
                      return res.status(401).send('Invalid signature');
          }

           const body = JSON.parse(req.body.toString());
          res.status(200).send('OK');

           // イベント処理
           for (const event of body.events) {
                       if (event.type !== 'message' || event.message.type !== 'text') continue;

            const userId = event.source.userId;
                       const userMessage = event.message.text;

            console.log('Received:', userMessage, 'from:', userId);

            // まずリプライで「考え中」を送信
            await replyMessage(event.replyToken, '🔍 AIが回答を作成中...');

            // ChatGPTに問い合わせ
            const answer = await askChatGPT(userId, userMessage);

            // 結果をpushで送信
            await pushMessage(userId, answer);
           }
});

// ヘルスチェック
app.get('/health', (req, res) => {
          res.json({
                      status: 'ok',
                      version: '4.0.0-lightweight',
                      timestamp: new Date().toISOString(),
                      features: ['line-bot', 'chatgpt', 'conversation-history'],
          });
});

app.get('/', (req, res) => {
          res.json({
                      message: 'ハイブランド相場Bot v4.0 - LINE x ChatGPT',
                      status: 'running',
          });
});

app.listen(PORT, () => {
          console.log('Server running on port ' + PORT);
          console.log('v4.0 Lightweight - LINE x ChatGPT');
});
