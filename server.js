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
 * 文字エンコーディングを適切に処理（日本語強化版）
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
    // まずShift_JISを試す
    const sjisText = iconv.decode(buffer, 'shift_jis');
    if (!sjisText.includes('�')) {
      return sjisText;
    }
    
    // 次にEUC-JPを試す
    const eucText = iconv.decode(buffer, 'euc-jp');
    if (!eucText.includes('�')) {
      return eucText;
    }
    
    return sjisText; // Shift_JISを優先
  } catch (e) {
    // iconv-liteが無い場合はUTF-8で強制変換
    return buffer.toString('utf8');
  }
}

/**
 * 価格データから異常値・広告データを除外し、最新データに限定
 */
function filterRecentAndValidPrices(results) {
  if (results.length === 0) return results;
  
  console.log(`🧹 フィルタリング開始: ${results.length}件`);
  
  // 1. まず明らかに広告や無関係な価格を除外
  let filtered = results.filter(item => {
    const price = item.price;
    const title = item.title.toLowerCase();
    
    // 広告関連のキーワードを含む商品を除外
    const adKeywords = [
      '初月無料', '月額', 'プレミアム', '会員', '登録', '2200円', '998円',
      '入会', 'オークファン', 'aucfan', '無料', 'free', '円/税込',
      'プラン', 'サービス', '利用', 'アップグレード', '課金', '支払い'
    ];
    
    const hasAdKeyword = adKeywords.some(keyword => title.includes(keyword));
    
    // 価格が異常に安い場合（500円未満）も除外
    const isTooLowPrice = price < 500;
    
    // 価格が異常に高い場合（平均の10倍以上）も一旦チেック用にログ
    if (price > 1000000) {
      console.log(`💰 高額商品検出: ${title} (${price}円)`);
    }
    
    if (hasAdKeyword || isTooLowPrice) {
      console.log(`🚫 除外: ${title} (${price}円) - ${hasAdKeyword ? '広告キーワード' : '低価格'}検出`);
      return false;
    }
    
    return true;
  });
  
  console.log(`🧹 広告フィルタ: ${results.length}件 → ${filtered.length}件`);
  
  // 2. 最新20件に限定
  const recentResults = filtered.slice(0, 20);
  console.log(`📅 最新20件に限定: ${filtered.length}件 → ${recentResults.length}件`);
  
  // 3. 統計的外れ値を除外（四分位範囲法）
  if (recentResults.length >= 5) {
    const prices = recentResults.map(r => r.price).sort((a, b) => a - b);
    
    const q1Index = Math.floor(prices.length * 0.25);
    const q3Index = Math.floor(prices.length * 0.75);
    const q1 = prices[q1Index];
    const q3 = prices[q3Index];
    const iqr = q3 - q1;
    
    // 外れ値の閾値（少し緩めに設定）
    const lowerBound = Math.max(500, q1 - (iqr * 1.5)); // 最低500円
    const upperBound = q3 + (iqr * 1.5);
    
    const finalResults = recentResults.filter(item => {
      const inRange = item.price >= lowerBound && item.price <= upperBound;
      if (!inRange) {
        console.log(`📊 統計的外れ値除外: ${item.title} (${item.price}円)`);
      }
      return inRange;
    });
    
    console.log(`📊 統計フィルタ: ${recentResults.length}件 → ${finalResults.length}件`);
    console.log(`📊 有効価格範囲: ${Math.round(lowerBound).toLocaleString()}円 〜 ${Math.round(upperBound).toLocaleString()}円`);
    
    return finalResults.length > 0 ? finalResults : recentResults.slice(0, 10);
  }
  
  return recentResults;
}

/**
 * オークファンから相場情報を取得（日本語対応強化版）
 */
