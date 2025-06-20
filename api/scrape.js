import express from "express";
import puppeteer from "puppeteer-core";
import cors from "cors";
import { executablePath } from "puppeteer";

const app = express();
app.use(cors());

app.get("/api/scrape", async (req, res) => {
  const model = req.query.model;
  if (!model) return res.status(400).json({ error: "モデルが指定されていません" });

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: executablePath(), // Render の内部ブラウザを使用
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  const url = `https://aucfan.com/search1/q-${encodeURIComponent(model)}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });

  const prices = await page.$$eval(".Item__price--3vJWp", elems =>
    elems.map(el => {
      const text = el.textContent.replace(/[^\d]/g, "");
      return parseInt(text, 10);
    }).filter(p => !isNaN(p))
  );

  await browser.close();

  if (prices.length === 0) return res.status(404).json({ error: "価格が取得できませんでした" });

  const avg = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
  res.json({ avg });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("✅ Running on port", PORT);
});
