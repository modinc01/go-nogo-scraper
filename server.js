import express from "express";
import bodyParser from "body-parser";
import scrapeHandler from "./api/scrape.js"; // 既存のスクレイプAPI

const app = express();
app.use(bodyParser.json());

// 🔽 これがLINEのWebhook用エンドポイント
app.post("/webhook", async (req, res) => {
  const events = req.body.events;
  if (!events || !Array.isArray(events)) return res.sendStatus(200);

  for (const event of events) {
    if (event.type !== "message" || event.message.type !== "text") continue;

    const userMessage = event.message.text;

    // 相場取得リクエスト
    let result;
    try {
      const scrapeRes = await fetch("http://localhost:10000/scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: userMessage })
      });
      const json = await scrapeRes.json();
      result = json || { avg: 0, hit: 0 };
    } catch (e) {
      result = { avg: 0, hit: 0 };
    }

    const replyText =
      result.hit === 0
        ? `「${userMessage}」は0件ヒットでした。`
        : `平均価格：${result.avg.toLocaleString()}円（${result.hit}件中）`;

    // LINEへの返信（公式アクセストークンを設定済みである前提）
    await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        replyToken: event.replyToken,
        messages: [{ type: "text", text: replyText }],
      }),
    });
  }

  res.sendStatus(200);
});
