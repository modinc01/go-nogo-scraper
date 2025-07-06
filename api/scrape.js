import axios from "axios";
import * as cheerio from "cheerio";

export default async function scrapeHandler(query) {
  const encoded = encodeURIComponent(query);
  const url = `https://aucfan.com/search1/q-${encoded}`;

  try {
    const { data } = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
      },
    });

    const $ = cheerio.load(data);
    const prices = [];

    $("div.prices li").each((_, el) => {
      const priceText = $(el).text().replace(/[^0-9]/g, "");
      const price = parseInt(priceText, 10);
      if (!isNaN(price)) prices.push(price);
    });

    if (prices.length === 0) return { avgPrice: 0, count: 0 };

    const avgPrice = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
    return { avgPrice, count: prices.length };
  } catch (err) {
    console.error("💥 Scrape Error:", err);
    throw err;
  }
}
