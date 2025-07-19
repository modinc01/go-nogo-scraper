import puppeteer from "puppeteer";

export default async function scrapeHandler(req, res) {
  try {
    const query = req.body.q;
    if (!query) return res.status(400).json({ error: "No query provided." });

    const encoded = encodeURIComponent(query);
    const url = `https://aucfan.com/search1/q-${encoded}/`;

    const browser = await puppeteer.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle2", timeout: 0 });

    // ページ内の価格要素を取得
    const prices = await page.evaluate(() => {
      const elements = document.querySelectorAll("div.item__price--value");
      const priceList = [];
      elements.forEach((el) => {
        const text = el.textContent.replace(/[^\d]/g, "");
        if (text) priceList.push(parseInt(text));
      });
      return priceList;
    });

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
