require('dotenv').config();
const express = require('express');

// LINE Bot関連の設定（存在する場合のみ）
let line, client;
try {
  line = require('@line/bot-sdk');
  const config = {
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.LINE_CHANNEL_SECRET,
  };
  client = new line.Client(config);
} catch (e) {
  console.log('LINE SDK not found, running without LINE Bot functionality');
}

const app = express();
const PORT = process.env.PORT || 3000;

// スクレイピング機能をインライン実装（既存のscrape.jsが見つからない場合）
const axios = require('axios');
const cheerio = require('cheerio');

// HTTPクライアントの設定
const httpClient = axios.create({
  timeout: 30000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'ja,en-US;q=0.7,en;q=0.3',
    'Accept-Encoding': 'gzip, deflate, br',
    'DNT': '1',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1'
  }
});

/**
 * 価格文字列から数値を抽出
 */
function extractPrice(priceText) {
  if (!priceText) return 0;
  const numStr = priceText.replace(/[^\d,]/g, '').replace(/,/g, '');
  const price = parseInt(numStr);
  return isNaN(price) ? 0 : price;
}

/**
 * 文字エンコーディングを適切に処理
 */
function decodeResponse(buffer) {
  try {
    // UTF-8で試す
    const utf8Text = buffer.toString('utf8');
    if (!utf8Text.includes('�')) {
      return utf8Text;
    }
  } catch (e) {
    // エラーの場合は続行
  }

  // iconv-liteが利用可能な場合はShift_JISを試す
  try {
    const iconv = require('iconv-lite');
    return iconv.decode(buffer, 'shift_jis');
  } catch (e) {
    // iconv-liteが無い場合はUTF-8で強制変換
    return buffer.toString('utf8');
  }
}

/**
 * オークファンから相場情報を取得
 */
async function scrapeAucfan(query) {
  try {
    console.log(`🔍 検索開始: ${query}`);
    
    // クエリをURLエンコード
    const encodedQuery = encodeURIComponent(query);
    const aucfanURL = `https://aucfan.com/search1/q-${encodedQuery}/`;
    
    console.log(`📍 URL: ${aucfanURL}`);
    
    // HTTPリクエストを送信
    const response = await httpClient.get(aucfanURL, {
      responseType: 'arraybuffer'
    });
    
    if (response.status !== 200) {
      throw new Error(`HTTPエラー: ${response.status}`);
    }
    
    // レスポンスを適切にデコード
    const buffer = Buffer.from(response.data);
    const html = decodeResponse(buffer);
    
    // Cheerioでパース
    const $ = cheerio.load(html);
    
    const results = [];
    
    // オークファンの商品アイテムを取得（複数のセレクタパターンを試行）
    const selectors = [
      '.product-item',
      '.item',
      '.result-item', 
      '.l-product-list-item',
      'tr',
      '.row',
      '.list-item'
    ];
    
    for (const selector of selectors) {
      $(selector).each((index, element) => {
        if (results.length >= 20) return false; // 最大20件まで
        
        const $item = $(element);
        
        // タイトル取得
        let title = $item.find('h3, .title, .product-title, .l-product-list-item__title, td a, .title a, h3 a').text().trim();
        if (!title) {
          title = $item.find('a').first().text().trim();
        }
        
        // 価格取得
        const priceText = $item.find('.price, .product-price, .current-price, .l-product-list-item__price, td:contains("円")').text();
        const price = extractPrice(priceText);
        
        // 日付取得
        const date = $item.find('.date, .end-date, .l-product-list-item__date').text().trim();
        
        // URL取得
        let linkURL = $item.find('a').first().attr('href');
        if (linkURL && !linkURL.startsWith('http')) {
          linkURL = 'https://aucfan.com' + linkURL;
        }
        
        if (title && title.length > 3 && price > 0) {
          results.push({
            title,
            price,
            date,
            url: linkURL || '',
            imageURL: ''
          });
        }
      });
      
      if (results.length > 0) break; // 結果が見つかったらループを抜ける
    }
    
    console.log(`✅ 取得件数: ${results.length}件`);
    
    // 統計情報を計算
    let avgPrice = 0;
    let maxPrice = 0;
    let minPrice = 0;
    
    if (results.length > 0) {
      const prices = results.map(r => r.price);
      const total = prices.reduce((sum, price) => sum + price, 0);
      avgPrice = Math.round(total / prices.length);
      maxPrice = Math.max(...prices);
      minPrice = Math.min(...prices);
    }
    
    return {
      query,
      results,
      count: results.length,
      avgPrice,
      maxPrice,
      minPrice
    };
    
  } catch (error) {
    console.error('❌ スクレイピングエラー:', error.message);
    throw new Error(`オークファンの相場取得に失敗しました: ${error.message}`);
  }
}

/**
 * 仕入れ判定を行う
 */
function evaluatePurchase(currentPrice, avgPrice) {
  if (avgPrice === 0) {
    return "相場データが不足しています";
  }
  
  const priceRatio = currentPrice / avgPrice;
  
  if (priceRatio <= 0.6) {
    return "🟢 仕入れ推奨: 相場より大幅に安い（40%以上安い）";
  } else if (priceRatio <= 0.8) {
    return "🟡 仕入れ検討: 相場よりやや安い（20%以上安い）";
  } else if (priceRatio <= 1.1) {
    return "🟠 慎重検討: 相場付近（±10%以内）";
  } else {
    return "🔴 仕入れ非推奨: 相場より高い";
  }
}

