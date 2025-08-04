require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

// LINE Bot関連の設定（環境変数が設定されている場合のみ）
let line, client;
const hasLineConfig = process.env.LINE_CHANNEL_SECRET && process.env.LINE_CHANNEL_ACCESS_TOKEN;

if (hasLineConfig) {
  try {
    line = require('@line/bot-sdk');
    const config = {
      channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
      channelSecret: process.env.LINE_CHANNEL_SECRET,
    };
    client = new line.Client(config);
    console.log('✅ LINE Bot機能が有効です');
  } catch (e) {
    console.log('⚠️ LINE SDK not found, running without LINE Bot functionality');
  }
} else {
  console.log('⚠️ LINE環境変数が設定されていません。API専用モードで起動します。');
}

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
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Cache-Control': 'max-age=0'
  }
});

/**
 * 価格文字列から数値を抽出
 */
function extractPrice(priceText) {
  if (!priceText) return 0;
  
  // 「円」や「,」「￥」などを除去して数字のみ抽出
  const numStr = priceText.replace(/[^\d]/g, '');
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
 * 異常値（新品等）を除外するフィルター
 */
function filterOutliers(prices) {
  if (prices.length < 3) return prices;
  
  // 価格を昇順でソート
  const sortedPrices = [...prices].sort((a, b) => a - b);
  
  // Q1, Q3を計算（四分位数）
  const q1Index = Math.floor(sortedPrices.length * 0.25);
  const q3Index = Math.floor(sortedPrices.length * 0.75);
  const q1 = sortedPrices[q1Index];
  const q3 = sortedPrices[q3Index];
  const iqr = q3 - q1;
  
  // 外れ値の閾値を設定（標準的なIQR法より緩く設定）
  const lowerBound = q1 - (iqr * 2.0);
  const upperBound = q3 + (iqr * 2.0);
  
  // 外れ値を除外
  const filteredPrices = sortedPrices.filter(price => 
    price >= lowerBound && price <= upperBound
  );
  
  console.log(`💡 価格フィルタリング: ${prices.length}件 → ${filteredPrices.length}件（外れ値${prices.length - filteredPrices.length}件除外）`);
  
  return filteredPrices.length > 0 ? filteredPrices : prices;
}

/**
 * オークファンから相場情報を取得（改良版）
 */
async function scrapeAucfan(query) {
  try {
    console.log(`🔍 検索開始: ${query}`);
    
    // 日本語文字の場合は追加でエンコーディング処理
    let encodedQuery;
    if (/[ひらがなカタカナ漢字]/.test(query)) {
      // 日本語が含まれる場合、より安全なエンコーディング
      encodedQuery = encodeURIComponent(query)
        .replace(/'/g, '%27')
        .replace(/\(/g, '%28')
        .replace(/\)/g, '%29');
      console.log(`🔤 日本語クエリ検出、特別エンコーディング適用`);
    } else {
      encodedQuery = encodeURIComponent(query);
    }
    
    const aucfanURL = `https://aucfan.com/search1/q-${encodedQuery}/`;
    console.log(`📍 URL: ${aucfanURL}`);
    
    // HTTPリクエストを送信
    const response = await httpClient.get(aucfanURL, {
      responseType: 'arraybuffer',
      maxRedirects: 5,
      validateStatus: function (status) {
        return status >= 200 && status < 400; // リダイレクトも許可
      }
    });
    
    if (response.status !== 200) {
      throw new Error(`HTTPエラー: ${response.status}`);
    }
    
    // レスポンスを適切にデコード
    const buffer = Buffer.from(response.data);
    const html = decodeResponse(buffer);
    
    // デバッグ用：HTMLの一部をログ出力
    console.log(`📄 HTML長: ${html.length}文字`);
    
    // Cheerioでパース
    const $ = cheerio.load(html);
    
    const results = [];
    
    // 2024年版オークファンの更新されたセレクタパターン
    const selectors = [
      // 最新のオークファンのセレクタ（推測）
      '.js-product',
      '.js-item',
      '.product-item',
      '.item-data',
      '.result-item',
      '.search-result-item',
      '.l-product-list-item',
      '.auction-item',
      '.product-box',
      '.item-box',
      // フォールバック用の汎用セレクタ
      'tr[class*="item"]',
      'div[class*="item"]',
      'li[class*="product"]',
      'div[class*="product"]'
    ];
    
    // より詳細なセレクタで試行
    for (const selector of selectors) {
      console.log(`🔍 セレクタ試行: ${selector}`);
      
      $(selector).each((index, element) => {
        if (results.length >= 50) return false; // 最大50件まで
        
        const $item = $(element);
        
        // タイトル取得（複数パターン）
        let title = $item.find('h3, .title, .product-title, .item-title, .auction-title, a[title]').first().text().trim();
        if (!title) {
          title = $item.find('a').first().text().trim();
        }
        if (!title) {
          title = $item.find('[class*="title"]').first().text().trim();
        }
        
        // 価格取得（複数パターン）
        let priceText = '';
        const priceSelectors = [
          '.price',
          '.product-price', 
          '.current-price',
          '.item-price',
          '.auction-price',
          '[class*="price"]',
          'td:contains("円")',
          'span:contains("円")',
          'div:contains("円")'
        ];
        
        for (const priceSelector of priceSelectors) {
          priceText = $item.find(priceSelector).text();
          if (priceText && priceText.includes('円')) break;
        }
        
        const price = extractPrice(priceText);
        
        // 日付取得
        const date = $item.find('.date, .end-date, .item-date, .auction-date, [class*="date"]').first().text().trim();
        
        // URL取得
        let linkURL = $item.find('a').first().attr('href');
        if (linkURL && !linkURL.startsWith('http')) {
          linkURL = 'https://aucfan.com' + linkURL;
        }
        
        // 画像URL取得
        let imageURL = $item.find('img').first().attr('src');
        if (imageURL && !imageURL.startsWith('http')) {
          imageURL = 'https://aucfan.com' + imageURL;
        }
        
        // 有効なデータのみ追加
        if (title && title.length > 2 && price > 100) { // 最低価格100円以上
          results.push({
            title: title.substring(0, 100), // タイトルを100文字に制限
            price,
            date,
            url: linkURL || '',
            imageURL: imageURL || ''
          });
        }
      });
      
      if (results.length > 0) {
        console.log(`✅ セレクタ「${selector}」で${results.length}件取得`);
        break;
      }
    }
    
    // より汎用的なHTMLパース（フォールバック）
    if (results.length === 0) {
      console.log('🔄 フォールバック検索を実行');
      
      // 円を含むテキストを直接検索
      $('*').each((index, element) => {
        if (results.length >= 20) return false;
        
        const $el = $(element);
        const text = $el.text();
        
        // 価格らしきパターンを検索
        if (text.match(/[\d,]+円/) && text.length < 500) {
          const priceMatch = text.match(/([\d,]+)円/);
          if (priceMatch) {
            const price = extractPrice(priceMatch[1]);
            if (price > 100 && price < 10000000) { // 100円〜1000万円の範囲
              // 近くのリンクテキストをタイトルとして取得
              const nearbyLink = $el.closest('*').find('a').first();
              const title = nearbyLink.text().trim() || text.substring(0, 50);
              
              if (title.length > 3) {
                results.push({
                  title,
                  price,
                  date: '',
                  url: '',
                  imageURL: ''
                });
              }
            }
          }
        }
      });
    }
    
    console.log(`✅ 取得件数: ${results.length}件`);
    
    if (results.length === 0) {
      // HTMLの構造をデバッグ情報として出力
      console.log('🔍 HTMLデバッグ情報:');
      console.log('- タイトル:', $('title').text());
      console.log('- h1要素:', $('h1').text());
      console.log('- price関連クラス数:', $('[class*="price"]').length);
      console.log('- 円を含む要素数:', $('*:contains("円")').length);
    }
    
    // 価格データの統計情報を計算（異常値除外）
    let avgPrice = 0;
    let maxPrice = 0;
    let minPrice = 0;
    let filteredResults = results;
    
    if (results.length > 0) {
      const prices = results.map(r => r.price);
      const filteredPrices = filterOutliers(prices);
      
      // フィルタ後の結果セットを作成
      if (filteredPrices.length < results.length) {
        filteredResults = results.filter(r => filteredPrices.includes(r.price));
      }
      
      const total = filteredPrices.reduce((sum, price) => sum + price, 0);
      avgPrice = Math.round(total / filteredPrices.length);
      maxPrice = Math.max(...filteredPrices);
      minPrice = Math.min(...filteredPrices);
      
      console.log(`📊 統計: 平均${avgPrice}円, 最高${maxPrice}円, 最低${minPrice}円`);
    }
    
    return {
      query,
      results: filteredResults,
      count: filteredResults.length,
      avgPrice,
      maxPrice,
      minPrice,
      originalCount: results.length // フィルタ前の件数
    };
    
  } catch (error) {
    console.error('❌ スクレイピングエラー:', error.message);
    
    // より詳細なエラー情報
    if (error.response) {
      console.error('- レスポンスステータス:', error.response.status);
      console.error('- レスポンスヘッダー:', error.response.headers);
    }
    
    throw new Error(`オークファンの相場取得に失敗しました: ${error.message}`);
  }
}

/**
 * 仕入れ判定を行う（改良版）
 */
function evaluatePurchase(currentPrice, avgPrice, count) {
  if (avgPrice === 0 || count === 0) {
    return "❌ 相場データが不足しています（検索結果が見つかりません）";
  }
  
  if (count < 3) {
    return "⚠️ 相場データが少ないため判定困難（3件未満）";
  }
  
  const priceRatio = currentPrice / avgPrice;
  const profitMargin = ((avgPrice - currentPrice) / currentPrice) * 100;
  
  if (priceRatio <= 0.5) {
    return `🟢 仕入れ強く推奨: 相場より大幅に安い（50%以上安い、利益率+${Math.round(profitMargin)}%）`;
  } else if (priceRatio <= 0.7) {
    return `🟢 仕入れ推奨: 相場より安い（30%以上安い、利益率+${Math.round(profitMargin)}%）`;
  } else if (priceRatio <= 0.85) {
    return `🟡 仕入れ検討: 相場よりやや安い（15%以上安い、利益率+${Math.round(profitMargin)}%）`;
  } else if (priceRatio <= 1.1) {
    return `🟠 慎重検討: 相場付近（±10%以内、利益率${Math.round(profitMargin)}%）`;
  } else if (priceRatio <= 1.3) {
    return `🔴 仕入れ非推奨: 相場より高い（30%以上高い）`;
  } else {
    return `⛔ 仕入れ不可: 相場より大幅に高い（30%以上高い）`;
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
    const recommendation = evaluatePurchase(currentPrice, result.avgPrice, result.count);
    
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

// LINE Webhook専用のミドルウェア設定
if (hasLineConfig && line && client) {
  app.use('/webhook', line.middleware({
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.LINE_CHANNEL_SECRET,
  }));
}

// その他のルートにはJSONパーサーを適用
app.use((req, res, next) => {
  if (req.path !== '/webhook') {
    express.json()(req, res, next);
  } else {
    next();
  }
});
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

// LINE Bot機能
if (hasLineConfig && line && client) {
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
      return `「${result.query}」の相場情報が見つかりませんでした。\n\n💡 以下をお試しください:\n・型番を英数字で入力\n・商品名を短くする\n・別の呼び方で検索`;
    }
    
    let message = `📊 【${result.query}】相場分析結果\n\n`;
    message += `🔍 検索結果: ${result.count}件`;
    if (result.originalCount && result.originalCount > result.count) {
      message += `（${result.originalCount}件中、外れ値${result.originalCount - result.count}件除外）`;
    }
    message += '\n';
    
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
        if (shortTitle.length > 25) {
          shortTitle = shortTitle.substring(0, 25) + '...';
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
      
      let errorMsg = `❌ 相場情報の取得に失敗しました:\n${error.message}`;
      
      if (error.message.includes('文字化け') || error.message.includes('encode')) {
        errorMsg += '\n\n💡 日本語商品名の場合は型番での検索をお試しください';
      }
      
      errorMsg += '\n\n時間をおいて再度お試しください。';
      
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
  app.post('/webhook', (req, res) => {
    Promise
      .all(req.body.events.map(handleEvent))
      .then((result) => res.json(result))
      .catch((err) => {
        console.error('❌ Webhook処理エラー:', err);
        res.status(500).end();
      });
  });
} else {
  // LINE機能が無効の場合のダミーエンドポイント
  app.post('/webhook', (req, res) => {
    res.json({ 
      error: 'LINE Bot機能が有効ではありません',
      message: 'LINE_CHANNEL_SECRET と LINE_CHANNEL_ACCESS_TOKEN を設定してください'
    });
  });
}

// ヘルスチェック
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    version: '2.0.0',
    lineBot: !!(hasLineConfig && client),
    features: ['outlier_filtering', 'improved_scraping', 'japanese_encoding']
  });
});

