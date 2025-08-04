const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');

// HTTPクライアントの設定
const client = axios.create({
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
 * @param {string} priceText 
 * @returns {number}
 */
function extractPrice(priceText) {
  if (!priceText) return 0;
  
  // 数字とカンマ以外を除去
  const numStr = priceText.replace(/[^\d,]/g, '').replace(/,/g, '');
  const price = parseInt(numStr);
  
  return isNaN(price) ? 0 : price;
}

/**
 * 文字エンコーディングを検出・変換
 * @param {Buffer} buffer 
 * @returns {string}
 */
function decodeResponse(buffer) {
  try {
    // UTF-8で試す
    const utf8Text = buffer.toString('utf8');
    // UTF-8として正しくデコードできているかチェック
    if (!utf8Text.includes('�')) {
      return utf8Text;
    }
  } catch (e) {
    // UTF-8でエラーの場合は続行
  }

  try {
    // Shift_JISで試す
    return iconv.decode(buffer, 'shift_jis');
  } catch (e) {
    // Shift_JISでもエラーの場合はEUC-JPを試す
    try {
      return iconv.decode(buffer, 'euc-jp');
    } catch (e2) {
      // 最後の手段としてUTF-8で強制変換
      return buffer.toString('utf8');
    }
  }
}

/**
 * オークファンから相場情報を取得
 * @param {string} query 検索クエリ
 * @returns {Promise<Object>} 相場情報
 */
async function scrapeAucfan(query) {
  try {
    // クエリをURLエンコード
    const encodedQuery = encodeURIComponent(query);
    
    // オークファンのURL構築
    const aucfanURL = `https://aucfan.com/search1/q-${encodedQuery}/`;
    
    console.log(`🔍 検索URL: ${aucfanURL}`);
    
    // HTTPリクエストを送信（responseTypeをarraybufferに設定）
    const response = await client.get(aucfanURL, {
      responseType: 'arraybuffer'
    });
    
    if (response.status !== 200) {
      throw new Error(`HTTPエラー: ${response.status}`);
    }
    
    // レスポンスをBufferに変換
    const buffer = Buffer.from(response.data);
    
    // 文字エンコーディングを適切に処理
    const html = decodeResponse(buffer);
    
    // Cheerioでパース
    const $ = cheerio.load(html);
    
    const results = [];
    
    // オークファンの商品アイテムを取得
    // 実際のセレクタは現在のオークファンのHTML構造に合わせて調整が必要
    $('.product-item, .item, .result-item, .l-product-list-item').each((index, element) => {
      const $item = $(element);
      
      // タイトル取得
      let title = $item.find('h3, .title, .product-title, .l-product-list-item__title').text().trim();
      if (!title) {
        title = $item.find('a').first().text().trim();
      }
      
      // 価格取得
      const priceText = $item.find('.price, .product-price, .current-price, .l-product-list-item__price').text();
      const price = extractPrice(priceText);
      
      // 日付取得
      const date = $item.find('.date, .end-date, .l-product-list-item__date').text().trim();
      
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
      
      if (title && price > 0) {
        results.push({
          title,
          price,
          date,
          url: linkURL || '',
          imageURL: imageURL || ''
        });
      }
    });
    
    // 別のセレクタパターンも試す
    if (results.length === 0) {
      $('tr, .row, .list-item').each((index, element) => {
        const $item = $(element);
        
        const title = $item.find('td a, .title a, h3 a').text().trim();
        const priceText = $item.find('td:contains("円"), .price').text();
        const price = extractPrice(priceText);
        
        if (title && price > 0) {
          results.push({
            title,
            price,
            date: '',
            url: '',
            imageURL: ''
          });
        }
      });
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
 * @param {number} currentPrice 現在価格
 * @param {number} avgPrice 平均価格
 * @param {number} maxPrice 最高価格
 * @param {number} minPrice 最低価格
 * @returns {string} 判定結果
 */
function evaluatePurchase(currentPrice, avgPrice, maxPrice, minPrice) {
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
 * @param {string} modelNumber 型番
 * @param {number} currentPrice 現在価格
 * @returns {Promise<Object>} 分析結果
 */
async function processQuery(modelNumber, currentPrice) {
  try {
    // 1秒待機（スクレイピングのマナー）
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // オークファンから相場を取得
    const result = await scrapeAucfan(modelNumber);
    
    // 仕入れ判定を追加
    const recommendation = evaluatePurchase(currentPrice, result.avgPrice, result.maxPrice, result.minPrice);
    
    // 利益率計算
    let profitRate = 0;
    if (result.avgPrice > 0) {
      profitRate = ((result.avgPrice - currentPrice) / currentPrice) * 100;
    }
    
    return {
      ...result,
      currentPrice,
      recommendation,
      profitRate: Math.round(profitRate * 10) / 10 // 小数点1桁
    };
    
  } catch (error) {
    console.error('❌ 処理エラー:', error);
    throw error;
  }
}

module.exports = {
  scrapeAucfan,
  processQuery,
  evaluatePurchase,
  extractPrice
};
