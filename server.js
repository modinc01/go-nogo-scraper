import express from "express";
import cors from "cors";
import scrapeHandler from "./api/scrape.js";

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

app.post("/api/scrape", scrapeHandler);

app.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
});
