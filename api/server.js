// server.js
import express from "express";
import scrapeRoute from "./api/scrape.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/scrape", scrapeRoute);

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
