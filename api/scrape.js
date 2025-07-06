import axios from "axios";
import * as cheerio from "cheerio";

export default async function scrapeHandler(keyword) {
  try {
    const url = `https://aucfan.com/search1/q-${encodeURIComponent(keyword)}/`;
    const { data } = await axios.get(url);
    const $ = cheerio.load(data);
    const prices = [];

    $(".article__item__price").each((_, el) => {
      const text = $(el).text().replace(/[^\d]/g, "");
      const price = parseInt(text, 10);
      if (!isNaN(price)) prices.push(price);
    });

    if (prices.length === 0) return { averagePrice: "0" };

    const average =
      Math.round(prices.reduce((sum, val) => sum + val, 0) / prices.length);

    return { averagePrice: String(average) };
  } catch (err) {
    console.error("Scrape Error:", err.message);
    return { averagePrice: "0" };
  }
}
