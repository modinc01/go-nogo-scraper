import axios from "axios";
import * as cheerio from "cheerio";

export default defineEventHandler(async (event) => {
  const query = getQuery(event);
  const keyword = query.q || "";

  // クエリがなければ終了
  if (!keyword) {
    return { error: "検索ワードが指定されていません。" };
  }

  try {
    // 検索語の正規化（全角→半角、trimなど）
    const normalizedKeyword = keyword.trim().replace(/\s+/g, " ");

    // 横断検索用のURL（サイト指定なしで全体検索）
    const encoded = encodeURIComponent(normalizedKeyword);
    const url = `https://aucfan.com/search1/q-${encoded}/`; // 横断検索ページ

    const res = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });

    const html = res.data;
    const $ = cheerio.load(html);

    const priceList = [];

    // メルカリ・ヤフオク・Yahooフリマの成約価格だけを取得
    $(".aucfan-search-result-list li").each((i, el) => {
      const market = $(el).find(".searchResult__site").text().trim();
      if (market.match(/メルカリ|ヤフオク|Yahooフリマ/)) {
        const priceText = $(el)
          .find(".productPrice")
          .text()
          .replace(/[^0-9]/g, "");
        if (priceText) {
          priceList.push(Number(priceText));
        }
      }
    });

    if (priceList.length === 0) {
      return { keyword: normalizedKeyword, count: 0, avg: 0, prices: [] };
    }

    const sum = priceList.reduce((a, b) => a + b, 0);
    const avg = Math.floor(sum / priceList.length);

    return {
      keyword: normalizedKeyword,
      count: priceList.length,
      avg,
      prices: priceList,
    };
  } catch (err) {
    console.error("💥 Scrape Error:", err);
    return { keyword: keyword, count: 0, avg: 0, prices: [] };
  }
});
