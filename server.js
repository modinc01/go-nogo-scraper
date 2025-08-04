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

// オークファンログイン情報
const AUCFAN_LOGIN = {
  email: process.env.AUCFAN_EMAIL,
  password: process.env.AUCFAN_PASSWORD
};

// セッション管理用のAxiosインスタンス
const httpClient = axios.create({
  timeout: 30000,
  withCredentials: true,
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

// セッション状態管理
let isLoggedIn = false;
let loginAttempts = 0;
let lastLoginAttempt = 0;
const MAX_LOGIN_ATTEMPTS = 3;
const LOGIN_COOLDOWN = 300000; // 5分

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
 * オークファンにログイン
 */
async function loginToAucfan() {
  const now = Date.now();
  
  // ログイン制限チェック
  if (loginAttempts >= MAX_LOGIN_ATTEMPTS && (now - lastLoginAttempt) < LOGIN_COOLDOWN) {
    throw new Error('ログイン試行回数の上限に達しました。しばらく時間をおいてからお試しください。');
  }
  
  if (!AUCFAN_LOGIN.email || !AUCFAN_LOGIN.password) {
    throw new Error('オークファンのログイン情報が設定されていません。環境変数 AUCFAN_EMAIL, AUCFAN_PASSWORD を設定してください。');
  }
  
  try {
    console.log('🔐 オークファンにログイン中...');
    
    // まずログインページを取得してCSRFトークンなどを取得
    const loginPageResponse = await httpClient.get('https://aucfan.com/login', {
      responseType: 'arraybuffer'
    });
    
    const loginPageHtml = decodeResponse(Buffer.from(loginPageResponse.data));
    const $loginPage = cheerio.load(loginPageHtml);
    
    // CSRFトークンを取得
    const csrfToken = $loginPage('input[name="_token"]').val() || 
                     $loginPage('meta[name="csrf-token"]').attr('content') ||
                     $loginPage('input[name="csrf_token"]').val();
    
    console.log('🔑 CSRFトークン取得:', csrfToken ? '成功' : '失敗');
    
    // ログインデータを準備
    const loginData = new URLSearchParams({
      email: AUCFAN_LOGIN.email,
      password: AUCFAN_LOGIN.password,
      ...(csrfToken && { _token: csrfToken })
    });
    
    // ログインリクエストを送信
    const loginResponse = await httpClient.post('https://aucfan.com/login', loginData, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://aucfan.com/login'
      },
      maxRedirects: 5,
      validateStatus: function (status) {
        return status >= 200 && status < 400;
      }
    });
    
    // ログイン成功の確認
    if (loginResponse.request.res.responseUrl && 
        loginResponse.request.res.responseUrl.includes('/mypage') ||
        loginResponse.data.includes('マイページ') ||
        loginResponse.data.includes('ログアウト')) {
      
      isLoggedIn = true;
      loginAttempts = 0;
      console.log('✅ オークファンログイン成功');
      return true;
    }
    
    throw new Error('ログインに失敗しました（認証エラー）');
    
  } catch (error) {
    loginAttempts++;
    lastLoginAttempt = now;
    isLoggedIn = false;
    
    console.error('❌ オークファンログインエラー:', error.message);
    throw new Error(`オークファンログインに失敗: ${error.message}`);
  }
}

/**
 * 価格データから異常値を除外し、最新データに限定
 */
function filterRecentAndValidPrices(results) {
  if (results.length === 0) return results;
  
  // 1. まず明らかに広告や無関係な価格を除外
  let filtered = results.filter(item => {
    const price = item.price;
    const title = item.title.toLowerCase();
    
    // 広告関連のキーワードを含む商品を除外
    const adKeywords = [
      '初月無料', '月額', 'プレミアム', '会員', '登録', '2200円', '998円',
      '入会', 'オークファン', 'aucfan', '無料', 'free'
    ];
    
    const hasAdKeyword = adKeywords.some(keyword => title.includes(keyword));
    
    // 価格が異常に安い場合も除外（100円未満）
    if (price < 100 || hasAdKeyword) {
      console.log(`🚫 除外: ${title} (${price}円) - 広告またはノイズデータ`);
      return false;
    }
    
    return true;
  });
  
  console.log(`🧹 ノイズフィルタ: ${results.length}件 → ${filtered.length}件`);
  
  // 2. 日付でソートして最新のものを優先
  filtered.sort((a, b) => {
    // 日付がある場合は日付でソート、ない場合は配列の順序を維持
    if (a.date && b.date) {
      return new Date(b.date) - new Date(a.date);
    }
    return 0;
  });
  
  // 3. 最新20件に限定
  const recentResults = filtered.slice(0, 20);
  
  // 4. 統計的外れ値を除外（四分位範囲法）
  if (recentResults.length >= 5) {
    const prices = recentResults.map(r => r.price).sort((a, b) => a - b);
    
    const q1Index = Math.floor(prices.length * 0.25);
    const q3Index = Math.floor(prices.length * 0.75);
    const q1 = prices[q1Index];
    const q3 = prices[q3Index];
    const iqr = q3 - q1;
    
    // 外れ値の閾値（少し緩めに設定）
    const lowerBound = q1 - (iqr * 1.5);
    const upperBound = q3 + (iqr * 1.5);
    
    const finalResults = recentResults.filter(item => {
      const inRange = item.price >= lowerBound && item.price <= upperBound;
      if (!inRange) {
        console.log(`📊 統計的外れ値除外: ${item.title} (${item.price}円)`);
      }
      return inRange;
    });
    
    console.log(`📊 統計フィルタ: ${recentResults.length}件 → ${finalResults.length}件`);
    console.log(`📊 価格範囲: ${Math.round(lowerBound)}円 〜 ${Math.round(upperBound)}円`);
    
    return finalResults.length > 0 ? finalResults : recentResults.slice(0, 10);
  }
  
  return recentResults;
}

