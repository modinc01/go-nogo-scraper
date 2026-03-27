// ============================================================
// LINE 相場判定 Bot — OpenAI GPT-4o 橋渡し版
// ChatGPT MCP サーバーと同等の分析精度を LINE から利用可能にする
// ============================================================
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const { OpenAI } = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

// ── クライアント初期化 ──
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const LINE_CONFIG = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const http = axios.create({
  timeout: 20000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept-Language': 'ja,en-US;q=0.7,en;q=0.3',
  },
});

// ── LINE 署名検証 ──
function verifySignature(body, signature) {
  const hash = crypto
    .createHmac('SHA256', LINE_CONFIG.channelSecret)
    .update(body)
    .digest('base64');
  return hash === signature;
}

// ── LINE 返信ヘルパー ──
async function lineReply(replyToken, text) {
  await axios.post(
    'https://api.line.me/v2/bot/message/reply',
    { replyToken, messages: [{ type: 'text', text }] },
    { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LINE_CONFIG.channelAccessToken}` } }
  );
}

async function linePush(userId, text) {
  await axios.post(
    'https://api.line.me/v2/bot/message/push',
    { to: userId, messages: [{ type: 'text', text }] },
    { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LINE_CONFIG.channelAccessToken}` } }
  );
}

// ================================================================
// ツール①: オークファン検索（落札相場）
// ================================================================
async function searchAucfan(query) {
  console.log(`🔍 [aucfan] 検索: ${query}`);
  try {
    const url = `https://aucfan.com/search1/q-${encodeURIComponent(query)}/s-ya,m/`;
    const res = await http.get(url, { responseType: 'arraybuffer', maxRedirects: 5 });
    const buf = Buffer.from(res.data);
    let html = buf.toString('utf8');
    if (html.includes('\ufffd')) {
      try { html = iconv.decode(buf, 'shift_jis'); } catch (_) {}
    }
    const $ = cheerio.load(html);
    const items = [];

    // パターン A: テーブル行
    $('table tr').each((_, row) => {
      const $r = $(row);
      const text = $r.text();
      if (!text.includes('円')) return;
      let platform = '';
      if (text.includes('メルカリ') && !text.includes('メルカリShops')) platform = 'メルカリ';
      else if (text.includes('ヤフオク') || text.includes('Yahoo!オークション')) platform = 'ヤフオク';
      else return;
      const pm = text.match(/(\d{1,3}(?:,\d{3})+|\d{4,})円/);
      if (!pm) return;
      const price = parseInt(pm[1].replace(/,/g, ''));
      if (price < 500 || price > 50000000) return;
      let title = $r.find('a').first().text().trim();
      if (!title || title.length < 5) {
        $r.find('td').each((_, td) => {
          const t = $(td).text().trim();
          if (t.length > 10 && t.length < 200 && !t.match(/^\d/) && !t.includes('円')) { title = t; return false; }
        });
      }
      const dm = text.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
      const date = dm ? `${dm[1]}/${dm[2]}/${dm[3]}` : '';
      if (title) items.push({ title: title.slice(0, 120), price, date, platform });
    });

    // パターン B: div ベース
    if (items.length === 0) {
      $('div, li, article').each((_, el) => {
        if (items.length >= 60) return false;
        const $el = $(el);
        const text = $el.text();
        if (!text.includes('円')) return;
        let platform = '';
        if (text.includes('メルカリ') && !text.includes('メルカリShops')) platform = 'メルカリ';
        else if (text.includes('ヤフオク') || text.includes('Yahoo')) platform = 'ヤフオク';
        else return;
        const pm = text.match(/(\d{1,3}(?:,\d{3})+|\d{4,})円/);
        if (!pm) return;
        const price = parseInt(pm[1].replace(/,/g, ''));
        if (price < 500 || price > 50000000) return;
        let title = $el.find('a').first().text().trim();
        if (!title || title.length < 5) title = text.slice(0, 100).trim();
        const dm = text.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
        const date = dm ? `${dm[1]}/${dm[2]}/${dm[3]}` : '';
        if (!items.find(i => i.title === title && i.price === price)) {
          items.push({ title: title.slice(0, 120), price, date, platform });
        }
      });
    }

    // 統計計算
    if (items.length === 0) {
      return JSON.stringify({ query, count: 0, items: [], stats: null, message: '該当データなし。別のキーワードで再検索してください。' });
    }
    const prices = items.map(i => i.price).sort((a, b) => a - b);
    const q1 = prices[Math.floor(prices.length * 0.25)];
    const q3 = prices[Math.floor(prices.length * 0.75)];
    const iqr = q3 - q1;
    const lower = Math.max(500, q1 - iqr * 1.5);
    const upper = q3 + iqr * 1.5;
    const filtered = items.filter(i => i.price >= lower && i.price <= upper);
    const final = filtered.length >= 3 ? filtered : items;
    const fp = final.map(i => i.price);
    const avg = Math.round(fp.reduce((s, p) => s + p, 0) / fp.length);
    const median = fp.sort((a, b) => a - b)[Math.floor(fp.length / 2)];
    const min = Math.min(...fp);
    const max = Math.max(...fp);
    return JSON.stringify({ query, count: final.length, stats: { avg, median, min, max }, items: final.slice(0, 20).map(i => ({ title: i.title, price: i.price, date: i.date, platform: i.platform })) });
  } catch (err) {
    console.error('❌ [aucfan] エラー:', err.message);
    return JSON.stringify({ query, count: 0, items: [], stats: null, error: err.message });
  }
}

