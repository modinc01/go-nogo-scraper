import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import scrapeHandler from "./api/scrape.js";

const app = express();
const PORT = process.env.PORT || 10000;

// LINE Bot用のアクセストークン
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

app.use(bodyParser.json());

// テスト用GETエンドポイント
app.get("/", (req, res) => {
  res.send("✅ Server is running");
});

// スクレイピングAPI
app.post("/api/scrape", async (req, res) => {
  try {
    const data = await scrapeHandler(req.body.q);
    res.json(data);
  } catch (error) {
    console.error("Scrape Error:", error.message);
    res.status(500).json({ error: "Scraping failed" });
  }
});

// LINE Webhookエンドポイント
app.post("/webhook", async (req, res) => {
  try {
    const events = req.body.events;
    if (!events || !Array.isArray(events)) {
      return res.status(200).send("No events");
    }

    for (const event of events) {
      if (event.type === "message" && event.message.type === "text") {
        const keyword = event.message.text;
        const userId = event.source.userId;

        try {
          const result = await scrapeHandler(keyword);

          const avg = result?.averagePrice ?? "該当なし";
          const replyText = `「${keyword}」の平均成約価格は ${avg} 円です。`;

          await axios.post(
            "https://api.line.me/v2/bot/message/reply",
            {
              replyToken: event.replyToken,
              messages: [
                {
                  type: "text",
                  text: replyText,
                },
              ],
            },
            {
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
              },
            }
          );
        } catch (err) {
          console.error("LINE返信エラー:", err.message);
        }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhookエラー:", err.message);
    res.sendStatus(500);
  }
});

// サーバー起動
app.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
});
