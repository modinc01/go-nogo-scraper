import express from "express";
import scrapeHandler from "./api/scrape.js";

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.all("/scrape", async (req, res) => {
  const q = req.method === "GET" ? req.query.q : req.body.q;
  if (!q) return res.json({ error: "No query provided" });

  try {
    const result = await scrapeHandler(q);
    res.json(result);
  } catch (e) {
    console.error("💥 Scrape Error:", e);
    res.json({ error: "Scraping failed" });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
});
