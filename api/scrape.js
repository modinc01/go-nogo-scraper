import axios from "axios";
import * as cheerio from "cheerio";

export default async function scrapeHandler(req, res) {
  try {
    const query = req.body.q;
    if (!query) return res.status(400).json({ error: "No query provided." });

    const encoded = encodeURIComponent(query);
    const url = `https://aucfan.com/search1/q-${encoded}/`;

    const { data } = await axios.get(url);
    const $ = cheerio.load(data);

    const prices = [];

    $("div.item__price--value").each((_, el) => {
      const text = $(el).text().replace(/[^\d]/g, "");
      if (text) prices.push(parseInt(text));
    });

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