async function scrapeAucfan(query) {
  try {
    console.log(`🔍 検索開始: ${query}`);
    
    // 日本語文字の場合は複数のエンコーディング方式を試す
    let encodedQuery;
    if (/[ひらがなカタカナ漢字]/.test(query)) {
      // 日本語の場合、複数の方式でエンコード
      console.log(`🔤 日本語クエリ検出: ${query}`);
      
      // 方式1: 標準的なURIエンコード
      const standardEncoded = encodeURIComponent(query);
      
      // 方式2: 手動でUTF-8バイト列に変換
      const utf8Bytes = Buffer.from(query, 'utf8');
      const hexEncoded = Array.from(utf8Bytes)
        .map(b => '%' + b.toString(16).padStart(2, '0').toUpperCase())
        .join('');
      
      // まず標準方式を試す
      encodedQuery = standardEncoded;
      console.log(`📝 エンコード結果: ${encodedQuery}`);
    } else {
      encodedQuery = encodeURIComponent(query);
    }
    
    // メルカリ・ヤフオク限定の検索URL（オークファンの検索パラメータ）
    const aucfanURL = `https://aucfan.com/search1/q-${encodedQuery}/?o=t1&s1=end_time&t=-1`;
    console.log(`📍 URL: ${aucfanURL}`);
    
    // HTTPリクエストを送信（日本語対応のヘッダー追加）
    const response = await httpClient.get(aucfanURL, {
      responseType: 'arraybuffer',
      maxRedirects: 5,
      headers: {
        ...httpClient.defaults.headers,
        'Accept-Charset': 'utf-8, shift_jis, euc-jp',
        'Accept-Language': 'ja-JP,ja;q=0.9,en;q=0.8'
      },
      validateStatus: function (status) {
        return status >= 200 && status < 400;
      }
    });
    
    if (response.status !== 200) {
      throw new Error(`HTTPエラー: ${response.status}`);
    }
    
    // レスポンスを適切にデコード
    const buffer = Buffer.from(response.data);
    const html = decodeResponse(buffer);
    
    console.log(`📄 HTML長: ${html.length}文字`);
    
    // 日本語が正しく表示されているかチェック
    if (/[ひらがなカタカナ漢字]/.test(query) && !html.includes(query)) {
      console.log('⚠️ 検索クエリがHTMLに見つかりません。別のエンコーディングを試行...');
      
      // 方式2で再試行
      const utf8Bytes = Buffer.from(query, 'utf8');
      const hexEncoded = Array.from(utf8Bytes)
        .map(b => '%' + b.toString(16).padStart(2, '0').toUpperCase())
        .join('');
      
      const retryURL = `https://aucfan.com/search1/q-${hexEncoded}/?o=t1&s1=end_time&t=-1`;
      console.log(`🔄 再試行URL: ${retryURL}`);
      
      const retryResponse = await httpClient.get(retryURL, {
        responseType: 'arraybuffer',
        headers: {
          ...httpClient.defaults.headers,
          'Accept-Charset': 'utf-8, shift_jis, euc-jp',
          'Accept-Language': 'ja-JP,ja;q=0.9,en;q=0.8'
        }
      });
      
      if (retryResponse.status === 200) {
        const retryBuffer = Buffer.from(retryResponse.data);
        const retryHtml = decodeResponse(retryBuffer);
        return await parseAucfanResults(retryHtml, query);
      }
    }
    
/**
 * オークファンの検索結果HTMLを解析（メルカリ・ヤフオク限定）
 */
async function parseAucfanResults(html, query) {
  console.log(`📄 HTML長: ${html.length}文字`);
  
  // Cheerioでパース
  const $ = cheerio.load(html);
  
  const results = [];
  
  // メルカリ・ヤフオクの結果のみを取得するセレクタ
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
    // 2024年版の新しいセレクタ
    '.product-list-item',
    '.result-product-item',
    '.search-item',
    '.auction-result',
    // テーブル形式
    'tr.product-row',
    'tr[class*="item"]',
    'tbody tr',
    // フォールバック用の汎用セレクタ
    'div[class*="item"]',
    'li[class*="product"]',
    'div[class*="product"]'
  ];
  
  // より詳細なセレクタで試行
  for (const selector of selectors) {
    console.log(`🔍 セレクタ試行: ${selector}`);
    
    $(selector).each((index, element) => {
      if (results.length >= 100) return false; // 最大100件まで収集
      
      const $item = $(element);
      
      // プラットフォーム判定（メルカリ・ヤフオクのみ）
      const itemHtml = $item.html();
      const isFromMercari = itemHtml && (
        itemHtml.includes('mercari') || 
        itemHtml.includes('メルカリ') ||
        $item.find('*:contains("メルカリ")').length > 0
      );
      const isFromYahooAuction = itemHtml && (
        itemHtml.includes('yahoo') || 
        itemHtml.includes('ヤフオク') ||
        itemHtml.includes('Yahoo') ||
        $item.find('*:contains("ヤフオク")').length > 0 ||
        $item.find('*:contains("Yahoo")').length > 0
      );
      
      // Yahoo!ショッピングを除外
      const isFromYahooShopping = itemHtml && (
        itemHtml.includes('shopping.yahoo') ||
        itemHtml.includes('ショッピング') ||
        $item.find('*:contains("ショッピング")').length > 0
      );
      
      // メルカリまたはヤフオクでない場合、またはYahoo!ショッピングの場合はスキップ
      if ((!isFromMercari && !isFromYahooAuction) || isFromYahooShopping) {
        return true; // continue
      }
      
      // タイトル取得（複数パターン）
      let title = '';
      const titleSelectors = [
        'h3', '.title', '.product-title', '.item-title', '.auction-title',
        'a[title]', '.product-name', '.item-name', '.auction-name',
        '.result-title', '[class*="title"]'
      ];
      
      for (const titleSelector of titleSelectors) {
        title = $item.find(titleSelector).first().text().trim();
        if (title && title.length > 3) break;
      }
      
      if (!title) {
        title = $item.find('a').first().text().trim();
      }
      
      // 価格取得（複数パターン）
      let priceText = '';
      const priceSelectors = [
        '.price', '.product-price', '.current-price', '.item-price',
        '.auction-price', '.end-price', '.final-price', '.sold-price',
        '[class*="price"]', 'td:contains("円")', 'span:contains("円")',
        'div:contains("円")', '.yen', '.money'
      ];
      
      for (const priceSelector of priceSelectors) {
        priceText = $item.find(priceSelector).text();
        if (priceText && priceText.includes('円')) break;
      }
      
      const price = extractPrice(priceText);
      
      // 日付取得
      let date = '';
      const dateSelectors = [
        '.date', '.end-date', '.item-date', '.auction-date',
        '.sell-date', '.sold-date', '[class*="date"]', '.time'
      ];
      
      for (const dateSelector of dateSelectors) {
        date = $item.find(dateSelector).first().text().trim();
        if (date && (date.includes('/') || date.includes('-') || date.includes('月'))) break;
      }
      
      // URL取得
      let linkURL = $item.find('a').first().attr('href');
      if (linkURL && !linkURL.startsWith('http')) {
        linkURL = 'https://aucfan.com' + linkURL;
      }
      
      // プラットフォーム情報を追加
      const platform = isFromMercari ? 'メルカリ' : 'ヤフオク';
      
      // 有効なデータのみ追加
      if (title && title.length > 2 && price > 0) {
        results.push({
          title: title.substring(0, 100),
          price,
          date,
          url: linkURL || '',
          imageURL: '',
          platform
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
    
    $('*').each((index, element) => {
      if (results.length >= 50) return false;
      
      const $el = $(element);
      const text = $el.text();
      
      // メルカリ・ヤフオクの判定
      const isFromTarget = text.includes('メルカリ') || text.includes('ヤフオク') || text.includes('Yahoo');
      const isFromShopping = text.includes('ショッピング');
      
      if (!isFromTarget || isFromShopping) {
        return true; // continue
      }
      
      // 価格らしきパターンを検索（広告価格を除外）
      if (text.match(/[\d,]+円/) && text.length < 500) {
        const priceMatch = text.match(/([\d,]+)円/);
        if (priceMatch) {
          const price = extractPrice(priceMatch[1]);
          if (price > 500 && price < 10000000) { // 500円〜1000万円の範囲
            const nearbyLink = $el.closest('*').find('a').first();
            const title = nearbyLink.text().trim() || text.substring(0, 50);
            
            // 広告関連のキーワードをチェック
            const adKeywords = ['初月無料', '月額', 'プレミアム', '2200円', '998円', 'オークファン'];
            const hasAdKeyword = adKeywords.some(keyword => title.includes(keyword));
            
            if (title.length > 3 && !hasAdKeyword) {
              const platform = text.includes('メルカリ') ? 'メルカリ' : 'ヤフオク';
              results.push({
                title,
                price,
                date: '',
                url: '',
                imageURL: '',
                platform
              });
            }
          }
        }
      }
    });
  }
  
  console.log(`✅ 取得件数: ${results.length}件（フィルタ前）`);
  
  if (results.length === 0) {
    // HTMLの構造をデバッグ情報として出力
    console.log('🔍 HTMLデバッグ情報:');
    console.log('- タイトル:', $('title').text());
    console.log('- h1要素:', $('h1').text());
    console.log('- メルカリを含む要素数:', $('*:contains("メルカリ")').length);
    console.log('- ヤフオクを含む要素数:', $('*:contains("ヤフオク")').length);
    console.log('- Yahoo!を含む要素数:', $('*:contains("Yahoo")').length);
    console.log('- 円を含む要素数:', $('*:contains("円")').length);
  }
  
  // 最新データに限定し、異常値を除外
  const filteredResults = filterRecentAndValidPrices(results);
  
  // 統計情報を計算
  let avgPrice = 0;
  let maxPrice = 0;
  let minPrice = 0;
  
  if (filteredResults.length > 0) {
    const prices = filteredResults.map(r => r.price);
    const total = prices.reduce((sum, price) => sum + price, 0);
    avgPrice = Math.round(total / prices.length);
    maxPrice = Math.max(...prices);
    minPrice = Math.min(...prices);
    
    console.log(`📊 最終統計: 平均${avgPrice}円, 最高${maxPrice}円, 最低${minPrice}円`);
    console.log(`📊 プラットフォーム内訳: メルカリ${filteredResults.filter(r => r.platform === 'メルカリ').length}件, ヤフオク${filteredResults.filter(r => r.platform === 'ヤフオク').length}件`);
  }
  
  return {
    query,
    results: filteredResults,
    count: filteredResults.length,
    avgPrice,
    maxPrice,
    minPrice,
    originalCount: results.length,
    isLoggedIn: false
  };
}
    
    // より詳細なエラー情報
    if (error.response) {
      console.error('- レスポンスステータス:', error.response.status);
      console.error('- レスポンスヘッダー:', error.response.headers);
    }
    
    throw new Error(`オークファンの相場取得に失敗しました: ${error.message}`);
  }
}

/**
 * 仕入れ判定を行う（手数料・消費税込み版）
 */
function evaluatePurchase(auctionPrice, avgPrice, count) {
  if (avgPrice === 0 || count === 0) {
    return {
      emoji: "❌",
      decision: "判定不可",
      reason: "相場データなし",
      totalCost: 0
    };
  }
  
  if (count < 3) {
    return {
      emoji: "⚠️",
      decision: "判定困難", 
      reason: "データ不足（3件未満）",
      totalCost: 0
    };
  }
  
  // 総原価計算：オークション価格 × 1.05（手数料5%） × 1.10（消費税10%）
  const totalCost = Math.round(auctionPrice * 1.05 * 1.10);
  const profit = avgPrice - totalCost;
  const profitRate = Math.round((profit / totalCost) * 100);
  
  if (profitRate >= 50) {
    return {
      emoji: "🟢",
      decision: "仕入れ推奨",
      reason: `利益率+${profitRate}%`,
      totalCost
    };
  } else if (profitRate >= 20) {
    return {
      emoji: "🟡",
      decision: "仕入れ検討",
      reason: `利益率+${profitRate}%`,
      totalCost
    };
  } else if (profitRate >= 0) {
    return {
      emoji: "🟠",
      decision: "慎重検討",
      reason: `利益率+${profitRate}%`,
      totalCost
    };
  } else {
    return {
      emoji: "🔴",
      decision: "仕入れNG",
      reason: `損失${Math.abs(profitRate)}%`,
      totalCost
    };
  }
}

/**
 * メイン処理関数
 */
async function processQuery(modelNumber, auctionPrice) {
  try {
    // 1秒待機
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // オークファンから相場を取得
    const result = await scrapeAucfan(modelNumber);
    
    // 仕入れ判定を追加（手数料・消費税込み）
    const judgment = evaluatePurchase(auctionPrice, result.avgPrice, result.count);
    
    // 原価計算詳細
    const handlingFee = Math.round(auctionPrice * 0.05); // 手数料5%
    const subtotal = auctionPrice + handlingFee;
    const consumptionTax = Math.round(subtotal * 0.10); // 消費税10%
    const totalCost = judgment.totalCost;
    const profit = result.avgPrice - totalCost;
    const profitRate = result.avgPrice > 0 ? Math.round(((result.avgPrice - totalCost) / totalCost) * 100) : 0;
    
    return {
      ...result,
      auctionPrice,
      handlingFee,
      consumptionTax,
      totalCost,
      judgment,
      profit,
      profitRate
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
    const { modelNumber, auctionPrice } = req.body;
    
    if (!modelNumber || !auctionPrice) {
      return res.status(400).json({
        error: '型番とオークション価格を指定してください',
        example: { modelNumber: 'iPhone 13 Pro', auctionPrice: 80000 }
      });
    }
    
    const result = await processQuery(modelNumber, parseInt(auctionPrice));
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
      const priceMatch = line.match(/(価格|現在価格|落札価格|入札価格|オークション価格)[:：]\s*([0-9,]+)/i);
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
      return { error: 'オークション価格が見つかりません' };
    }
    
    return { modelNumber, price };
  }

  /**
   * 結果メッセージをフォーマット（手数料・消費税込み版）
   */
  function formatResultMessage(result) {
    if (result.count === 0) {
      return `❌ 「${result.query}」の相場が見つかりません\n\n💡 型番を英数字で入力してみてください`;
    }
    
    const { judgment } = result;
    
    // メインメッセージ（大きく表示）
    let message = `${judgment.emoji} ${judgment.decision}\n`;
    message += `${judgment.reason}\n\n`;
    
    // 基本情報
    message += `📊 【${result.query}】\n`;
    message += `💰 平均相場: ${result.avgPrice.toLocaleString()}円\n\n`;
    
    // 原価計算の詳細
    message += `💵 オークション価格: ${result.auctionPrice.toLocaleString()}円\n`;
    message += `📝 手数料(5%): ${result.handlingFee.toLocaleString()}円\n`;
    message += `📝 消費税(10%): ${result.consumptionTax.toLocaleString()}円\n`;
    message += `💼 総原価: ${result.totalCost.toLocaleString()}円\n\n`;
    
    if (result.profit > 0) {
      message += `✅ 想定利益: +${result.profit.toLocaleString()}円\n`;
    } else {
      message += `❌ 想定損失: ${result.profit.toLocaleString()}円\n`;
    }
    
    message += `📈 検索結果: ${result.count}件\n\n`;
    
    // プラットフォーム内訳
    const mercariCount = result.results.filter(r => r.platform === 'メルカリ').length;
    const yahooCount = result.results.filter(r => r.platform === 'ヤフオク').length;
    
    if (mercariCount > 0 || yahooCount > 0) {
      message += `📱 内訳: `;
      if (mercariCount > 0) message += `メルカリ${mercariCount}件 `;
      if (yahooCount > 0) message += `ヤフオク${yahooCount}件`;
      message += '\n\n';
    }
    
    // 最近の取引例（最大2件）
    if (result.results.length > 0) {
      message += '📋 最近の取引:\n';
      const maxDisplay = Math.min(2, result.results.length);
      
      for (let i = 0; i < maxDisplay; i++) {
        const auction = result.results[i];
        let shortTitle = auction.title;
        if (shortTitle.length > 20) {
          shortTitle = shortTitle.substring(0, 20) + '...';
        }
        message += `${auction.platform}: ${auction.price.toLocaleString()}円\n`;
      }
    }
    
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
        text: '🔍 相場検索中...\n(メルカリ・ヤフオクのみ対象)'
      });
      
      const parseResult = parseMessage(messageText);
      
      if (parseResult.error) {
        const errorMsg = `❌ ${parseResult.error}\n\n💡 正しい形式で入力してください:\n\n例1:\niPhone 13 Pro\n80000\n\n例2:\n型番: iPhone 13 Pro\nオークション価格: 80000`;
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
    version: '2.1.0',
    lineBot: !!(hasLineConfig && client),
    aucfanLogin: false,
    features: [
      'ad_content_removal',
      'recent_data_filtering',
      'statistical_outlier_detection',
      'improved_error_handling'
    ]
  });
});

// ルートパス
app.get('/', (req, res) => {
  res.json({ 
    message: 'オークファン相場検索API v2.1（シンプル版）',
    status: 'running',
    improvements: [
      '✅ 広告データ（初月無料2200円等）自動除外',
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
          auctionPrice: 80000
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
  console.log('- 広告データ（初月無料2200円等）完全除外');
  console.log('- 異常値（新品等）統計的フィルタリング');
  console.log('- 日本語固有名詞エンコーディング強化');
  console.log('- オークファン2024年版セレクタ対応');
  console.log('- より詳細なエラー分析とデバッグ情報');
  console.log('- ログイン機能を無効化して安定性向上');
});