/**
 * メイン処理関数
 */
async function processQuery(modelNumber, currentPrice) {
  try {
    // 1秒待機
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // オークファンから相場を取得
    const result = await scrapeAucfan(modelNumber);
    
    // 仕入れ判定を追加
    const recommendation = evaluatePurchase(currentPrice, result.avgPrice);
    
    // 利益率計算
    let profitRate = 0;
    if (result.avgPrice > 0) {
      profitRate = ((result.avgPrice - currentPrice) / currentPrice) * 100;
    }
    
    return {
      ...result,
      currentPrice,
      recommendation,
      profitRate: Math.round(profitRate * 10) / 10
    };
    
  } catch (error) {
    console.error('❌ 処理エラー:', error);
    throw error;
  }
}

// Express設定
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// API エンドポイント
app.post('/api/search', async (req, res) => {
  try {
    const { modelNumber, currentPrice } = req.body;
    
    if (!modelNumber || !currentPrice) {
      return res.status(400).json({
        error: '型番と現在価格を指定してください',
        example: { modelNumber: 'iPhone 13 Pro', currentPrice: 80000 }
      });
    }
    
    const result = await processQuery(modelNumber, parseInt(currentPrice));
    res.json(result);
    
  } catch (error) {
    console.error('API エラー:', error);
    res.status(500).json({
      error: error.message
    });
  }
});

// LINE Bot機能（LINE SDKが利用可能な場合のみ）
if (line && client) {
  /**
   * メッセージから型番と価格を抽出
   */
  function parseMessage(message) {
    const lines = message.trim().split('\n').map(line => line.trim());
    
    let modelNumber = '';
    let price = 0;
    
    // パターン1: 「型番：」「価格：」形式
    for (const line of lines) {
      const priceMatch = line.match(/(価格|現在価格|落札価格|入札価格)[:：]\s*([0-9,]+)/i);
      if (priceMatch) {
        const priceStr = priceMatch[2].replace(/,/g, '');
        const parsedPrice = parseInt(priceStr);
        if (!isNaN(parsedPrice)) {
          price = parsedPrice;
        }
      }
      
      const modelMatch = line.match(/(型番|商品|品名|商品名)[:：]\s*(.+)/i);
      if (modelMatch) {
        modelNumber = modelMatch[2].trim();
      }
    }
    
    // パターン2: シンプル形式
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
    
    if (result.profitRate !== 0) {
      const sign = result.profitRate > 0 ? '+' : '';
      message += `💡 期待利益率: ${sign}${result.profitRate}%\n\n`;
    }
    
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
   */
  async function handleTextMessage(event) {
    const messageText = event.message.text;
    const userId = event.source.userId;
    
    try {
      await client.replyMessage(event.replyToken, {
        type: 'text',
        text: '🔍 相場を検索中です...\nしばらくお待ちください。'
      });
      
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
      
      const result = await processQuery(parseResult.modelNumber, parseResult.price);
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
   */
  async function handleEvent(event) {
    if (event.type !== 'message' || event.message.type !== 'text') {
      return Promise.resolve(null);
    }
    
    return handleTextMessage(event);
  }

  // LINE Webhook
  app.use('/webhook', line.middleware({
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.LINE_CHANNEL_SECRET,
  }));

  app.post('/webhook', (req, res) => {
    Promise
      .all(req.body.events.map(handleEvent))
      .then((result) => res.json(result))
      .catch((err) => {
        console.error('❌ Webhook処理エラー:', err);
        res.status(500).end();
      });
  });
}

// ヘルスチェック
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    lineBot: !!client
  });
});

// ルートパス
app.get('/', (req, res) => {
  res.json({ 
    message: 'オークファン相場検索API',
    status: 'running',
    endpoints: [
      'POST /api/search - 相場検索API',
      'POST /webhook - LINE Bot webhook (if enabled)',
      'GET /health - ヘルスチェック'
    ],
    usage: {
      api: {
        url: '/api/search',
        method: 'POST',
        body: {
          modelNumber: 'iPhone 13 Pro',
          currentPrice: 80000
        }
      }
    }
  });
});

// サーバー起動
app.listen(PORT, () => {
  console.log(`🚀 サーバーが起動しました: http://localhost:${PORT}`);
  console.log(`📱 API URL: https://your-domain.com/api/search`);
  
  if (client) {
    console.log(`📱 LINE Bot Webhook URL: https://your-domain.com/webhook`);
  } else {
    console.log('📱 LINE Bot機能は無効です（LINE SDKが見つかりません）');
  }
  
  // 環境変数チェック
  if (client) {
    if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) {
      console.warn('⚠️  LINE_CHANNEL_ACCESS_TOKEN が設定されていません');
    }
    if (!process.env.LINE_CHANNEL_SECRET) {
      console.warn('⚠️  LINE_CHANNEL_SECRET が設定されていません');
    }
  }
});
