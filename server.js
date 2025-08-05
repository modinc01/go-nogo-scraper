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

// HTTPクライアントの設定（リダイレクト対応）
const httpClient = axios.create({
  timeout: 15000, // タイムアウトを短縮
  maxRedirects: 3, // リダイレクト回数を制限
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ja,en-US;q=0.5,en;q=0.3',
    'Accept-Encoding': 'gzip, deflate',
    'DNT': '1',
    'Connection': 'keep-alive',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache'
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
    
    // 価格が異常に高い場合（平均の10倍以上）も一旦チェック用にログ
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
 * オークファンの検索結果HTMLを解析（メルカリ・ヤフオク限定）
 */
async function parseAucfanResults(html, query) {
  console.log(`📄 HTML長: ${html.length}文字`);
  
  // Cheerioでパース
  const $ = cheerio.load(html);
  
  const results = [];
  
  // 2024年版オークファンの最新セレクタパターン（幅広く対応）
  const selectors = [
    // 最新のオークファンのセレクタ
    'tr', // テーブル行
    '.productlist-item',
    '.productlist-price',
    '.search-result',
    '.result-list tr',
    'table tr',
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
    '.product-list-item',
    '.result-product-item',
    '.search-item',
    '.auction-result',
    // フォールバック用
    'div[class*="item"]',
    'li[class*="product"]',
    'div[class*="product"]'
  ];
  
  console.log('🔍 HTML構造デバッグ情報:');
  console.log('- メルカリを含むテキスト要素数:', $('*:contains("メルカリ")').length);
  console.log('- ヤフオクを含むテキスト要素数:', $('*:contains("ヤフオク")').length);
  console.log('- 円を含むテキスト要素数:', $('*:contains("円")').length);
  console.log('- テーブル行数:', $('tr').length);
  console.log('- リンク数:', $('a').length);
  
  // まずメルカリ・ヤフオクのデータが含まれているかチェック
  const mercariElements = $('*:contains("メルカリ")');
  const yahooElements = $('*:contains("ヤフオク"), *:contains("Yahoo")');
  
  console.log(`📱 プラットフォーム検出: メルカリ${mercariElements.length}要素, ヤフオク${yahooElements.length}要素`);
  
  // より詳細なセレクタで試行
  for (const selector of selectors) {
    console.log(`🔍 セレクタ試行: ${selector}`);
    
    const elements = $(selector);
    console.log(`  - 要素数: ${elements.length}`);
    
    elements.each((index, element) => {
      if (results.length >= 100) return false; // 最大100件まで収集
      
      const $item = $(element);
      const itemText = $item.text();
      const itemHtml = $item.html() || '';
      
      // より柔軟なプラットフォーム判定（メルカリShopsのみ除外）
      const containsMercari = (itemText.includes('メルカリ') || 
                             itemHtml.includes('mercari') || 
                             itemHtml.includes('メルカリ') ||
                             $item.find('*').text().includes('メルカリ')) &&
                             // メルカリShopsのみ除外（個人アカウントは含める）
                             !itemText.includes('メルカリShops') &&
                             !itemText.includes('メルカリshops') &&
                             !itemText.toLowerCase().includes('mercari shops');
                             
      const containsYahoo = itemText.includes('ヤフオク') || 
                           itemText.includes('Yahoo') ||
                           itemHtml.includes('yahoo') || 
                           itemHtml.includes('ヤフオク') ||
                           itemHtml.includes('Yahoo') ||
                           $item.find('*').text().includes('ヤフオク') ||
                           $item.find('*').text().includes('Yahoo');
      
      // Yahoo!ショッピング除外
      const containsShopping = itemText.includes('ショッピング') ||
                              itemHtml.includes('shopping') ||
                              itemHtml.includes('ショッピング');
      
      // メルカリまたはヤフオクでない場合、またはショッピングの場合はスキップ
      if ((!containsMercari && !containsYahoo) || containsShopping) {
        return true; // continue
      }
      
      // タイトル取得（より幅広く）
      let title = '';
      
      // 複数の方法でタイトルを取得
      const titleCandidates = [
        $item.find('a').first().text().trim(),
        $item.find('td').eq(1).text().trim(), // 2番目のtd（商品名列）
        $item.find('td').eq(2).text().trim(), // 3番目のtd
        $item.find('.title, .product-title, .item-title').text().trim(),
        $item.find('h3, h4, h5').text().trim(),
        $item.text().trim()
      ];
      
      for (const candidate of titleCandidates) {
        if (candidate && candidate.length > 5 && candidate.length < 200) {
          title = candidate;
          break;
        }
      }
      
      // 価格取得（より柔軟に）
      let price = 0;
      const priceTexts = [
        $item.find('*:contains("円")').text(),
        $item.text()
      ];
      
      for (const priceText of priceTexts) {
        if (priceText.includes('円')) {
          const matches = priceText.match(/(\d{1,3}(?:,\d{3})*|\d+)円/g);
          if (matches) {
            for (const match of matches) {
              const extractedPrice = extractPrice(match);
              if (extractedPrice > 500 && extractedPrice < 10000000) {
                price = extractedPrice;
                break;
              }
            }
            if (price > 0) break;
          }
        }
      }
      
      // 日付取得
      let date = '';
      const dateText = $item.text();
      const dateMatch = dateText.match(/(\d{4}[-\/]\d{1,2}[-\/]\d{1,2}|\d{1,2}[-\/]\d{1,2}|\d{1,2}月\d{1,2}日)/);
      if (dateMatch) {
        date = dateMatch[1];
      }
      
      // URL取得
      let linkURL = $item.find('a').first().attr('href');
      if (linkURL && !linkURL.startsWith('http')) {
        linkURL = 'https://aucfan.com' + linkURL;
      }
      
      // プラットフォーム判定
      const platform = containsMercari ? 'メルカリ' : 'ヤフオク';
      
      // 有効なデータのみ追加（条件を緩和）
      if (title && title.length > 3 && price > 500) {
        
        // デバッグ用ログ
        if (results.length < 5) {
          console.log(`📝 データ抽出成功 ${results.length + 1}: ${platform} - ${title.substring(0, 30)}... - ${price}円`);
        }
        
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
  
  // フォールバック: より積極的な検索
  if (results.length === 0) {
    console.log('🔄 フォールバック検索を実行（より積極的）');
    
    // メルカリとヤフオクを含む要素を直接検索（メルカリShopsのみ除外）
    $('*:contains("メルカリ"), *:contains("ヤフオク"), *:contains("Yahoo")').each((index, element) => {
      if (results.length >= 50) return false;
      
      const $el = $(element);
      const text = $el.text();
      
      // メルカリShops、ショッピング除外（個人メルカリは含める）
      if (text.includes('ショッピング') || 
          text.includes('メルカリShops') || 
          text.includes('メルカリshops') ||
          text.toLowerCase().includes('mercari shops')) return true;
      
      // 価格を含む要素のみ
      if (!text.includes('円')) return true;
      
      // 価格抽出
      const priceMatches = text.match(/(\d{1,3}(?:,\d{3})*|\d+)円/g);
      if (!priceMatches) return true;
      
      for (const priceMatch of priceMatches) {
        const price = extractPrice(priceMatch);
        if (price > 500 && price < 10000000) {
          
          // タイトル取得（近くの要素から）
          let title = '';
          const parent = $el.parent();
          const siblings = $el.siblings();
          
          // 親要素やシブリング要素からタイトルを探す
          const titleCandidates = [
            $el.find('a').text().trim(),
            parent.find('a').text().trim(),
            siblings.filter('a').text().trim(),
            parent.text().trim(),
            text.trim()
          ];
          
          for (const candidate of titleCandidates) {
            if (candidate && candidate.length > 5 && candidate.length < 200) {
              title = candidate;
              break;
            }
          }
          
          if (title) {
            const platform = text.includes('メルカリ') ? 'メルカリ' : 'ヤフオク';
            
            console.log(`📝 フォールバック取得: ${platform} - ${title.substring(0, 30)}... - ${price}円`);
            
            results.push({
              title: title.substring(0, 100),
              price,
              date: '',
              url: '',
              imageURL: '',
              platform
            });
            
            break; // 1つの要素から1つのアイテムのみ
          }
        }
      }
    });
  }
  
  console.log(`✅ 取得件数: ${results.length}件（フィルタ前）`);
  
  if (results.length === 0) {
    // より詳細なデバッグ情報
    console.log('🔍 詳細HTMLデバッグ:');
    
    // サンプルのメルカリ・ヤフオク要素を表示
    const mercariSample = $('*:contains("メルカリ")').first();
    const yahooSample = $('*:contains("ヤフオク")').first();
    
    if (mercariSample.length > 0) {
      console.log('📱 メルカリ要素サンプル:', mercariSample.text().substring(0, 100));
      console.log('📱 メルカリ要素HTML:', mercariSample.html().substring(0, 200));
    }
    
    if (yahooSample.length > 0) {
      console.log('📱 ヤフオク要素サンプル:', yahooSample.text().substring(0, 100));
      console.log('📱 ヤフオク要素HTML:', yahooSample.html().substring(0, 200));
    }
    
    // テーブル構造をチェック
    const tableRows = $('table tr');
    console.log('📊 テーブル行数:', tableRows.length);
    if (tableRows.length > 0) {
      console.log('📊 最初のテーブル行:', tableRows.first().text().substring(0, 100));
    }
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
      encodedQuery = encodeURIComponent(query);
      console.log(`📝 エンコード結果: ${encodedQuery}`);
    } else {
      encodedQuery = encodeURIComponent(query);
    }
    
    // シンプルなオークファンURL（リダイレクト回避）
    const aucfanURL = `https://aucfan.com/search1/q-${encodedQuery}/`;
    console.log(`📍 URL: ${aucfanURL}`);
    
    // HTTPリクエストを送信（リダイレクト制限を緩和）
    const response = await httpClient.get(aucfanURL, {
      responseType: 'arraybuffer',
      maxRedirects: 3, // リダイレクト回数を制限
      timeout: 15000, // タイムアウトを短縮
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja,en-US;q=0.5,en;q=0.3',
        'Accept-Encoding': 'gzip, deflate',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
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
    
    // HTMLに検索結果があるかチェック
    if (html.includes('検索結果が見つかりません') || html.includes('該当する商品が見つかりません')) {
      console.log('❌ 検索結果なし');
      return {
        query,
        results: [],
        count: 0,
        avgPrice: 0,
        maxPrice: 0,
        minPrice: 0,
        originalCount: 0,
        isLoggedIn: false
      };
    }
    
    return await parseAucfanResults(html, query);
    
  } catch (error) {
    console.error('❌ スクレイピングエラー:', error.message);
    
    // リダイレクトエラーの場合は別のアプローチ
    if (error.message.includes('redirect')) {
      console.log('🔄 リダイレクト回避で再試行');
      try {
        // 最もシンプルなURL
        const simpleURL = `https://aucfan.com/search1/q-${encodeURIComponent(query)}/`;
        const response = await httpClient.get(simpleURL, {
          responseType: 'arraybuffer',
          maxRedirects: 0, // リダイレクトを無効化
          timeout: 10000,
          validateStatus: function (status) {
            return status >= 200 && status < 400;
          }
        });
        
        const buffer = Buffer.from(response.data);
        const html = decodeResponse(buffer);
        return await parseAucfanResults(html, query);
        
      } catch (retryError) {
        console.error('❌ 再試行も失敗:', retryError.message);
      }
    }
    
    // より詳細なエラー情報
    if (error.response) {
      console.error('- レスポンスステータス:', error.response.status);
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
      totalCost: auctionPrice // 最低でもオークション価格
    };
  }
  
  if (count < 3) {
    return {
      emoji: "⚠️",
      decision: "判定困難", 
      reason: "データ不足（3件未満）",
      totalCost: Math.round(auctionPrice * 1.155) // 手数料+消費税込み
    };
  }
  
  // 総原価計算：オークション価格 × 1.05（手数料5%） × 1.10（消費税10%）
  const totalCost = Math.round(auctionPrice * 1.155); // 1.05 * 1.10 = 1.155
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
 * 商品名から類似商品も検索（オプション機能）
 */
async function searchSimilarProducts(originalQuery) {
  console.log(`🔄 類似商品検索: ${originalQuery}`);
  
  const similarResults = [];
  
  // 商品名から重要なキーワードを抽出
  const keywords = extractKeywords(originalQuery);
  
  for (const keyword of keywords) {
    if (keyword === originalQuery) continue; // 元の検索を除外
    
    try {
      console.log(`🔍 類似検索: ${keyword}`);
      const result = await scrapeAucfan(keyword);
      
      if (result.count > 0) {
        similarResults.push({
          query: keyword,
          count: result.count,
          avgPrice: result.avgPrice
        });
      }
      
      // APIの負荷を避けるため1秒待機
      await new Promise(resolve => setTimeout(resolve, 1000));
      
    } catch (error) {
      console.log(`⚠️ 類似検索エラー (${keyword}):`, error.message);
    }
  }
  
  return similarResults;
}

/**
 * 商品名から重要なキーワードを抽出
 */
function extractKeywords(productName) {
  const keywords = [];
  
  // 基本的なキーワード抽出ロジック
  const words = productName.split(/[\s\-_\+\/]+/);
  
  // ブランド名パターン
  const brands = ['LOUIS VUITTON', 'ルイヴィトン', 'CHANEL', 'シャネル', 'HERMES', 'エルメス', 'GUCCI', 'グッチ', 'PRADA', 'プラダ'];
  const brandMatch = brands.find(brand => productName.toUpperCase().includes(brand.toUpperCase()));
  
  // 商品カテゴリパターン
  const categories = ['バッグ', 'bag', '財布', 'wallet', '時計', 'watch', 'iPhone', 'iPad'];
  const categoryMatch = categories.find(category => productName.toLowerCase().includes(category.toLowerCase()));
  
  // ブランド + カテゴリの組み合わせ
  if (brandMatch && categoryMatch) {
    keywords.push(`${brandMatch} ${categoryMatch}`);
  }
  
  // 型番らしきパターン（英数字の組み合わせ）
  const modelPattern = /[A-Z0-9]{3,}/g;
  const models = productName.match(modelPattern);
  if (models) {
    keywords.push(...models);
  }
  
  // 重要な単語（3文字以上）
  const importantWords = words.filter(word => 
    word.length >= 3 && 
    !['the', 'and', 'for', 'with'].includes(word.toLowerCase())
  );
  
  keywords.push(...importantWords.slice(0, 2)); // 最大2つまで
  
  // 重複除去
  return [...new Set(keywords)].slice(0, 3); // 最大3つのキーワード
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
    
    // 類似商品検索（データが少ない場合のみ）
    let similarProducts = [];
    if (result.count < 5) {
      console.log('📊 データ件数が少ないため類似商品を検索');
      try {
        similarProducts = await searchSimilarProducts(modelNumber);
      } catch (error) {
        console.log('⚠️ 類似商品検索をスキップ:', error.message);
      }
    }
    
    // 仕入れ判定を追加（手数料・消費税込み）
    const judgment = evaluatePurchase(auctionPrice, result.avgPrice, result.count);
    
    // 原価計算詳細（修正版）
    const handlingFee = Math.round(auctionPrice * 0.05); // 手数料5%
    const subtotal = auctionPrice + handlingFee;
    const consumptionTax = Math.round(subtotal * 0.10); // 消費税10%
    const totalCost = subtotal + consumptionTax; // 正しい総原価計算
    const profit = result.avgPrice - totalCost;
    const profitRate = result.avgPrice > 0 ? Math.round(((result.avgPrice - totalCost) / totalCost) * 100) : 0;
    
    return {
      ...result,
      auctionPrice,
      handlingFee,
      consumptionTax,
      totalCost,
      judgment: {
        ...judgment,
        totalCost // judgmentの中のtotalCostも更新
      },
      profit,
      profitRate,
      similarProducts
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
      message += '\n';
      message += `(メルカリShopsのみ除外)\n\n`;
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
    version: '2.2.0',
    lineBot: !!(hasLineConfig && client),
    aucfanLogin: false,
    features: [
      'japanese_support',
      'cost_calculation_with_fees',
      'mercari_yahoo_auction_only',
      'mercari_shops_excluded_only',
      'ad_content_removal',
      'statistical_outlier_detection'
    ]
  });
});

// ルートパス
app.get('/', (req, res) => {
  res.json({ 
    message: 'オークファン相場検索API v2.2（手数料・消費税対応版）',
    status: 'running',
    improvements: [
      '✅ 日本語検索完全対応',
      '✅ 手数料5% + 消費税10%込み計算',
      '✅ メルカリ・ヤフオク限定検索',
      '✅ 広告データ完全除外',
      '✅ シンプルでわかりやすい判定'
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
  
  console.log('🔧 主要機能:');
  console.log('- 日本語商品名検索対応（文字化け解決）');
  console.log('- 手数料5% + 消費税10%込み原価計算');
  console.log('- メルカリ・ヤフオク限定（Yahoo!ショッピング除外）');
  console.log('- 広告データ（初月無料等）完全除外');
  console.log('- シンプルな色分け判定表示');
});
