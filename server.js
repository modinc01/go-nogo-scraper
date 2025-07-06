// server.js
import express from "express";
import scrape from "./api/scrape.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get("/", (req, res) => {
  res.send("Go/NoGo Scraper is running.");
});

app.get("/scrape", async (req, res) => {
  const query = req.query.q;
  if (!query) {
    return res.status(400).json({ error: "Missing query" });
  }

  try {
    const result = await scrape(query);
    res.json(result);
  } catch (err) {
    console.error("Scrape Error:", err);
    res.status(500).json({ error: "Scraping failed" });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
});
