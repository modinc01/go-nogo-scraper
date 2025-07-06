import axios from "axios";
import cheerio from "cheerio";

export default async function scrapeHandler(req, res) {
  const query = req.body.q;
  if (!query) {
    return res.status(400).json({ error: "Query not provided" });
  }

  try {
    const encoded = encodeURIComponent(query);
    const url = `https://aucfan.com/search1/q-${encoded}/`;

    const { data } = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36",
      },
    });

    const $ = cheerio.load(data);
    const items = [];

    $(".aucfan_item_box").each((_, el) => {
      const title = $(el).find(".product__title").text().trim();
      const price = $(el).find(".product__price").text().replace(/[^\d]/g, "");
      const site = $(el).find(".product__site").text().trim();
      const num = parseInt(price, 10);

      if (title && num && ["メルカリ", "ヤフオク!", "Yahoo!フリマ"].some(s => site.includes(s))) {
        items.push(num);
      }
    });

    if (items.length === 0) {
      return res.json({ average: 0, count: 0, items: [] });
    }

    const avg = Math.round(items.reduce((a, b) => a + b, 0) / items.length);
    res.json({ average: avg, count: items.length, items });
  } catch (error) {
    console.error("Scrape Error:", error.message);
    res.status(500).json({ error: "Scraping failed" });
  }
}
