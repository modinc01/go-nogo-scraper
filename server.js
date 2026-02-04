require('dotenv').config();
const express = require('express');
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

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
              console.log('⚠️ LINE SDK not found');
      }
}

let browserInstance = null;

async function getBrowser() {
      if (!browserInstance) {
              console.log('🚀 Puppeteerブラウザを起動中...');
              browserInstance = await puppeteer.launch({
                        headless: true,
                        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
              });
              console.log('✅ Puppeteerブラウザ起動完了');
      }
      return browserInstance;
}

function extractPrice(priceText) {
      if (!priceText) return 0;
      const numStr = priceText.replace(/[^\d]/g, '');
      const price = parseInt(numStr);
      return isNaN(price) ? 0 : price;
}

async function scrapeAucfanWithPuppeteer(query) {
      const browser = await getBrowser();
      const page = await browser.newPage();
      
      try {
              console.log(`🔍 検索開始: ${query}`);
              await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
              
              const url = `https://aucfan.com/search1/q-${encodeURIComponent(query)}/s-mix/`;
              console.log(`📍 URL: ${url}`);
              
              await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
              
              try {
                        await page.waitForSelector('a[href*="mercari"], a[href*="yahoo"]', { timeout: 10000 });
                        console.log('✅ 商品データ読み込み完了');
              } catch (e) {
                        console.log('⚠️ 商品データが見つかりません');
              }
              
              const html = await page.content();
              const $ = cheerio.load(html);
              const results = [];
              
              $('a[href*="mercari"]').each((index, element) => {
                        const $link = $(element);
                        const $parent = $link.closest('div, li, article');
                        const title = $link.text().trim() || $parent.find('h3, h4').text().trim();
                        const priceText = $parent.text().match(/(\d{1,3}(?:,\d{3})*|\d+)\s*円/);
                        
                        if (title && priceText) {
                                    const price = extractPrice(priceText[0]);
                                    if (price > 300 && title.length > 5) {
                                                  results.push({ title: title.substring(0, 100), price, platform: 'メルカリ' });
                                    }
                        }
              });
              
              $('a[href*="yahoo"][href*="auction"]').each((index, element) => {
                        const $link = $(element);
                        const $parent = $link.closest('div, li, article');
                        const title = $link.text().trim() || $parent.find('h3, h4').text().trim();
                        const priceText = $parent.text().match(/(\d{1,3}(?:,\d{3})*|\d+)\s*円/);
                        
                        if (title && priceText && !title.includes('ショッピング')) {
                                    const price = extractPrice(priceText[0]);
                                    if (price > 300 && title.length > 5) {
                                                  results.push({ title: title.substring(0, 100), price, platform: 'ヤフオク' });
                                    }
                        }
              });
              
              console.log(`✅ 総取得件数: ${results.length}件`);
              
              let avgPrice = 0, maxPrice = 0, minPrice = 0;
              if (results.length > 0) {
                        const prices = results.map(r => r.price);
                        avgPrice = Math.round(prices.reduce((sum, p) => sum + p, 0) / prices.length);
                        maxPrice = Math.max(...prices);
                        minPrice = Math.min(...prices);
              }
              
              return { query, results, count: results.length, avgPrice, maxPrice, minPrice };
              
      } catch (error) {
              console.error('❌ スクレイピングエラー:', error.message);
              throw error;
      } finally {
              await page.close();
      }
}

function evaluatePurchase(auctionPrice, avgPrice, count) {
      if (avgPrice === 0 || count === 0) {
              return { emoji: "❌", decision: "判定不可", reason: "相場データなし" };
      }
      if (count < 3) {
              return { emoji: "⚠️", decision: "判定困難", reason: `データ不足（${count}件のみ）` };
      }
      
      const totalCost = Math.round(auctionPrice * 1.155);
      const profit = avgPrice - totalCost;
      const profitRate = Math.round((profit / totalCost) * 100);
      
      if (profitRate >= 50) return { emoji: "🟢", decision: "仕入れ推奨", reason: `利益率+${profitRate}%`, totalCost };
      else if (profitRate >= 20) return { emoji: "🟡", decision: "仕入れ検討", reason: `利益率+${profitRate}%`, totalCost };
      else if (profitRate >= 0) return { emoji: "🟠", decision: "慎重検討", reason: `利益率+${profitRate}%`, totalCost };
      else return { emoji: "🔴", decision: "仕入れNG", reason: `損失${Math.abs(profitRate)}%`, totalCost };
}

