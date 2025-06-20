// LINEからの型番と仕入価格を受け取った後に使う処理
const model = 型番; // 例: "MNCF3J/A"
const cost = 仕入価格; // 例: 45000

// 相場価格取得
const response = await fetch(`https://YOUR-VERCEL-URL/api/scrape?model=${encodeURIComponent(model)}`);
const data = await response.json();

if (data.avg) {
  const avgPrice = data.avg;

  // 仕入れ価格に手数15%を加算
  const totalCost = Math.round(cost * 1.15);
  const profit = avgPrice - totalCost;
  const profitRate = Math.round((profit / totalCost) * 100);

  const result = profit >= 10000 || profitRate >= 35 ? "✅ Go" : "❌ NoGo";
  const replyText = `📦 ${model}\n💴 仕入: ${totalCost}円\n📊 相場: ${avgPrice}円\n📈 利益率: ${profitRate}%\n💰 利益: ${profit}円\n${result}`;

  // LINEに返信
  await client.replyMessage(event.replyToken, {
    type: "text",
    text: replyText,
  });
} else {
  await client.replyMessage(event.replyToken, {
    type: "text",
    text: "❌ 相場取得に失敗しました",
  });
}