/**
 * オークファンから相場情報を取得（ログイン版）
 */
async function scrapeAucfanWithLogin(query) {
  try {
    // ログインが必要で、まだログインしていない場合
    if (!isLoggedIn) {
      await loginToAucfan();
    }
    
    console.log(`🔍 検索開始: ${query} (ログイン済み)`);
    
    // 日本語文字の場合は追加でエンコーディング処理
    let encodedQuery;
    if (/[ひらがなカタカナ漢字]/.test(query)) {
      encodedQuery = encodeURIComponent(query)
        .replace(/'/g, '%27')
        .replace(/\(/g, '%28')
        .replace(/\)/g, '%29');
      console.log(`🔤 日本語クエリ検出、特別エンコーディング適用`);
    } else {
      encodedQuery = encodeURIComponent(query);
    }
    
    // プレミアム会員用の検索URL（過去1ヶ月のデータ）
    const aucfanURL = `https://aucfan.com/search1/q-${encodedQuery}/?t=30`; // t=30で過去30日
    console.log(`📍 URL: ${aucfanURL}`);
    
    // HTTPリクエストを送信
    const response = await httpClient.get(aucfanURL, {
      responseType: 'arraybuffer',
      maxRedirects: 5,
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
    
    // ログイン状態を確認
    if (html.includes('ログイン') && html.includes('会員登録')) {
      console.log('⚠️ ログインセッションが切れています。再ログインを試行...');
      isLoggedIn = false;
      await loginToAucfan();
      
      // 再度検索を実行
      const retryResponse = await httpClient.get(aucfanURL, {
        responseType: 'arraybuffer'
      });
      const retryBuffer = Buffer.from(retryResponse.data);
      const retryHtml = decodeResponse(retryBuffer);
      
      return await parseAucfanResults(retryHtml, query);
    }
    
    return await parseAucfanResults(html, query);
    
  } catch (error) {
    console.error('❌ スクレイピングエラー:', error.message);
    
    // ログインエラーの場合は再試行しない
    if (error.message.includes('ログイン')) {
      throw error;
    }
    
    throw new Error(`オークファンの相場取得に失敗しました: ${error.message}`);
  }
}

/**
 * オークファンの検索結果HTMLを解析
 */
async function parseAucfanResults(html, query) {
  console.log(`📄 HTML長: ${html.length}文字`);
  
  // Cheerioでパース
  const $ = cheerio.load(html);
  
  const results = [];
  
  // プレミアム会員向けのセレクタパターン（ログイン後のHTML構造）
  const selectors = [
    // プレミアム会員用のセレクタ
    '.premium-result-item',
    '.member-result-item',
    '.search-result-premium',
    '.product-list-item',
    '.result-product-item',
    // 一般的なセレクタ
    '.js-product',
    '.js-item',
    '.product-item',
    '.item-data',
    '.result-item',
    '.search-result-item',
    '.auction-item',
    '.product-box',
    '.item-box',
    // テーブル形式
    'tr.product-row',
    'tr[class*="item"]',
    'tbody tr',
    // フォールバック用
    'div[class*="item"]',
    'li[class*="product"]',
    'div[class*="product"]'
  ];
  
  for (const selector of selectors) {
    console.log(`🔍 セレクタ試行: ${selector}`);
    
    $(selector).each((index, element) => {
      if (results.length >= 100) return false; // 最大100件まで収集
      
      const $item = $(element);
      
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
      
      // 日付取得（より詳細に）
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
      
      // 有効なデータのみ追加
      if (title && title.length > 2 && price > 0) {
        results.push({
          title: title.substring(0, 100),
          price,
          date,
          url: linkURL || '',
          imageURL: ''
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
      
      // 価格らしきパターンを検索（広告価格を除外）
      if (text.match(/[\d,]+円/) && text.length < 500) {
        const priceMatch = text.match(/([\d,]+)円/);
        if (priceMatch) {
          const price = extractPrice(priceMatch[1]);
          if (price > 1000 && price < 10000000) { // 1000円〜1000万円の範囲
            const nearbyLink = $el.closest('*').find('a').first();
            const title = nearbyLink.text().trim() || text.substring(0, 50);
            
            // 広告関連のキーワードをチェック
            const adKeywords = ['初月無料', '月額', 'プレミアム', '2200円', '998円'];
            const hasAdKeyword = adKeywords.some(keyword => title.includes(keyword));
            
            if (title.length > 3 && !hasAdKeyword) {
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
  
  console.log(`✅ 取得件数: ${results.length}件（フィルタ前）`);
  
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
  }
  
  return {
    query,
    results: filteredResults,
    count: filteredResults.length,
    avgPrice,
    maxPrice,
    minPrice,
    originalCount: results.length,
    isLoggedIn: true
  };
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
    
    // オークファンから相場を取得（ログイン版）
    const result = await scrapeAucfanWithLogin(modelNumber);
    
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

// ログイン状態確認エンドポイント
app.get('/api/login-status', (req, res) => {
  res.json({
    isLoggedIn,
    loginAttempts,
    hasCredentials: !!(AUCFAN_LOGIN.email && AUCFAN_LOGIN.password),
    lastLoginAttempt: lastLoginAttempt > 0 ? new Date(lastLoginAttempt).toISOString() : null
  });
});

// 手動ログインエンドポイント
app.post('/api/login', async (req, res) => {
  try {
    await loginToAucfan();
    res.json({ success: true, message: 'ログインに成功しました' });
  } catch (error) {
    res.status(500).json({ error: error.message });
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
    message += `🔍 検索結果: ${result.count}件（直近1ヶ月）`;
    if (result.originalCount && result.originalCount > result.count) {
      message += `\n📝 フィルタ前: ${result.originalCount}件（ノイズ除去済み）`;
    }
    message += '\n\n';
    
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
      message += '📋 最近の取引例（直近順）:\n';
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
    
    message += '\n✅ オークファンプレミアム会員データ使用';
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
        text: '🔍 オークファンプレミアムで相場を検索中です...\nしばらくお待ちください。'
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
      
      if (error.message.includes('ログイン')) {
        errorMsg += '\n\n🔐 オークファンアカウントの認証に問題があります。管理者にお問い合わせください。';
      } else if (error.message.includes('文字化け') || error.message.includes('encode')) {
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
    version: '3.0.0',
    lineBot: !!(hasLineConfig && client),
    aucfanLogin: isLoggedIn,
    features: [
      'aucfan_premium_login',
      'recent_data_filtering',
      'ad_content_removal',
      'statistical_outlier_detection'
    ]
  });
});

// ルートパス
app.get('/', (req, res) => {
  res.json({ 
    message: 'オークファン相場検索API v3.0（プレミアム会員版）',
    status: 'running',
    loginStatus: isLoggedIn ? 'ログイン済み' : '未ログイン',
    improvements: [
      '✅ オークファンプレミアム会員ログイン機能',
      '✅ 広告・ノイズデータ自動除外',
      '✅ 直近1ヶ月・最新20件データに限定',
      '✅ 統計的異常値検出・除外'
    ],
    endpoints: [
      'POST /api/search - 相場検索API',
      'GET /api/login-status - ログイン状態確認',
      'POST /api/login - 手動ログイン',
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
  }
  
  console.log('🔧 新機能:');
  console.log('- オークファンプレミアム会員ログイン');
  console.log('- 広告データ（初月無料2200円等）自動除外');
  console.log('- 直近1ヶ月データに限定（過去30日）');
  console.log('- 最新20件の成約相場を優先');
  console.log('- 統計的外れ値の自動検出・除外');
  
  // 環境変数チェック
  if (hasLineConfig && client) {
    console.log('✅ LINE Bot設定完了');
  }
  
  if (AUCFAN_LOGIN.email && AUCFAN_LOGIN.password) {
    console.log('✅ オークファンログイン情報設定済み');
  } else {
    console.warn('⚠️  AUCFAN_EMAIL, AUCFAN_PASSWORD が設定されていません');
    console.warn('⚠️  プレミアム会員機能を使用するには環境変数の設定が必要です');
  }
});