// ================================================================
// ツール②: Web 検索（メルカリ・ヤフオク 落札相場）
// ================================================================
async function searchWebPrices(query) {
  console.log(`🔍 [web] 検索: ${query}`);
  try {
    const searchQuery = `${query} 落札価格 OR 売り切れ site:mercari.com OR site:auctions.yahoo.co.jp`;
    const url = `https://www.google.com/search?q=${encodeURIComponent(searchQuery)}&num=15&hl=ja`;
    const res = await http.get(url, { responseType: 'text' });
    const $ = cheerio.load(res.data);
    const results = [];
    $('div.g, div[data-hveid]').each((_, el) => {
      if (results.length >= 15) return false;
      const $el = $(el);
      const title = $el.find('h3').first().text().trim();
      const snippet = $el.find('span, .VwiC3b').text().trim();
      const link = $el.find('a').first().attr('href') || '';
      if (title) results.push({ title, snippet: snippet.slice(0, 200), link });
    });
    return JSON.stringify({ query, count: results.length, results });
  } catch (err) {
    console.error('❌ [web] エラー:', err.message);
    return JSON.stringify({ query, count: 0, results: [], error: err.message });
  }
}

// ================================================================
// ツール③: オークファン統計ページ
// ================================================================
async function searchAucfanStats(query) {
  console.log(`🔍 [aucfan-stats] 検索: ${query}`);
  try {
    const url = `https://aucfan.com/search1/q-${encodeURIComponent(query)}/s-ya,m/`;
    const res = await http.get(url, { responseType: 'arraybuffer', maxRedirects: 5 });
    const buf = Buffer.from(res.data);
    let html = buf.toString('utf8');
    if (html.includes('\ufffd')) {
      try { html = iconv.decode(buf, 'shift_jis'); } catch (_) {}
    }
    const $ = cheerio.load(html);
    const pageText = $('body').text();
    const avgMatch = pageText.match(/平均[価落]?[格札]?[：:]\s*([\d,]+)/);
    const countMatch = pageText.match(/(\d+)\s*件/);
    const maxMatch = pageText.match(/最高[価落]?[格札]?[：:]\s*([\d,]+)/);
    const minMatch = pageText.match(/最低[価落]?[格札]?[：:]\s*([\d,]+)/);
    return JSON.stringify({
      query,
      pageStats: {
        avg: avgMatch ? parseInt(avgMatch[1].replace(/,/g, '')) : null,
        count: countMatch ? parseInt(countMatch[1]) : null,
        max: maxMatch ? parseInt(maxMatch[1].replace(/,/g, '')) : null,
        min: minMatch ? parseInt(minMatch[1].replace(/,/g, '')) : null,
      },
      rawTextSample: pageText.slice(0, 3000),
    });
  } catch (err) {
    console.error('❌ [aucfan-stats] エラー:', err.message);
    return JSON.stringify({ query, pageStats: {}, error: err.message });
  }
}