async function processQuery(modelNumber, auctionPrice) {
      try {
              const result = await scrapeAucfanWithPuppeteer(modelNumber);
              const judgment = evaluatePurchase(auctionPrice, result.avgPrice, result.count);
              const handlingFee = Math.round(auctionPrice * 0.05);
              const totalCost = Math.round(auctionPrice * 1.155);
              const profit = result.avgPrice - totalCost;
              
              return { ...result, auctionPrice, handlingFee, totalCost, judgment, profit };
      } catch (error) {
              console.error('❌ 処理エラー:', error);
              throw error;
      }
}

if (hasLineConfig && line && client) {
      app.use('/webhook', line.middleware({
              channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
              channelSecret: process.env.LINE_CHANNEL_SECRET,
      }));
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.post('/api/search', async (req, res) => {
      try {
              const { modelNumber, auctionPrice } = req.body;
              if (!modelNumber || !auctionPrice) {
                        return res.status(400).json({ error: '型番とオークション価格を指定してください' });
              }
              const result = await processQuery(modelNumber, parseInt(auctionPrice));
              res.json(result);
      } catch (error) {
              res.status(500).json({ error: error.message });
      }
});

if (hasLineConfig && line && client) {
      function parseMessage(message) {
              const lines = message.trim().split('\n');
              let modelNumber = lines[0] || '';
              let price = 0;
              if (lines.length >= 2) {
                        const priceMatch = lines[1].match(/([0-9,]+)/);
                        if (priceMatch) price = parseInt(priceMatch[1].replace(/,/g, ''));
              }
              if (!modelNumber) return { error: '型番が見つかりません' };
              if (price === 0) return { error: 'オークション価格が見つかりません' };
              return { modelNumber, price };
      }
    
      async function handleTextMessage(event) {
              const userId = event.source.userId;
              try {
                        await client.replyMessage(event.replyToken, {
                                    type: 'text',
                                    text: '🔍 相場検索中...'
                        });
                        
                        const parseResult = parseMessage(event.message.text);
                        if (parseResult.error) {
                                    await client.pushMessage(userId, { type: 'text', text: `❌ ${parseResult.error}` });
                                    return;
                        }
                        
                        const result = await processQuery(parseResult.modelNumber, parseResult.price);
                        let msg = `${result.judgment.emoji} ${result.judgment.decision}\n${result.judgment.reason}\n\n`;
                        msg += `📊 【${result.query}】\n💰 平均相場: ${result.avgPrice.toLocaleString()}円\n`;
                        msg += `💵 オークション価格: ${result.auctionPrice.toLocaleString()}円\n`;
                        msg += `💼 総原価: ${result.totalCost.toLocaleString()}円\n`;
                        msg += `📈 検索結果: ${result.count}件\n`;
                        
                        await client.pushMessage(userId, { type: 'text', text: msg });
              } catch (error) {
                        console.error('❌ エラー:', error);
                        await client.pushMessage(userId, { type: 'text', text: '❌ 処理中にエラーが発生しました' });
              }
      }
    
      app.post('/webhook', (req, res) => {
              Promise.all(req.body.events.map(event => {
                        if (event.type === 'message' && event.message.type === 'text') {
                                    return handleTextMessage(event);
                        }
                        return Promise.resolve(null);
              })).then(() => res.json({})).catch((err) => res.status(500).end());
      });
}

app.get('/health', (req, res) => {
      res.json({ status: 'ok', version: '2.0.0-puppeteer' });
});

app.get('/', (req, res) => {
      res.json({ message: 'オークファン相場検索API v2.0 - Puppeteer版', status: 'running' });
});

app.listen(PORT, async () => {
      console.log(`🚀 サーバー起動: http://localhost:${PORT}`);
      try {
              await getBrowser();
              console.log('✅ Puppeteerブラウザ準備完了');
      } catch (error) {
              console.error('❌ Puppeteerブラウザ起動失敗:', error.message);
      }
});

process.on('SIGINT', async () => {
      if (browserInstance) await browserInstance.close();
      process.exit(0);
});require('dotenv').config();const express=require('express');const puppeteer=require('puppeteer');const cheerio=require('cheerio');const app=express();const PORT=process.env.PORT||3000;let line,client;const hasLineConfig=process.env.LINE_CHANNEL_SECRET&&process.env.LINE_CHANNEL_ACCESS_TOKEN;require('dotenv').config();
const express = require('express');
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

// LINE Bot関連の設定
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
}

// Puppeteerブラウザインスタンス（再利用のため）
let browserInstance = null;

