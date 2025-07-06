// api/scrape.js
import axios from "axios";
import * as cheerio from "cheerio";

export default async function scrapeHandler(req, res) {
  const query = req.query.q;
  if (!query) {
    return res.status(400).json({ error: "クエリが必要です (q=xxx)" });
  }

  const encoded = encodeURIComponent(query);
  const urls = [
    `https://aucfan.com/search1/q-${encoded}/s-ya/`,
    `https://aucfan.com/search1/q-${encoded}/s-yf/`,
    `https://aucfan.com/search1/q-${encoded}/s-mc/`
  ];

  let prices = [];

  for (const url of urls) {
    try {
      const response = await axios.get(url, {
        headers: {
          "User-Agent": "Mozilla/5.0"
        }
      });

      const $ = cheerio.load(response.data);
      $("div.item__price").each((_, el) => {
        const text = $(el).text().replace(/[^\d]/g, "");
        const price = parseInt(text);
        if (!isNaN(price)) prices.push(price);
      });
    } catch (err) {
      console.error("💥 Error:", err.message);
    }
  }

  if (prices.length === 0) {
    return res.json({ avg: 0, count: 0 });
  }

  const avg = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
  return res.json({ avg, count: prices.length });
}
