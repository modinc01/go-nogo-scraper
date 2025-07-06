import express from "express";
import axios from "axios";
import cheerio from "cheerio";

const app = express();
app.use(express.json());

app.post("/api/scrape", async (req, res) => {
  const keyword = req.body.q;
  if (!keyword) return res.status(400).json({ error: "キーワードが指定されていません。" });

  try {
    const url = `https://aucfan.com/search1/q-${encodeURIComponent(keyword)}`;
    const { data } = await axios.get(url);
    const $ = cheerio.load(data);

    const prices = [];
    $(".Item__price--3vJWp").each((_, el) => {
      const text = $(el).text().replace(/[^\d]/g, "");
      const price = parseInt(text, 10);
      if (!isNaN(price)) prices.push(price);
    });

    if (prices.length === 0) return res.status(200).json({ avg: 0, count: 0 });

    const avg = Math.round(prices.reduce((sum, val) => sum + val, 0) / prices.length);
    res.json({ avg, count: prices.length });
  } catch (error) {
    console.error("💥 Scrape Error:", error.message);
    res.status(500).json({ error: "Scraping failed" });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
});