/**
 * Puppeteerブラウザを取得（再利用）
 */
async function getBrowser() {
    if (!browserInstance) {
          console.log('🚀 Puppeteerブラウザを起動中...');
          browserInstance = await puppeteer.launch({
                  headless: true,
                  args: [
                            '--no-sandbox',
                            '--disable-setuid-sandbox',
                            '--disable-dev-shm-usage',
                            '--disable-gpu',
                            '--no-first-run',
                            '--no-zygote',
                            '--single-process',
                            '--disable-extensions'
                          ]
          });
          console.log('✅ Puppeteerブラウザ起動完了');
    }
    return browserInstance;
}

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
 * 日付文字列を解析して経過月数を計算
 */
function parseDate(dateText) {
    if (!dateText) return null;

  const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;

  const patterns = [
        /(\d{4})年(\d{1,2})月(\d{1,2})日/,
        /(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/,
        /(\d{1,2})月(\d{1,2})日/,
        /(\d{4})年(\d{1,2})月/
      ];

  for (const pattern of patterns) {
        const match = dateText.match(pattern);
        if (match) {
                let year, month;
                if (pattern.source.includes('\\d{4}')) {
                          year = parseInt(match[1]);
                          month = parseInt(match[2]);
                } else {
                          year = currentYear;
                          month = parseInt(match[1]);
                }

          const monthsAgo = (currentYear - year) * 12 + (currentMonth - month);
                return { monthsAgo };
        }
  }

  return null;
}

/**
 * 価格データから異常値を除外
 */
function filterValidPrices(results) {
    if (results.length === 0) return results;

  console.log(`🧹 フィルタリング開始: ${results.length}件`);

  // 1. 広告・無関係データを除外
  const adKeywords = [
        '初月無料', '月額', 'プレミアム', '会員', '登録', '2200円', '998円',
        '入会', 'オークファン', 'aucfan'
      ];

  let filtered = results.filter(item => {
        const title = item.title.toLowerCase();
        const hasAdKeyword = adKeywords.some(keyword => title.includes(keyword));
        const isTooLowPrice = item.price < 300;

                                    if (hasAdKeyword || isTooLowPrice) {
                                            console.log(`🚫 除外: ${item.title} (${item.price}円)`);
                                            return false;
                                    }
        return true;
  });

  console.log(`🧹 広告フィルタ: ${results.length}件 → ${filtered.length}件`);

  // 2. 直近1年のデータに限定
  const recentResults = filtered.filter(item => {
        if (!item.date) return true;
        const parsedDate = parseDate(item.date);
        if (!parsedDate) return true;

                                            const isRecent = parsedDate.monthsAgo <= 12;
        if (!isRecent) {
                console.log(`📅 古いデータ除外: ${item.title} (${parsedDate.monthsAgo}ヶ月前)`);
        }
        return isRecent;
  });

  console.log(`📅 直近1年フィルタ: ${filtered.length}件 → ${recentResults.length}件`);

  // 3. 統計的外れ値を除外（緩め）
  if (recentResults.length >= 3) {
        const prices = recentResults.map(r => r.price).sort((a, b) => a - b);
        const q1 = prices[Math.floor(prices.length * 0.25)];
        const q3 = prices[Math.floor(prices.length * 0.75)];
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
        return finalResults.length >= 3 ? finalResults : recentResults;
  }

  return recentResults;
}

/**
 * Puppeteerでオークファンをスクレイピング
 */
async function scrapeAucfanWithPuppeteer(query) {
    const browser = await getBrowser();
    const page = await browser.newPage();

  try {
        console.log(`🔍 検索開始: ${query}`);

      // User-Agent設定
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

      const encodedQuery = encodeURIComponent(query);
        const url = `https://aucfan.com/search1/q-${encodedQuery}/s-mix/`;

      console.log(`📍 URL: ${url}`);

      // ページにアクセス
      await page.goto(url, {
              waitUntil: 'networkidle2',
              timeout: 30000
      });

      // 商品データの読み込みを待つ
      try {
              await page.waitForSelector('a[href*="mercari"], a[href*="yahoo"]', { timeout: 10000 });
              console.log('✅ 商品データ読み込み完了');
      } catch (e) {
              console.log('⚠️ 商品データが見つかりません');
      }

      // HTMLを取得
      const html = await page.content();
        console.log(`📄 HTML長: ${html.length}文字`);

      // Cheerioでパース
      const $ = cheerio.load(html);
        const results = [];

      // メルカリ商品を抽出
      $('a[href*="mercari"]').each((index, element) => {
              const $link = $(element);
              const $parent = $link.closest('div, li, article');

                                         const title = $link.text().trim() || $parent.find('h3, h4, .title').text().trim();
              const priceText = $parent.text().match(/(\d{1,3}(?:,\d{3})*|\d+)\s*円/);
              const dateText = $parent.text().match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);

                                         if (title && priceText) {
                                                   const price = extractPrice(priceText[0]);
                                                   if (price > 0 && title.length > 5) {
                                                               results.push({
                                                                             title: title.substring(0, 100),
                                                                             price,
                                                                             date: dateText ? dateText[0] : '',
                                                                             url: $link.attr('href') || '',
                                                                             platform: 'メルカリ'
                                                               });
                                                               console.log(`📝 メルカリ ${results.length}: ${title.substring(0, 30)}... - ${price}円`);
                                                   }
                                         }
      });

      // ヤフオク商品を抽出
      $('a[href*="yahoo"][href*="auction"], a[href*="auctions.yahoo"]').each((index, element) => {
              const $link = $(element);
              const $parent = $link.closest('div, li, article');

                                                                                   const title = $link.text().trim() || $parent.find('h3, h4, .title').text().trim();
              const priceText = $parent.text().match(/(\d{1,3}(?:,\d{3})*|\d+)\s*円/);
              const dateText = $parent.text().match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);

                                                                                   if (title && priceText && !title.includes('ショッピング')) {
                                                                                             const price = extractPrice(priceText[0]);
                                                                                             if (price > 0 && title.length > 5) {
                                                                                                         results.push({
                                                                                                                       title: title.substring(0, 100),
                                                                                                                       price,
                                                                                                                       date: dateText ? dateText[0] : '',
                                                                                                                       url: $link.attr('href') || '',
                                                                                                                       platform: 'ヤフオク'
                                                                                                           });
                                                                                                         console.log(`📝 ヤフオク ${results.length}: ${title.substring(0, 30)}... - ${price}円`);
                                                                                               }
                                                                                   }
      });

      console.log(`✅ 総取得件数: ${results.length}件（フィルタ前）`);

      // フィルタリング
      const filteredResults = filterValidPrices(results);

      // 統計計算
      let avgPrice = 0, maxPrice = 0, minPrice = 0;

      if (filteredResults.length > 0) {
              const prices = filteredResults.map(r => r.price);
              avgPrice = Math.round(prices.reduce((sum, p) => sum + p, 0) / prices.length);
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
              originalCount: results.length
      };

  } catch (error) {
        console.error('❌ スクレイピングエラー:', error.message);
        throw error;
  } finally {
        await page.close();
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
        return { emoji: "🟢", decision: "仕入れ推奨", reason: `利益率+${profitRate}%`, totalCost };
  } else if (profitRate >= 20) {
        return { emoji: "🟡", decision: "仕入れ検討", reason: `利益率+${profitRate}%`, totalCost };
  } else if (profitRate >= 0) {
        return { emoji: "🟠", decision: "慎重検討", reason: `利益率+${profitRate}%`, totalCost };
  } else {
        return { emoji: "🔴", decision: "仕入れNG", reason: `損失${Math.abs(profitRate)}%`, totalCost };
  }
}

