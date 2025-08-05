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
  timeout: 15000,
  maxRedirects: 3,
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
  
  const numStr = priceText.replace(/[^\d]/g, '');
  const price = parseInt(numStr);
  return isNaN(price) ? 0 : price;
}

/**
 * 文字エンコーディングを適切に処理（日本語強化版）
 */
function decodeResponse(buffer) {
  try {
    const utf8Text = buffer.toString('utf8');
    if (!utf8Text.includes('�')) {
      return utf8Text;
    }
  } catch (e) {
    // エラーの場合は続行
  }

  try {
    const iconv = require('iconv-lite');
    const sjisText = iconv.decode(buffer, 'shift_jis');
    if (!sjisText.includes('�')) {
      return sjisText;
    }
    
    const eucText = iconv.decode(buffer, 'euc-jp');
    if (!eucText.includes('�')) {
      return eucText;
    }
    
    return sjisText;
  } catch (e) {
    return buffer.toString('utf8');
  }
}

/**
 * 日付文字列を解析して現在からの経過月数を計算
 */
function parseDate(dateText) {
  if (!dateText) return null;
  
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  
  let year, month, day;
  
  const patterns = [
    /(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/,
    /(\d{1,2})[-\/](\d{1,2})/,
    /(\d{1,2})月(\d{1,2})日/,
    /(\d{4})年(\d{1,2})月(\d{1,2})日/,
    /(\d{4})年(\d{1,2})月/,
    /(\d{1,2})月/
  ];
  
  for (const pattern of patterns) {
    const match = dateText.match(pattern);
    if (match) {
      if (pattern.source.includes('\\d{4}')) {
        if (match[3]) {
          year = parseInt(match[1]);
          month = parseInt(match[2]);
          day = parseInt(match[3]);
        } else {
          year = parseInt(match[1]);
          month = parseInt(match[2]);
          day = 1;
        }
      } else {
        year = currentYear;
        if (match[2]) {
          month = parseInt(match[1]);
          day = parseInt(match[2]);
        } else {
          month = parseInt(match[1]);
          day = 1;
        }
      }
      break;
    }
  }
  
  if (year && month) {
    const date = new Date(year, month - 1, day || 1);
    const monthsAgo = (currentYear - year) * 12 + (currentMonth - month);
    return { date, monthsAgo };
  }
  
  return null;
}

/**
 * 価格データから異常値・広告データを除外し、直近1年のデータに限定
 */
function filterValidPrices(results) {
  if (results.length === 0) return results;
  
  console.log(`🧹 フィルタリング開始: ${results.length}件`);
  
  // 1. まず明らかに広告や無関係な価格を除外
  let filtered = results.filter(item => {
    const price = item.price;
    const title = item.title.toLowerCase();
    
    const adKeywords = [
      '初月無料', '月額', 'プレミアム', '会員', '登録', '2200円', '998円',
      '入会', 'オークファン', 'aucfan', '無料', 'free', '円/税込',
      'プラン', 'サービス', '利用', 'アップグレード', '課金', '支払い'
    ];
    
    const hasAdKeyword = adKeywords.some(keyword => title.includes(keyword));
    const isTooLowPrice = price < 300;
    
    if (hasAdKeyword || isTooLowPrice) {
      console.log(`🚫 除外: ${title} (${price}円) - ${hasAdKeyword ? '広告キーワード' : '低価格'}検出`);
      return false;
    }
    
    return true;
  });
  
  console.log(`🧹 広告フィルタ: ${results.length}件 → ${filtered.length}件`);
  
  // 2. 直近1年のデータに限定
  const oneYearAgo = 12;
  const recentResults = filtered.filter(item => {
    if (!item.date) return true;
    
    const parsedDate = parseDate(item.date);
    if (!parsedDate) return true;
    
    const isRecent = parsedDate.monthsAgo <= oneYearAgo;
    if (!isRecent) {
      console.log(`📅 古いデータ除外: ${item.title} (${parsedDate.monthsAgo}ヶ月前)`);
    }
    return isRecent;
  });
  
  console.log(`📅 直近1年フィルタ: ${filtered.length}件 → ${recentResults.length}件`);
  
  // 3. 統計的外れ値を除外
  if (recentResults.length >= 3) {
    const prices = recentResults.map(r => r.price).sort((a, b) => a - b);
    
    const q1Index = Math.floor(prices.length * 0.25);
    const q3Index = Math.floor(prices.length * 0.75);
    const q1 = prices[q1Index];
    const q3 = prices[q3Index];
    const iqr = q3 - q1;
    
    const lowerBound = Math.max(300, q1 - (iqr * 2.0));
    const upperBound = q3 + (iqr * 2.0);
    
    const finalResults = recentResults.filter(item => {
      const inRange = item.price >= lowerBound && item.price <= upperBound;
      if (!inRange) {
        console.log(`📊 統計的外れ値除外: ${item.title} (${item.price}円)`);
      }
      return inRange;
    });
    
    console.log(`📊 統計フィルタ: ${recentResults.length}件 → ${finalResults.length}件`);
    console.log(`📊 有効価格範囲: ${Math.round(lowerBound).toLocaleString()}円 〜 ${Math.round(upperBound).toLocaleString()}円`);
    
    return finalResults.length >= 3 ? finalResults : recentResults;
  }
  
  return recentResults;
}

/**
 * オークファンの検索結果HTMLを解析（メルカリ・ヤフオク限定）
 */
async function parseAucfanResults(html, query) {
  console.log(`📄 HTML長: ${html.length}文字`);
  
  const $ = cheerio.load(html);
  const results = [];
  
  // HTML構造の詳細分析
  console.log('🔍 HTML構造詳細分析:');
  
  const tables = $('table');
  console.log(`📊 テーブル数: ${tables.length}`);
  
  tables.each((index, table) => {
    const $table = $(table);
    const rows = $table.find('tr');
    console.log(`📊 テーブル${index + 1}: ${rows.length}行`);
    
    if (rows.length > 0) {
      rows.slice(0, 3).each((rowIndex, row) => {
        const $row = $(row);
        const cells = $row.find('td, th');
        console.log(`  行${rowIndex + 1}: ${cells.length}セル - "${$row.text().trim().substring(0, 100)}..."`);
      });
    }
  });
  
  // クラス名のパターンを調査
  const allElements = $('*[class]');
  const classNames = new Set();
  allElements.each((index, element) => {
    const classes = $(element).attr('class');
    if (classes) {
      classes.split(' ').forEach(cls => {
        if (cls.length > 0) classNames.add(cls);
      });
    }
  });
  
  const relevantClasses = Array.from(classNames).filter(cls => 
    cls.includes('product') || 
    cls.includes('item') || 
    cls.includes('result') || 
    cls.includes('list') ||
    cls.includes('auction') ||
    cls.includes('search')
  );
  console.log('🎯 関連するクラス名:', relevantClasses.slice(0, 20));
  
  // プラットフォーム検出のデバッグ
  const mercariElements = $('*:contains("メルカリ")');
  const yahooElements = $('*:contains("ヤフオク"), *:contains("Yahoo")');
  const priceElements = $('*:contains("円")');
  
  console.log(`📱 プラットフォーム検出: メルカリ${mercariElements.length}要素, ヤフオク${yahooElements.length}要素`);
  console.log(`💰 価格要素: ${priceElements.length}要素`);
  console.log(`🔗 リンク数: ${$('a').length}`);
  
  if (mercariElements.length > 0) {
    console.log('📱 メルカリ要素サンプル:');
    mercariElements.slice(0, 3).each((index, element) => {
      const $el = $(element);
      const tagName = element.tagName.toLowerCase();
      const className = $el.attr('class') || 'no-class';
      console.log(`  ${index + 1}. <${tagName} class="${className}"> "${$el.text().trim().substring(0, 80)}..."`);
    });
  }
  
  if (yahooElements.length > 0) {
    console.log('📱 ヤフオク要素サンプル:');
    yahooElements.slice(0, 3).each((index, element) => {
      const $el = $(element);
      const tagName = element.tagName.toLowerCase();
      const className = $el.attr('class') || 'no-class';
      console.log(`  ${index + 1}. <${tagName} class="${className}"> "${$el.text().trim().substring(0, 80)}..."`);
    });
  }
  
  // セレクタパターン
  const selectors = [
    'table.item_list tr',
    'table[class*="list"] tr',
    'table[class*="result"] tr',
    'table[class*="product"] tr',
    'table tr',
    '.product-list-item',
    '.search-result-item',
    '.auction-item',
    '.item-row',
    '.result-row',
    '[data-testid*="item"]',
    '[data-testid*="product"]',
    '[data-testid*="result"]',
    '.productlist-item',
    '.productlist-price',
    '.search-result',
    '.result-list tr',
    '.js-product',
    '.js-item',
    '.product-item',
    '.item-data',
    '.result-item',
    '.l-product-list-item',
    '.product-box',
    '.item-box',
    '.result-product-item',
    '.search-item',
    '.auction-result',
    'div[class*="item"]',
    'div[class*="product"]',
    'div[class*="result"]',
    'li[class*="item"]',
    'li[class*="product"]'
  ];
  
  // セレクタで試行
  for (const selector of selectors) {
    console.log(`🔍 セレクタ試行: ${selector}`);
    
    const elements = $(selector);
    console.log(`  - 要素数: ${elements.length}`);
    
    if (elements.length === 0) continue;
    
    elements.slice(0, 3).each((sampleIndex, sampleElement) => {
      const $sample = $(sampleElement);
      const sampleText = $sample.text().trim().substring(0, 100);
      console.log(`  サンプル${sampleIndex + 1}: "${sampleText}..."`);
    });
    
    elements.each((index, element) => {
      if (results.length >= 200) return false;
      
      const $item = $(element);
      const itemText = $item.text();
      const itemHtml = $item.html() || '';
      
      // テーブル行の場合、ヘッダー行をスキップ
      if (element.tagName.toLowerCase() === 'tr') {
        const firstCell = $item.find('td, th').first();
        if (firstCell.length === 0 || firstCell.is('th')) {
          return true;
        }
      }
      
      // プラットフォーム判定
      const containsMercari = (itemText.includes('メルカリ') || 
                             itemHtml.includes('mercari') || 
                             itemHtml.includes('メルカリ') ||
                             $item.find('*').text().includes('メルカリ')) &&
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
      
      const containsShopping = itemText.includes('ショッピング') ||
                              itemHtml.includes('shopping') ||
                              itemHtml.includes('ショッピング');
      
      if ((!containsMercari && !containsYahoo) || containsShopping) {
        return true;
      }
      
      // タイトル取得
      let title = '';
      
      if (element.tagName.toLowerCase() === 'tr') {
        const cells = $item.find('td');
        
        cells.each((cellIndex, cell) => {
          const $cell = $(cell);
          const cellText = $cell.text().trim();
          const cellLink = $cell.find('a').text().trim();
          
          if (cellLink && cellLink.length > 10 && cellLink.length < 200) {
            title = cellLink;
            return false;
          } else if (cellText && cellText.length > 10 && cellText.length < 200 && 
                    !cellText.match(/^\d+[円,]/) && 
                    !cellText.match(/^\d{4}[-\/]\d{1,2}[-\/]\d{1,2}/) && 
                    !cellText.match(/^(メルカリ|ヤフオク|Yahoo)$/)) {
            title = cellText;
            return false;
          }
        });
      }
      
      if (!title) {
        const titleCandidates = [
          $item.find('a').first().text().trim(),
          $item.find('.title, .product-title, .item-title').text().trim(),
          $item.find('h3, h4, h5').text().trim(),
          $item.text().trim()
        ];
        
        for (const candidate of titleCandidates) {
          if (candidate && candidate.length > 10 && candidate.length < 200) {
            title = candidate;
            break;
          }
        }
      }
      
      // 価格取得
      let price = 0;
      
      if (element.tagName.toLowerCase() === 'tr') {
        const cells = $item.find('td');
        cells.each((cellIndex, cell) => {
          const $cell = $(cell);
          const cellText = $cell.text();
          
          if (cellText.includes('円')) {
            const matches = cellText.match(/(\d{1,3}(?:,\d{3})*|\d+)円/g);
            if (matches) {
              for (const match of matches) {
                const extractedPrice = extractPrice(match);
                if (extractedPrice > 300 && extractedPrice < 10000000) {
                  price = extractedPrice;
                  return false;
                }
              }
            }
          }
        });
      }
      
      if (price === 0) {
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
                if (extractedPrice > 300 && extractedPrice < 10000000) {
                  price = extractedPrice;
                  break;
                }
              }
              if (price > 0) break;
            }
          }
        }
      }
      
      // 日付取得
      let date = '';
      const dateText = $item.text();
      const datePatterns = [
        /(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})/,
        /(\d{1,2}[-\/]\d{1,2})/,
        /(\d{1,2}月\d{1,2}日)/,
        /(\d{4}年\d{1,2}月\d{1,2}日)/,
        /(\d{4}年\d{1,2}月)/,
        /(\d{1,2}月)/
      ];
      
      for (const pattern of datePatterns) {
        const dateMatch = dateText.match(pattern);
        if (dateMatch) {
          date = dateMatch[1];
          break;
        }
      }
      
      // URL取得
      let linkURL = $item.find('a').first().attr('href');
      if (linkURL && !linkURL.startsWith('http')) {
        linkURL = 'https://aucfan.com' + linkURL;
      }
      
      const platform = containsMercari ? 'メルカリ' : 'ヤフオク';
      
      if (title && title.length > 5 && price > 300) {
        if (results.length < 10) {
          console.log(`📝 データ抽出成功 ${results.length + 1}: ${platform} - ${title.substring(0, 30)}... - ${price}円 - ${date} - セレクタ: ${selector}`);
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
  
  // フォールバック1: テーブル構造の詳細解析
  if (results.length === 0) {
    console.log('🔄 フォールバック1: テーブル構造の詳細解析');
    
    const allTables = $('table');
    allTables.each((tableIndex, table) => {
      const $table = $(table);
      const rows = $table.find('tr');
      
      console.log(`📊 テーブル${tableIndex + 1}を解析中: ${rows.length}行`);
      
      rows.each((rowIndex, row) => {
        if (results.length >= 100) return false;
        
        const $row = $(row);
        const cells = $row.find('td');
        
        if (cells.length === 0) return true;
        
        const rowText = $row.text();
        
        const containsMercari = rowText.includes('メルカリ') && !rowText.includes('メルカリShops');
        const containsYahoo = (rowText.includes('ヤフオク') || rowText.includes('Yahoo')) && !rowText.includes('ショッピング');
        
        if (!containsMercari && !containsYahoo) return true;
        
        let price = 0;
        const priceMatches = rowText.match(/(\d{1,3}(?:,\d{3})*|\d+)円/g);
        if (priceMatches) {
          for (const match of priceMatches) {
            const extractedPrice = extractPrice(match);
            if (extractedPrice > 300 && extractedPrice < 10000000) {
              price = extractedPrice;
              break;
            }
          }
        }
        
        if (price === 0) return true;
        
        let title = '';
        cells.each((cellIndex, cell) => {
          const $cell = $(cell);
          const cellText = $cell.text().trim();
          const cellLink = $cell.find('a').text().trim();
          
          if (cellLink && cellLink.length > 10 && cellLink.length < 200) {
            title = cellLink;
            return false;
          } else if (cellText && cellText.length > 10 && cellText.length < 200 && 
                    !cellText.match(/^\d+[円,]/) && !cellText.match(/^\d{4}[-\/]/) &&
                    !cellText.match(/^(メルカリ|ヤフオク|Yahoo)$/)) {
            title = cellText;
            return false;
          }
        });
        
        if (title) {
          const platform = containsMercari ? 'メルカリ' : 'ヤフオク';
          
          console.log(`📝 フォールバック1取得: ${platform} - ${title.substring(0, 30)}... - ${price}円`);
          
          results.push({
            title: title.substring(0, 100),
            price,
            date: '',
            url: '',
            imageURL: '',
            platform
          });
        }
      });
    });
  }
  
  // フォールバック2: 全要素検索
  if (results.length === 0) {
    console.log('🔄 フォールバック2: 全要素検索（最終手段）');
    
    $('*:contains("メルカリ"), *:contains("ヤフオク"), *:contains("Yahoo")').each((index, element) => {
      if (results.length >= 50) return false;
      
      const $el = $(element);
      const text = $el.text();
      
      if (text.includes('ショッピング') || 
          text.includes('メルカリShops') || 
          text.includes('メルカリshops') ||
          text.toLowerCase().includes('mercari shops')) return true;
      
      if (!text.includes('円')) return true;
      
      const priceMatches = text.match(/(\d{1,3}(?:,\d{3})*|\d+)円/g);
      if (!priceMatches) return true;
      
      for (const priceMatch of priceMatches) {
        const price = extractPrice(priceMatch);
        if (price > 300 && price < 10000000) {
          
          let title = '';
          const parent = $el.parent();
          const grandParent = parent.parent();
          
          const titleCandidates = [
            $el.find('a').text().trim(),
            parent.find('a').text().trim(),
            grandParent.find('a').text().trim(),
            $el.text().trim(),
            parent.text().trim()
          ];
          
          for (const candidate of titleCandidates) {
            if (candidate && 
                candidate.length > 10 && 
                candidate.length < 200 &&
                !candidate.match(/^\d+[円,]/) && 
                !candidate.match(/^(メルカリ|ヤフオク|Yahoo)$/) && 
                !candidate.includes('初月無料') &&
                !candidate.includes('プレミアム')) {
              title = candidate;
              break;
            }
          }
          
          if (title) {
            const platform = text.includes('メルカリ') ? 'メルカリ' : 'ヤフオク';
            
            console.log(`📝 フォールバック2取得: ${platform} - ${title.substring(0, 30)}... - ${price}円`);
            
            results.push({
              title: title.substring(0, 100),
              price,
              date: '',
              url: '',
              imageURL: '',
              platform
            });
            
            break;
          }
        }
      }
    });
  }
  
  console.log(`✅ 総取得件数: ${results.length}件（フィルタ前）`);
  
  if (results.length === 0) {
    console.log('❌ データ抽出に失敗しました。詳細分析:');
    
    const htmlSample = html.substring(0, 2000);
    console.log('📄 HTMLサンプル（最初の2000文字）:');
    console.log(htmlSample);
    
    const lines = html.split('\n');
    const relevantLines = lines.filter(line => 
      line.includes('メルカリ') || 
      line.includes('ヤフオク') || 
      line.includes('Yahoo')
    ).slice(0, 10);
    
    console.log('🔍 関連する行（最大10行）:');
    relevantLines.forEach((line, index) => {
      console.log(`${index + 1}: ${line.trim().substring(0, 150)}...`);
    });
  } else {
    const mercariCount = results.filter(r => r.platform === 'メルカリ').length;
    const yahooCount = results.filter(r => r.platform === 'ヤフオク').length;
    console.log(`📊 抽出サマリー: メルカリ${mercariCount}件, ヤフオク${yahooCount}件`);
  }
  
  const filteredResults = filterValidPrices(results);
  
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
 * オークファンから相場情報を取得
 */
async function scrapeAucfan(query) {
  try {
    console.log(`🔍 検索開始: ${query}`);
    
    let encodedQuery;
    if (/[ひらがなカタカナ漢字]/.test(query)) {
      console.log(`🔤 日本語クエリ検出: ${query}`);
      encodedQuery = encodeURIComponent(query);
      console.log(`📝 エンコード結果: ${encodedQuery}`);
    } else {
      encodedQuery = encodeURIComponent(query);
    }
    
    const aucfanURL = `https://aucfan.com/search1/q-${encodedQuery}/`;
    console.log(`📍 URL: ${aucfanURL}`);
    
    const response = await httpClient.get(aucfanURL, {
      responseType: 'arraybuffer',
      maxRedirects: 3,
      timeout: 15000,
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
    
    const buffer = Buffer.from(response.data);
    const html = decodeResponse(buffer);
    
    console.log(`📄 HTML長: ${html.length}文字`);
    
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
    
    if (error.message.includes('redirect')) {
      console.log('🔄 リダイレクト回避で再試行');
      try {
        const simpleURL = `https://aucfan.com/search1/q-${encodeURIComponent(query)}/`;
        const response = await httpClient.get(simpleURL, {
          responseType: 'arraybuffer',
          maxRedirects: 0,
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
    
    if (error.response) {
      console.error('- レスポンスステータス:', error.response.status);
    }
    
    throw new Error(`オークファンの相場取得に失敗しました: ${error.message}`);
  }
}

/**
 * 仕入れ判定を行う
 */
function evaluatePurchase(auctionPrice, avgPrice, count) {
  if (avgPrice === 0 || count === 0) {
    return {
      emoji: "❌",
      decision: "判定不可",
      reason: "相場データなし",
      totalCost: auctionPrice
    };
  }
  
  if (count < 3) {
    return {
      emoji: "⚠️",
      decision: "判定困難", 
      reason: `データ不足（${count}件のみ）`,
      totalCost: Math.round(auctionPrice * 1.155)
    };
  }
  
  const totalCost = Math.round(auctionPrice * 1.155);
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
 * 商品名から類似商品も検索
 */
async function searchSimilarProducts(originalQuery) {
  console.log(`🔄 類似商品検索: ${originalQuery}`);
  
  const similarResults = [];
  const keywords = extractKeywords(originalQuery);
  
  for (const keyword of keywords) {
    if (keyword === originalQuery) continue;
    
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
  const words = productName.split(/[\s\-_\+\/]+/);
  
  const brands = ['LOUIS VUITTON', 'ルイヴィトン', 'CHANEL', 'シャネル', 'HERMES', 'エルメス', 'GUCCI', 'グッチ', 'PRADA', 'プラダ'];
  const brandMatch = brands.find(brand => productName.toUpperCase().includes(brand.toUpperCase()));
  
  const categories = ['バッグ', 'bag', '財布', 'wallet', '時計', 'watch', 'iPhone', 'iPad'];
  const categoryMatch = categories.find(category => productName.toLowerCase().includes(category.toLowerCase()));
  
  if (brandMatch && categoryMatch) {
    keywords.push(`${brandMatch} ${categoryMatch}`);
  }
  
  const modelPattern = /[A-Z0-9]{3,}/g;
  const models = productName.match(modelPattern);
  if (models) {
    keywords.push(...models);
  }
  
  const importantWords = words.filter(word => 
    word.length >= 3 && 
    !['the', 'and', 'for', 'with'].includes(word.toLowerCase())
  );
  
  keywords.push(...importantWords.slice(0, 2));
  
  return [...new Set(keywords)].slice(0, 3);
}

/**
 * メイン処理関数
 */
async function processQuery(modelNumber, auctionPrice) {
  try {
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const result = await scrapeAucfan(modelNumber);
    
    let similarProducts = [];
    if (result.count < 5) {
      console.log('📊 データ件数が少ないため類似商品を検索');
      try {
        similarProducts = await searchSimilarProducts(modelNumber);
      } catch (error) {
        console.log('⚠️ 類似商品検索をスキップ:', error.message);
      }
    }
    
    const judgment = evaluatePurchase(auctionPrice, result.avgPrice, result.count);
    
    const handlingFee = Math.round(auctionPrice * 0.05);
    const subtotal = auctionPrice + handlingFee;
    const consumptionTax = Math.round(subtotal * 0.10);
    const totalCost = subtotal + consumptionTax;
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
        totalCost
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
  function parseMessage(message) {
    const lines = message.trim().split('\n').map(line => line.trim());
    
    let modelNumber = '';
    let price = 0;
    
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

  function formatResultMessage(result) {
    if (result.count === 0) {
      return `❌ 「${result.query}」の相場が見つかりません\n\n💡 型番を英数字で入力してみてください`;
    }
    
    const { judgment } = result;
    
    let message = `${judgment.emoji} ${judgment.decision}\n`;
    message += `${judgment.reason}\n\n`;
    
    message += `📊 【${result.query}】\n`;
    message += `💰 平均相場: ${result.avgPrice.toLocaleString()}円\n\n`;
    
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
    
    const mercariCount = result.results.filter(r => r.platform === 'メルカリ').length;
    const yahooCount = result.results.filter(r => r.platform === 'ヤフオク').length;
    
    if (mercariCount > 0 || yahooCount > 0) {
      message += `📱 内訳: `;
      if (mercariCount > 0) message += `メルカリ${mercariCount}件 `;
      if (yahooCount > 0) message += `ヤフオク${yahooCount}件`;
      message += '\n';
      message += `(直近1年・メルカリShopsは除外)\n\n`;
    }
    
    if (result.results.length > 0) {
      message += '📋 最近の取引:\n';
      const maxDisplay = Math.min(3, result.results.length);
      
      for (let i = 0; i < maxDisplay; i++) {
        const auction = result.results[i];
        let shortTitle = auction.title;
        if (shortTitle.length > 25) {
          shortTitle = shortTitle.substring(0, 25) + '...';
        }
        const dateInfo = auction.date ? ` (${auction.date})` : '';
        message += `${auction.platform}: ${auction.price.toLocaleString()}円${dateInfo}\n`;
      }
    }
    
    return message;
  }

  async function handleTextMessage(event) {
    const messageText = event.message.text;
    const userId = event.source.userId;
    
    try {
      await client.replyMessage(event.replyToken, {
        type: 'text',
        text: '🔍 相場検索中...\n(メルカリ・ヤフオク直近1年)'
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
      
      console.log(`✅ 検索完了: ${parseResult.modelNumber} (${result.count}件取得)`);
      
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

  async function handleEvent(event) {
    if (event.type !== 'message' || event.message.type !== 'text') {
      return Promise.resolve(null);
    }
    
    return handleTextMessage(event);
  }

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
    version: '2.3.0',
    lineBot: !!(hasLineConfig && client),
    aucfanLogin: false,
    features: [
      'japanese_support',
      'cost_calculation_with_fees',
      'mercari_yahoo_auction_only',
      'mercari_shops_excluded_only',
      'ad_content_removal',
      'statistical_outlier_detection_relaxed',
      'one_year_data_only',
      'no_20_item_limit'
    ]
  });
});

// ルートパス
app.get('/', (req, res) => {
  res.json({ 
    message: 'オークファン相場検索API v2.3（直近1年データ対応版）',
    status: 'running',
    improvements: [
      '✅ 日本語検索完全対応',
      '✅ 手数料5% + 消費税10%込み計算',
      '✅ メルカリ・ヤフオク限定検索',
      '✅ 直近1年のデータのみ使用',
      '✅ 20件制限を撤廃してより多くのデータを活用',
      '✅ 統計的外れ値除去を緩和してデータ件数を確保',
      '✅ 広告データ完全除外'
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
  console.log('- 直近1年データのみ使用（古いデータ除外）');
  console.log('- 20件制限撤廃でより多くのデータを活用');
  console.log('- 統計的外れ値除去を緩和（2.0倍に変更）');
  console.log('- 広告データ（初月無料等）完全除外');
});
