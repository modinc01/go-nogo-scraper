require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const { processQuery } = require('./scrape');

const app = express();
const PORT = process.env.PORT || 3000;

// LINE Bot設定
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

// LINE Clientを作成
const client = new line.Client(config);

/**
 * メッセージから型番と価格を抽出
 * @param {string} message メッセージテキスト
 * @returns {Object} {modelNumber, price, error}
 */
function parseMessage(message) {
  const lines = message.trim().split('\n').map(line => line.trim());
  
  let modelNumber = '';
  let price = 0;
  
  // パターン1: 「型番：」「価格：」形式
  for (const line of lines) {
    // 価格を抽出
    const priceMatch = line.match(/(価格|現在価格|落札価格|入札価格)[:：]\s*([0-9,]+)/i);
    if (priceMatch) {
      const priceStr = priceMatch[2].replace(/,/g, '');
      const parsedPrice = parseInt(priceStr);
      if (!isNaN(parsedPrice)) {
        price = parsedPrice;
      }
    }
    
    // 型番を抽出
    const modelMatch = line.match(/(型番|商品|品名|商品名)[:：]\s*(.+)/i);
    if (modelMatch) {
      modelNumber = modelMatch[2].trim();
    }
  }
  
  // パターン2: シンプル形式（1行目が型番、2行目が価格）
  if (!modelNumber && lines.length >= 1) {
    modelNumber = lines[0];
  }
  
  if (price === 0 && lines.length >= 2) {
    const priceMatch = lines[1].match(/([0-9,]+)/);
    if (priceMatch) {
      const priceStr = priceMatch[1].replace(/,/g, '');
      const parsedPrice = parseInt(priceStr);
      if (!isNaN(parsedPrice)) {
        price = parsedPrice;
      }
    }
  }
  
  // エラーチェック
  if (!modelNumber) {
    return { error: '型番が見つかりません' };
  }
  
  if (price === 0) {
    return { error: '価格が見つかりません' };
  }
  
  return { modelNumber, price };
}

/**
 * 結果メッセージをフォーマット
 * @param {Object} result 処理結果
 * @returns {string} フォーマットされたメッセージ
 */
function formatResultMessage(result) {
  if (result.count === 0) {
    return `「${result.query}」の相場情報が見つかりませんでした。\n型番を確認してもう一度お試しください。`;
  }
  
  let message = `📊 【${result.query}】相場分析結果\n\n`;
  message += `🔍 検索結果: ${result.count}件\n`;
  message += `💰 平均相場: ${result.avgPrice.toLocaleString()}円\n`;
  message += `📈 最高価格: ${result.maxPrice.toLocaleString()}円\n`;
  message += `📉 最低価格: ${result.minPrice.toLocaleString()}円\n`;
  message += `💵 現在価格: ${result.currentPrice.toLocaleString()}円\n\n`;
  
  message += `📋 判定結果:\n${result.recommendation}\n\n`;
  
  // 利益率表示
  if (result.profitRate !== 0) {
    const sign = result.profitRate > 0 ? '+' : '';
    message += `💡 期待利益率: ${sign}${result.profitRate}%\n\n`;
  }
  
  // 最新の取引例
  if (result.results.length > 0) {
    message += '📋 最近の取引例:\n';
    const maxDisplay = Math.min(3, result.results.length);
    
    for (let i = 0; i < maxDisplay; i++) {
      const auction = result.results[i];
      let shortTitle = auction.title;
      if (shortTitle.length > 30) {
        shortTitle = shortTitle.substring(0, 30) + '...';
      }
      message += `• ${shortTitle}\n  ${auction.price.toLocaleString()}円`;
      if (auction.date) {
        message += ` (${auction.date})`;
      }
      message += '\n';
    }
  }
  
  message += '\n💡 使用方法:\n型番と価格を入力してください\n例:\niPhone 13 Pro\n80000';
  
  return message;
}

/**
 * テキストメッセージを処理
 * @param {Object} event LINEイベント
 */
async function handleTextMessage(event) {
  const messageText = event.message.text;
  const userId = event.source.userId;
  
  try {
    // "検索中..." メッセージを送信
    await client.replyMessage(event.replyToken, {
      type: 'text',
      text: '🔍 相場を検索中です...\nしばらくお待ちください。'
    });
    
    // メッセージから型番と価格を抽出
    const parseResult = parseMessage(messageText);
    
    if (parseResult.error) {
      const errorMsg = `❌ ${parseResult.error}\n\n💡 正しい形式で入力してください:\n\n例1:\niPhone 13 Pro\n80000\n\n例2:\n型番: iPhone 13 Pro\n価格: 80000`;
      await client.pushMessage(userId, {
        type: 'text',
        text: errorMsg
      });
      return;
    }
    
    console.log(`🔍 検索開始: ${parseResult.modelNumber}, ${parseResult.price}円`);
    
    // 相場情報を取得
    const result = await processQuery(parseResult.modelNumber, parseResult.price);
    
    // 結果メッセージを作成・送信
    const resultMessage = formatResultMessage(result);
    
    await client.pushMessage(userId, {
      type: 'text',
      text: resultMessage
    });
    
    console.log(`✅ 検索完了: ${parseResult.modelNumber}`);
    
  } catch (error) {
    console.error('❌ メッセージ処理エラー:', error);
    
    const errorMsg = `❌ 相場情報の取得に失敗しました:\n${error.message}\n\n時間をおいて再度お試しください。`;
    
    try {
      await client.pushMessage(userId, {
        type: 'text',
        text: errorMsg
      });
    } catch (pushError) {
      console.error('❌ エラーメッセージ送信失敗:', pushError);
    }
  }
}

/**
 * LINEイベントを処理
 * @param {Object} event LINEイベント
 */
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }
  
  return handleTextMessage(event);
}

// ミドルウェア設定
app.use('/webhook', line.middleware(config));

// Webhook エンドポイント
app.post('/webhook', (req, res) => {
  Promise
    .all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error('❌ Webhook処理エラー:', err);
      res.status(500).end();
    });
});

// ヘルスチェック
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// ルートパス
app.get('/', (req, res) => {
  res.json({ 
    message: 'オークファン相場検索LINE Bot',
    status: 'running',
    endpoints: [
      'POST /webhook - LINE Bot webhook',
      'GET /health - ヘルスチェック'
    ]
  });
});

// サーバー起動
app.listen(PORT, () => {
  console.log(`🚀 サーバーが起動しました: http://localhost:${PORT}`);
  console.log(`📱 Webhook URL: https://your-domain.com/webhook`);
  
  // 環境変数チェック
  if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) {
    console.warn('⚠️  LINE_CHANNEL_ACCESS_TOKEN が設定されていません');
  }
  if (!process.env.LINE_CHANNEL_SECRET) {
    console.warn('⚠️  LINE_CHANNEL_SECRET が設定されていません');
  }
});