/**
 * メイン処理関数
 */
async function processQuery(modelNumber, auctionPrice) {
    try {
          const result = await scrapeAucfanWithPuppeteer(modelNumber);
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
              judgment: { ...judgment, totalCost },
              profit,
              profitRate
      };

    } catch (error) {
          console.error('❌ 処理エラー:', error);
          throw error;
    }
}

// Middleware設定
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
          res.status(500).json({ error: error.message });
    }
});

// LINE Bot機能
if (hasLineConfig && line && client) {
    function parseMessage(message) {
          const lines = message.trim().split('\n').map(line => line.trim());
          let modelNumber = '', price = 0;

      for (const line of lines) {
              const priceMatch = line.match(/(価格|現在価格|落札価格)[:：]\s*([0-9,]+)/i);
              if (priceMatch) {
                        price = parseInt(priceMatch[2].replace(/,/g, ''));
              }
              const modelMatch = line.match(/(型番|商品)[:：]\s*(.+)/i);
              if (modelMatch) {
                        modelNumber = modelMatch[2].trim();
              }
      }

      if (!modelNumber && lines.length >= 1) modelNumber = lines[0];
          if (price === 0 && lines.length >= 2) {
                  const priceMatch = lines[1].match(/([0-9,]+)/);
                  if (priceMatch) price = parseInt(priceMatch[1].replace(/,/g, ''));
          }

      if (!modelNumber) return { error: '型番が見つかりません' };
          if (price === 0) return { error: 'オークション価格が見つかりません' };

      return { modelNumber, price };
    }

  function formatResultMessage(result) {
        if (result.count === 0) {
                return `❌ 「${result.query}」の相場が見つかりません\n\n💡 型番を英数字で入力してみてください`;
        }

      const { judgment } = result;
        let message = `${judgment.emoji} ${judgment.decision}\n${judgment.reason}\n\n`;
        message += `📊 【${result.query}】\n💰 平均相場: ${result.avgPrice.toLocaleString()}円\n\n`;
        message += `💵 オークション価格: ${result.auctionPrice.toLocaleString()}円\n`;
        message += `📝 手数料(5%): ${result.handlingFee.toLocaleString()}円\n`;
        message += `📝 消費税(10%): ${result.consumptionTax.toLocaleString()}円\n`;
        message += `💼 総原価: ${result.totalCost.toLocaleString()}円\n\n`;

      if (result.profit > 0) {
              message += `✅ 想定利益: +${result.profit.toLocaleString()}円\n`;
      } else {
              message += `❌ 想定損失: ${result.profit.toLocaleString()}円\n`;
      }

      message += `📈 検索結果: ${result.count}件\n`;

      const mercariCount = result.results.filter(r => r.platform === 'メルカリ').length;
        const yahooCount = result.results.filter(r => r.platform === 'ヤフオク').length;

      if (mercariCount > 0 || yahooCount > 0) {
              message += `📱 内訳: `;
              if (mercariCount > 0) message += `メルカリ${mercariCount}件 `;
              if (yahooCount > 0) message += `ヤフオク${yahooCount}件`;
              message += '\n(直近1年)\n';
      }

      return message;
  }

  async function handleTextMessage(event) {
        const messageText = event.message.text;
        const userId = event.source.userId;

      try {
              await client.replyMessage(event.replyToken, {
                        type: 'text',
                        text: '🔍 相場検索中...\n※最大60秒かかる場合があります'
              });

          const parseResult = parseMessage(messageText);
              if (parseResult.error) {
                        await client.pushMessage(userId, {
                                    type: 'text',
                                    text: `❌ ${parseResult.error}\n\n例:\niPhone 13 Pro\n80000`
                        });
                        return;
              }

          const result = await processQuery(parseResult.modelNumber, parseResult.price);
              const resultMessage = formatResultMessage(result);

          await client.pushMessage(userId, { type: 'text', text: resultMessage });

      } catch (error) {
              console.error('❌ メッセージ処理エラー:', error);
              await client.pushMessage(userId, {
                        type: 'text',
                        text: '❌ 処理中にエラーが発生しました。\n\n🔄 もう一度お試しください。'
              });
      }
  }

  async function handleEvent(event) {
        if (event.type !== 'message' || event.message.type !== 'text') {
                return Promise.resolve(null);
        }
        return handleTextMessage(event);
  }

  app.post('/webhook', (req, res) => {
        Promise.all(req.body.events.map(handleEvent))
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
          version: '2.0.0-puppeteer',
          timestamp: new Date().toISOString(),
          features: ['puppeteer', 'mercari_yahoo_only', 'one_year_data']
    });
});

app.get('/', (req, res) => {
    res.json({ 
                 message: 'オークファン相場検索API v2.0 - Puppeteer版',
          status: 'running',
          improvements: [
                  '✅ Puppeteerで動的コンテンツ取得',
                  '✅ メルカリ・ヤフオク限定',
                  '✅ 直近1年データのみ',
                  '✅ 広告完全除外'
                ]
    });
});

// サーバー起動
app.listen(PORT, async () => {
    console.log(`🚀 サーバー起動: http://localhost:${PORT}`);
    console.log(`📱 API: https://go-nogo-scraper.onrender.com/api/search`);
    console.log('🎯 Puppeteer版 - 動的コンテンツ対応');

             // Puppeteerブラウザを事前起動
             try {
                   await getBrowser();
                   console.log('✅ Puppeteerブラウザ準備完了');
             } catch (error) {
                   console.error('❌ Puppeteerブラウザ起動失敗:', error.message);
             }
});

// プロセス終了時のクリーンアップ
process.on('SIGINT', async () => {
    console.log('🛑 サーバー終了中...');
    if (browserInstance) {
          await browserInstance.close();
          console.log('✅ Puppeteerブラウザ終了');
    }
    process.exit(0);
});