// ルートパス
app.get('/', (req, res) => {
  res.json({ 
    message: 'オークファン相場検索API v2.0',
    status: 'running',
    improvements: [
      '✅ 異常値（新品等）自動除外',
      '✅ 日本語クエリ対応強化', 
      '✅ セレクタパターン大幅拡張',
      '✅ エラーハンドリング強化'
    ],
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
  console.log(`📱 API URL: https://go-nogo-scraper.onrender.com/api/search`);
  
  if (hasLineConfig && client) {
    console.log(`📱 LINE Bot Webhook URL: https://go-nogo-scraper.onrender.com/webhook`);
    console.log('✅ LINE Bot設定完了');
  } else {
    console.log('📱 LINE Bot機能は無効です（環境変数が設定されていません）');
    if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) {
      console.warn('⚠️  LINE_CHANNEL_ACCESS_TOKEN が設定されていません');
    }
    if (!process.env.LINE_CHANNEL_SECRET) {
      console.warn('⚠️  LINE_CHANNEL_SECRET が設定されていません');
    }
  }
  
  console.log('🔧 改良点:');
  console.log('- 異常値（新品等）フィルタリング機能');
  console.log('- 日本語固有名詞エンコーディング強化');
  console.log('- オークファン2024年版セレクタ対応');
  console.log('- より詳細なエラー分析とデバッグ情報');
});
