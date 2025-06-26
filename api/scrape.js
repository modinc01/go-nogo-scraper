import express from "express";
import axios from "axios";
import * as cheerio from "cheerio";

const app = express();
const port = process.env.PORT || 3000;

app.get("/scrape", async (req, res) => {
  try {
    const query = req.query.q;
    if (!query) {
      return res.json({ error: "クエリがありません" });
    }

    const keyword = query.trim().replace(/\s+/g, " ");
    const encoded = encodeURIComponent(keyword);

    const urls = [
      `https://aucfan.com/search1/q-${encoded}/s-m/`,
      `https://aucfan.com/search1/q-${encoded}/s-ya/`,
      `https://aucfan.com/search1/q-${encoded}/s-yf/`,
    ];

    let total = 0;
    let count = 0;

    for (const url of urls) {
      try {
        const { data } = await axios.get(url);
        const $ = cheerio.load(data);
        $(".soldItemBox .price").each((_, el) => {
          const priceText = $(el).text().replace(/[^\d]/g, "");
          const price = parseInt(priceText, 10);
          if (!isNaN(price)) {
            total += price;
            count += 1;
          }
        });
      } catch (err) {
        // 個別URLエラーは無視
      }
    }

    if (count === 0) {
      return res.json({ count: 0, avg: 0 });
    }

    const avg = Math.round(total / count);
    res.json({ count, avg });

  } catch (err) {
    res.json({ error: "スクレイピングに失敗しました。" });
  }
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
