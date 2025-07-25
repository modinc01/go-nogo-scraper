import express from "express";
import dotenv from "dotenv";
import axios from "axios";
import scrapeHandler from "./api/scrape.js";

dotenv.config();
const app = express();
const port = process.env.PORT || 10000;

app.use(express.json());

app.post("/webhook", async (req, res) => {
  const events = req.body.events;
  if (!events || events.length === 0) return res.sendStatus(200);

  const event = events[0];
  const replyToken = event.replyToken;
  const messageText = event.message?.text || "";

  try {
    const response = await axios.post(
      "https://go-nogo-scraper.onrender.com/api/scrape",
      { q: messageText }
    );

    const avg = response.data?.avg;
    const replyText = avg
      ? `相場平均: ¥${avg}`
      : "相場が見つかりませんでした。";

    await axios.post(
      "https://api.line.me/v2/bot/message/reply",
      {
        replyToken,
        messages: [{ type: "text", text: replyText }],
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
        },
      }
    );

    res.sendStatus(200);
  } catch (err) {
    console.error("LINE返信エラー:", err.message);
    res.sendStatus(500);
  }
});

app.post("/api/scrape", scrapeHandler);

app.listen(port, () => {
  console.log(`✅ Server is running on port ${port}`);
});
