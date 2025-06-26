import express from "express";
import axios from "axios";
import * as cheerio from "cheerio"; // ← 修正ポイント
import cors from "cors";

const app = express();
app.use(cors());

app.get("/api/scrape", async (req, res) => {
  const model = req.query.model;
  if (!model) return res.status(400).json({ error: "モデルが指定されていません" });

  try {
    const url = `https://aucfan.com/search1/q-${encodeURIComponent(model)}`;
    const { data: html } = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });

    const $ = cheerio.load(html);
    const prices = [];

    $(".Item__price--3vJWp").each((_, el) => {
      const price = parseInt($(el).text().replace(/[^\d]/g, ""), 10);
      if (!isNaN(price)) prices.push(price);
    });

    if (prices.length === 0) {
      return res.status(404).json({ error: "価格データが見つかりませんでした。" });
    }

    const avg = Math.round(prices.reduce((sum, val) => sum + val, 0) / prices.length);
    res.json({ avg });
  } catch (err) {
    console.error("💥 Scrape Error:", err);
    res.status(500).json({ error: "スクレイピングに失敗しました。" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
