import express from "express";
import bodyParser from "body-parser";

const app = express();
const PORT = process.env.PORT || 10000;

app.use(bodyParser.json());

// LINE Webhook 用のエンドポイント
app.post("/webhook", (req, res) => {
  console.log("LINEからのWebhook受信:", req.body);

  // ここで適当に200返すだけ（最低限）
  res.status(200).send("OK");
});

// 必要であれば scrape.js も使えるようにする（オプション）
import scrapeHandler from "./api/scrape.js";
app.post("/api/scrape", scrapeHandler);

app.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
});
