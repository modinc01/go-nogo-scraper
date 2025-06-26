import express from "express";
import puppeteer from "puppeteer-core";
import cors from "cors";

const app = express();
app.use(cors());

app.get("/api/scrape", async (req, res) => {
  const model = req.query.model;
  if (!model) return res.status(400).json({ error: "モデルが指定されていません" });

  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
      executablePath: "/usr/bin/chromium-browser", // Render の既存 Chrome パス
    });

    const page = await browser.newPage();
    const url = `https://aucfan.com/search1/q-${encodeURIComponent(model)}`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });

    const prices = await page.$$eval(".Item__price--3vJWp", elems =>
      elems
        .map(el => parseInt(el.textContent.replace(/[^\d]/g, ""), 10))
        .filter(n => !isNaN(n))
    );

    await browser.close();

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
