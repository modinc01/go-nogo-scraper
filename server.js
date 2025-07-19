import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import scrapeHandler from "./api/scrape.js";

dotenv.config();
const app = express();
const port = process.env.PORT || 10000;

app.use(express.json());

// スクレイピングAPI
app.post("/api/scrape", scrapeHandler);

// LINE webhook
app.post("/webhook", async (req, res) => {
  const event = req.body.events?.[0];
  if (!event || !event.message || !event.replyToken) {
    return res.sendStatus(200);
  }

  try {
    const response = await axios.post(
      "https://go-nogo-scraper.onrender.com/api/scrape",
      { q: event.message.text }
    );

    const avg = response.data?.avg;
    const replyText = avg
      ? `相場平均: ¥${avg}`
      : "相場が見つかりませんでした。";

    await axios.post(
      "https://api.line.me/v2/bot/message/reply",
      {
        replyToken: event.replyToken,
        messages: [{ type: "text", text: replyText }]
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
        }
      }
    );

    res.sendStatus(200);
  } catch (err) {
    console.error("LINE返信エラー:", err.message);
    res.sendStatus(500);
  }
});

app.listen(port, () => {
  console.log(`✅ Server is running on port ${port}`);
});
