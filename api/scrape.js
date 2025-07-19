import puppeteer from "puppeteer";

export default async function scrapeHandler(req, res) {
  try {
    const query = req.body.q;
    if (!query) return res.status(400).json({ error: "No query provided." });

    const url = `https://aucfan.com/search1/q-${encodeURIComponent(query)}/`;

    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle2" });

    const prices = await page.$$eval("div.item__price--value", (els) =>
      els
        .map((el) => el.textContent.replace(/[^\d]/g, ""))
        .filter((v) => v)
        .map((v) => parseInt(v))
    );

    await browser.close();

    if (!prices.length) return res.json({ avg: 0, count: 0 });

    const avg = Math.floor(prices.reduce((a, b) => a + b, 0) / prices.length);
    res.json({ avg, count: prices.length });
  } catch (err) {
    console.error("Scrape Error:", err.message);
    res.status(500).json({ error: "Scraping failed" });
  }
}