// ================================================================
// OpenAI Function Calling 定義
// ================================================================
const TOOLS = [
  { type: 'function', function: { name: 'search_aucfan', description: 'オークファンで過去の落札データ（メルカリ・ヤフオク）を検索し、実際の取引価格一覧と統計を返す。商品名・型番で検索可能。', parameters: { type: 'object', properties: { query: { type: 'string', description: '検索キーワード（商品名、型番など）' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'search_web_prices', description: 'Google検索でメルカリ・ヤフオクの落札価格・売り切れ価格を調べる。オークファンで見つからない場合の補完に使う。', parameters: { type: 'object', properties: { query: { type: 'string', description: '検索キーワード' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'search_aucfan_stats', description: 'オークファンの検索結果ページから統計情報（平均価格、件数など）とページテキストを抽出する。詳細な相場データが欲しい時に使う。', parameters: { type: 'object', properties: { query: { type: 'string', description: '検索キーワード' } }, required: ['query'] } } },
];

// ================================================================
// GPT システムプロンプト
// ================================================================
const SYSTEM_PROMPT = `あなたは日本のオークション・フリマ市場に精通した相場分析のプロフェッショナルです。
ユーザーから商品名（型番）と仕入れ価格が送られてきたら、以下の手順で正確な相場判定を行ってください。

## 分析手順
1. まず search_aucfan で商品を検索し、実際の落札データを取得する
2. データが少ない場合（5件未満）は search_aucfan_stats でページ統計も取得する
3. さらに不足なら search_web_prices でWeb検索も行い補完する
4. 検索キーワードが広すぎる/狭すぎる場合は、キーワードを調整して再検索する

## 分析ルール
- メルカリとヤフオクの落札済み（売り切れ）データのみを相場の根拠にする
- メルカリShops、Yahoo!ショッピング、Amazon等の小売価格は除外する
- 直近6ヶ月〜1年のデータを重視する
- 明らかに状態が異なるもの（ジャンク品、付属品なし等）は分けて考慮する

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
データ件数: {N}件（メルカリ{n1}件/ヤフオク{n2}件）

📋 【直近の実際の取引】
・{日付} {プラットフォーム} {価格}円 — {商品タイトル要約}
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

// ================================================================
// GPT 呼び出し（Function Calling ループ）
// ================================================================
async function askGPT(userMessage) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userMessage },
  ];
  const toolMap = {
    search_aucfan: searchAucfan,
    search_web_prices: searchWebPrices,
    search_aucfan_stats: searchAucfanStats,
  };
  for (let i = 0; i < 5; i++) {
    console.log(`🤖 [GPT] ループ ${i + 1} — メッセージ数: ${messages.length}`);
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
      temperature: 0.3,
      max_tokens: 2000,
    });
    const choice = completion.choices[0];
    if (choice.finish_reason === 'stop' || !choice.message.tool_calls?.length) {
      console.log('✅ [GPT] 最終回答を取得');
      return choice.message.content || '分析結果を取得できませんでした。';
    }
    messages.push(choice.message);
    for (const toolCall of choice.message.tool_calls) {
      const fn = toolMap[toolCall.function.name];
      if (!fn) {
        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ error: '不明なツール' }) });
        continue;
      }
      const args = JSON.parse(toolCall.function.arguments);
      console.log(`🔧 [GPT] ツール呼び出し: ${toolCall.function.name}(${JSON.stringify(args)})`);
      try {
        const result = await fn(args.query);
        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result });
      } catch (err) {
        console.error(`❌ [GPT] ツールエラー: ${err.message}`);
        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ error: err.message }) });
      }
    }
  }
  return '分析が完了しませんでした。もう一度お試しください。';
}

// ================================================================
// Webhook ハンドラ
// ================================================================
app.post('/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  const signature = req.headers['x-line-signature'];
  if (!verifySignature(req.body, signature)) {
    console.warn('⚠️ 署名検証失敗');
    return res.status(401).send('Invalid signature');
  }
  const body = JSON.parse(req.body.toString());
  res.status(200).send('OK');
  for (const event of body.events || []) {
    if (event.type !== 'message' || event.message.type !== 'text') continue;
    const userId = event.source.userId;
    const text = event.message.text.trim();
    console.log(`📩 受信: "${text}" from ${userId}`);
    try {
      await lineReply(event.replyToken, '🔍 相場を分析中です...\n（GPTが実際の落札データを取得・分析しています。30〜60秒お待ちください）');
    } catch (err) {
      console.error('⚠️ 処理中メッセージ送信失敗:', err.message);
    }
    (async () => {
      try {
        const answer = await askGPT(text);
        const trimmed = answer.length > 4900 ? answer.slice(0, 4900) + '\n...(続きは省略)' : answer;
        await linePush(userId, trimmed);
        console.log(`✅ 回答送信完了 (${trimmed.length}文字)`);
      } catch (err) {
        console.error('❌ GPT分析エラー:', err);
        try {
          await linePush(userId, '❌ 分析中にエラーが発生しました。\n\n💡 以下をお試しください:\n・型番を英数字で入力\n・商品名を短くする\n・しばらく待って再送信');
        } catch (_) {}
      }
    })();
  }
});

// ================================================================
// API エンドポイント（直接テスト用）
// ================================================================
app.use('/api/search', express.json());
app.post('/api/search', async (req, res) => {
  try {
    const { query, price } = req.body;
    if (!query) return res.status(400).json({ error: 'query パラメータが必要です' });
    let message = query;
    if (price) message += `\n仕入れ価格: ${price}円`;
    const answer = await askGPT(message);
    res.json({ query, price, answer });
  } catch (err) {
    console.error('❌ API エラー:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_, res) => {
  res.json({ status: 'ok', version: '5.0.0-gpt-fc', timestamp: new Date().toISOString(), uptime: `${Math.floor(process.uptime() / 60)}分` });
});

app.get('/', (_, res) => {
  res.json({ message: 'LINE 相場判定 Bot v5.0 (GPT-4o + Function Calling)', status: 'running' });
});

let keepAliveInterval;
function initKeepAlive() {
  const appUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  keepAliveInterval = setInterval(async () => {
    try { await axios.get(`${appUrl}/health`, { timeout: 5000 }); } catch (_) {}
  }, 5 * 60 * 1000);
}

app.listen(PORT, () => {
  console.log(`🚀 サーバー起動: http://localhost:${PORT}`);
  console.log('✅ GPT-4o + Function Calling 相場分析エンジン');
  console.log('✅ オークファン落札データ取得');
  console.log('✅ Web検索フォールバック');
  console.log('✅ メルカリ/ヤフオク限定分析');
  initKeepAlive();
});
