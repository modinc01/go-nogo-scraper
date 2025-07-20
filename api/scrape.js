import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";

export default async function scrapeHandler(req, res) {
  try {
    const query = req.body.q;
    if (!query) return res.status(400).json({ error: "No query provided." });

    const encoded = encodeURIComponent(query);
    const url = `https://aucfan.com/search1/q-${encoded}/`;

    const browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });

    const prices = await page.$$eval("div.item__price--value", els =>
      els.map(el => parseInt(el.textContent.replace(/[^\d]/g, ""))).filter(Boolean)
    );

    await browser.close();

    if (prices.length === 0) {
      return res.json({ avg: 0, count: 0 });
    }

    const avg = Math.floor(prices.reduce((a, b) => a + b, 0) / prices.length);
    res.json({ avg, count: prices.length });
  } catch (err) {
    console.error("Scrape Error:", err.message);
    res.status(500).json({ error: "Scraping failed" });
  }
}
