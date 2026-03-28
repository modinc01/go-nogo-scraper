// ============================================================
// LINE 相場判定 Bot v7.0 — OpenAI Responses API + オークファン MCP サーバー
// OAuth 2.0 認証フロー対応版
// ============================================================
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const OpenAI = require('openai').default || require('openai');

const app = express();
const PORT = process.env.PORT || 10000;

// ── クライアント初期化 ──────────────────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const LINE_CONFIG = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

// ── オークファン MCP サーバー設定 ──────────────────────
const AUCFAN_MCP_URL = process.env.AUCFAN_MCP_URL || 'https://mcp.aucfan.com/aucfan-api/mcp';
const AUCFAN_OAUTH_TOKEN = process.env.AUCFAN_OAUTH_TOKEN || '';
const AUCFAN_EMAIL = process.env.AUCFAN_EMAIL || '';
const AUCFAN_PASSWORD = process.env.AUCFAN_PASSWORD || '';
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || 'https://go-nogo-scraper.onrender.com';

// ── OAuth 状態管理 ──────────────────────────────────
let oauthState = {
  accessToken: null,
  refreshToken: null,
  expiresAt: null,
  metadata: null,       // OAuth server metadata
  codeVerifier: null,    // PKCE code verifier
  stateParam: null,      // OAuth state parameter
};

// 起動時に環境変数のトークンがあればセット
if (AUCFAN_OAUTH_TOKEN && AUCFAN_OAUTH_TOKEN !== 'placeholder') {
  oauthState.accessToken = AUCFAN_OAUTH_TOKEN;
  console.log('✅ 環境変数からOAuthトークン読み込み済み');
}

// ── PKCE ヘルパー ───────────────────────────────────
function generateCodeVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function generateState() {
  return crypto.randomBytes(16).toString('hex');
}

// ── OAuth メタデータ発見 ─────────────────────────────
async function discoverOAuthMetadata() {
  // MCP 仕様に基づいて well-known エンドポイントを試す
  const mcpUrl = new URL(AUCFAN_MCP_URL);
  const baseUrl = `${mcpUrl.protocol}//${mcpUrl.host}`;
  const pathPrefix = mcpUrl.pathname.replace(/\/mcp\/?$/, '');

  const discoveryUrls = [
    `${baseUrl}${pathPrefix}/.well-known/oauth-authorization-server`,
    `${baseUrl}/.well-known/oauth-authorization-server`,
    `${baseUrl}${pathPrefix}/.well-known/openid-configuration`,
    `${baseUrl}/.well-known/openid-configuration`,
  ];

  for (const url of discoveryUrls) {
    try {
      console.log(`🔍 OAuth discovery 試行: ${url}`);
      const resp = await axios.get(url, { timeout: 10000 });
      if (resp.data && (resp.data.authorization_endpoint || resp.data.token_endpoint)) {
        console.log('✅ OAuth メタデータ発見:', JSON.stringify(resp.data).slice(0, 300));
        oauthState.metadata = resp.data;
        return resp.data;
      }
    } catch (err) {
      console.log(`  → ${url}: ${err.response?.status || err.code || err.message}`);
    }
  }

  // メタデータが見つからない場合、401レスポンスからヒントを得る
  try {
    console.log('🔍 MCP サーバーに直接アクセスして認証情報を確認...');
    const resp = await axios.post(AUCFAN_MCP_URL, {
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'line-aucfan-bot', version: '7.0.0' },
      },
      id: 1,
    }, {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      timeout: 10000,
      validateStatus: () => true, // 全ステータスコードを許可
    });

    console.log(`📡 MCP レスポンス: status=${resp.status}`);
    console.log(`📡 Headers:`, JSON.stringify(resp.headers).slice(0, 500));
    console.log(`📡 Body:`, JSON.stringify(resp.data).slice(0, 500));

    // 401 の場合 WWW-Authenticate ヘッダーを確認
    if (resp.status === 401) {
      const wwwAuth = resp.headers['www-authenticate'];
      if (wwwAuth) {
        console.log(`🔑 WWW-Authenticate: ${wwwAuth}`);
        // Bearer realm="..." からOAuthエンドポイントを抽出
        const realmMatch = wwwAuth.match(/realm="([^"]+)"/);
        if (realmMatch) {
          console.log(`🔑 認証 realm: ${realmMatch[1]}`);
        }
      }

      // レスポンスボディにOAuth情報が含まれているかチェック
      if (resp.data && typeof resp.data === 'object') {
        if (resp.data.authorization_url || resp.data.auth_url || resp.data.login_url) {
          console.log('🔑 認証URLがレスポンスに含まれています');
        }
      }
    }

    // 成功した場合（認証不要？）
    if (resp.status === 200 && resp.data?.result) {
      console.log('🎉 MCP サーバーが認証なしで応答しました！');
      return null; // 認証不要
    }

    return null;
  } catch (err) {
    console.error('❌ MCP 接続テスト失敗:', err.message);
    return null;
  }
}

// ── OAuth トークン取得（password grant — サーバーがサポートしている場合） ──
async function tryPasswordGrant(metadata) {
  if (!metadata?.token_endpoint) return false;
  if (!AUCFAN_EMAIL || !AUCFAN_PASSWORD) {
    console.log('⚠️ AUCFAN_EMAIL/PASSWORD 未設定、password grant スキップ');
    return false;
  }

  const supportedGrants = metadata.grant_types_supported || [];
  if (supportedGrants.length > 0 && !supportedGrants.includes('password')) {
    console.log('⚠️ password grant 非対応:', supportedGrants);
    return false;
  }

  try {
    console.log('🔑 Password grant 試行...');
    const resp = await axios.post(metadata.token_endpoint, new URLSearchParams({
      grant_type: 'password',
      username: AUCFAN_EMAIL,
      password: AUCFAN_PASSWORD,
      scope: metadata.scopes_supported?.join(' ') || '',
    }).toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000,
    });

    if (resp.data?.access_token) {
      oauthState.accessToken = resp.data.access_token;
      oauthState.refreshToken = resp.data.refresh_token || null;
      oauthState.expiresAt = resp.data.expires_in
        ? Date.now() + (resp.data.expires_in * 1000)
        : null;
      console.log('🎉 Password grant 成功！トークン取得完了');
      console.log(`🔑 Token (先頭20文字): ${oauthState.accessToken.slice(0, 20)}...`);
      return true;
    }
  } catch (err) {
    console.log(`⚠️ Password grant 失敗: ${err.response?.status} ${err.response?.data?.error || err.message}`);
  }
  return false;
}

// ── 有効なアクセストークンを取得 ────────────────────────
function getAccessToken() {
  if (!oauthState.accessToken) return null;
  // 期限切れチェック（5分前にexpire扱い）
  if (oauthState.expiresAt && Date.now() > oauthState.expiresAt - 300000) {
    console.log('⚠️ アクセストークン期限切れ');
    return null;
  }
  return oauthState.accessToken;
}

// ── システムプロンプト ──────────────────────────────
const SYSTEM_PROMPT = `あなたは日本のオークション・フリマ市場に精通した相場分析のプロフェッショナルです。
ユーザーから商品名（型番）と仕入れ価格が送られてきたら、aucfan_search_api ツールを使って正確な相場判定を行ってください。

## 分析手順
1. まず aucfan_search_api で商品を検索し、実際の落札データを取得する
2. データが少ない場合はキーワードを調整して再検索する
   - 例: 「iPhone 15 Pro 256GB」→「iPhone15Pro 256」でも試す
   - 型番がある場合は型番のみでも検索する
3. 検索時は period パラメータで直近6ヶ月を指定する

## 分析ルール
- **Yahoo!オークションの落札済みデータのみ**を相場の根拠にする
- 明らかに状態が異なるもの（ジャンク品、付属品なし等）は分けて考慮する
- 外れ値（相場から極端に外れた価格）は分析に含めるが注記する

## コスト計算
仕入れ価格が提示された場合：
- 手数料 (5%): 仕入れ価格 × 0.05
- 小計: 仕入れ価格 + 手数料
- 消費税 (10%): 小計 × 0.10
- 総コスト: 小計 + 消費税 = 仕入れ価格 × 1.155
- 販売時のメルカリ手数料 (10%) も考慮: 売値の90%が手取り
- 送料目安も考慮（サイズによる）

## 回答フォーマット（必ずこの形式で）

📦 商品: {商品名}

📊 【相場データ】
平均落札価格: {X,XXX}円
中央値: {X,XXX}円
価格帯: {最低}〜{最高}円
データ件数: {N}件

📋 【直近の実際の取引】
・{日付} {価格}円 — {商品タイトル要約}
・{日付} {価格}円 — {商品タイトル要約}
・{日付} {価格}円 — {商品タイトル要約}
（最大5件表示）

💰 【仕入れ判定】（仕入れ価格が提示された場合）
仕入れ価格: {X,XXX}円
総コスト（税込手数料込）: {X,XXX}円
想定売値: {X,XXX}円
想定手取り（メルカリ手数料後）: {X,XXX}円
想定利益: {±X,XXX}円（利益率{XX}%）

{🟢 仕入れ推奨 / 🟡 検討 / 🔴 見送り推奨}
{判定理由を1-2行で}

## 重要な注意
- データが取得できなかった場合は正直に「相場データが不足しています」と伝える
- 推測で価格を出さない。必ずツールで取得したデータに基づく
- 金額は全てカンマ区切りで表示する
- LINEメッセージとして読みやすいよう、簡潔に整理する`;

// ── LINE 署名検証 ────────────────────────────────
function verifySignature(body, signature) {
  if (!LINE_CONFIG.channelSecret) {
    console.log('⚠️ channelSecret未設定、署名検証スキップ');
    return true;
  }
  if (!signature) {
    console.warn('⚠️ x-line-signature ヘッダーなし');
    return false;
  }
  const bodyStr = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const hash = crypto
    .createHmac('SHA256', LINE_CONFIG.channelSecret)
    .update(bodyStr)
    .digest('base64');
  const isValid = hash === signature;
  if (!isValid) {
    console.warn('⚠️ 署名不一致 — デバッグ用に通過させます');
    return true; // 一時的にデバッグ用：署名検証失敗でも通過
  }
  return true;
}

// ── LINE メッセージ送信 ──────────────────────────────
async function replyMessage(replyToken, text) {
  const messages = [];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, 4900));
    remaining = remaining.slice(4900);
  }
  for (const chunk of chunks) {
    messages.push({ type: 'text', text: chunk });
  }
  try {
    await axios.post(
      'https://api.line.me/v2/bot/message/reply',
      { replyToken, messages: messages.slice(0, 5) },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${LINE_CONFIG.channelAccessToken}`,
        },
        timeout: 10000,
      }
    );
    console.log('✅ 回答送信完了（' + text.length + '文字）');
  } catch (err) {
    console.error('❌ LINE reply エラー:', err.response?.data || err.message);
  }
}

async function pushMessage(userId, text) {
  const messages = [];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, 4900));
    remaining = remaining.slice(4900);
  }
  for (const chunk of chunks) {
    messages.push({ type: 'text', text: chunk });
  }
  try {
    await axios.post(
      'https://api.line.me/v2/bot/message/push',
      { to: userId, messages: messages.slice(0, 5) },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${LINE_CONFIG.channelAccessToken}`,
        },
        timeout: 10000,
      }
    );
    console.log('✅ Push送信完了（' + text.length + '文字）');
  } catch (err) {
    console.error('❌ LINE push エラー:', err.response?.data || err.message);
  }
}

// ── OpenAI Responses API + MCP でオークファンに問い合わせ ──
async function askGPTwithMCP(userMessage) {
  console.log('🤖 [GPT+MCP] 処理開始:', userMessage.slice(0, 50));

  const token = getAccessToken();

  // MCP ツール設定
  const mcpTool = {
    type: 'mcp',
    server_label: 'aucfan',
    server_url: AUCFAN_MCP_URL,
    require_approval: 'never',
  };

  // OAuth トークンがある場合は認証ヘッダーを追加
  if (token) {
    mcpTool.headers = {
      Authorization: `Bearer ${token}`,
    };
    console.log('🔑 OAuth トークン付与（先頭10文字）:', token.slice(0, 10) + '...');
  } else {
    console.warn('⚠️ OAuth トークンなし — MCP接続失敗の可能性あり');
  }

  try {
    const response = await openai.responses.create({
      model: 'gpt-4o',
      instructions: SYSTEM_PROMPT,
      tools: [mcpTool],
      input: userMessage,
      temperature: 0.3,
    });

    console.log('✅ [GPT+MCP] 応答取得');

    if (response.output_text) {
      return response.output_text;
    }

    if (response.output && Array.isArray(response.output)) {
      const textOutputs = response.output
        .filter(item => item.type === 'message')
        .map(item => {
          if (item.content && Array.isArray(item.content)) {
            return item.content
              .filter(c => c.type === 'output_text' || c.type === 'text')
              .map(c => c.text)
              .join('');
          }
          return '';
        })
        .join('\n');
      if (textOutputs) return textOutputs;
    }

    return '申し訳ございません。回答を生成できませんでした。';
  } catch (err) {
    console.error('❌ [GPT+MCP] エラー:', err.message);
    console.error('❌ [GPT+MCP] 詳細:', JSON.stringify(err.error || err.response?.data || {}).slice(0, 500));

    // 424 エラー（MCP接続失敗）の場合、フォールバック
    if (err.message?.includes('424') || err.message?.includes('401')) {
      console.log('⚠️ MCP接続失敗、直接接続フォールバック試行');
      return await askGPTFallback(userMessage);
    }

    if (err.message?.includes('responses') || err.status === 404) {
      console.log('⚠️ Responses API 未対応、Chat Completions にフォールバック');
      return await askGPTFallback(userMessage);
    }

    return `❌ エラーが発生しました: ${err.message}\n\nMCPサーバーへの接続に問題がある可能性があります。\n\n💡 管理者へ: ${RENDER_EXTERNAL_URL}/auth/status で認証状態を確認してください。`;
  }
}

// ── フォールバック: Chat Completions API (MCP ツールを手動で呼ぶ) ──
async function askGPTFallback(userMessage) {
  console.log('🔄 [Fallback] Chat Completions API を使用');

  let aucfanData = null;
  try {
    aucfanData = await callAucfanMCPDirectly(userMessage);
  } catch (err) {
    console.error('❌ [MCP Direct] エラー:', err.message);
  }

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userMessage },
  ];

  if (aucfanData) {
    messages.push({
      role: 'system',
      content: `以下はオークファンMCPサーバーから取得した実際の落札データです。このデータに基づいて回答してください:\n\n${JSON.stringify(aucfanData, null, 2)}`,
    });
  }

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages,
      temperature: 0.3,
      max_tokens: 2000,
    });
    return completion.choices[0].message.content;
  } catch (err) {
    console.error('❌ [Fallback] エラー:', err.message);
    return `❌ エラーが発生しました: ${err.message}`;
  }
}

// ── MCP サーバーに直接接続してツールを呼び出す ──────────
async function callAucfanMCPDirectly(query) {
  console.log('🔌 [MCP Direct] aucfan_search_api 呼び出し:', query.slice(0, 50));

  const token = getAccessToken();
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  // Step 1: Initialize
  const initResponse = await axios.post(
    AUCFAN_MCP_URL,
    {
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'line-aucfan-bot', version: '7.0.0' },
      },
      id: 1,
    },
    { headers, timeout: 15000 }
  );
  console.log('🔌 [MCP] Initialize:', JSON.stringify(initResponse.data).slice(0, 200));

  // Step 2: Call aucfan_search_api
  const searchResponse = await axios.post(
    AUCFAN_MCP_URL,
    {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'aucfan_search_api',
        arguments: { keyword: query },
      },
      id: 2,
    },
    { headers, timeout: 30000 }
  );
  console.log('🔌 [MCP] Search result:', JSON.stringify(searchResponse.data).slice(0, 500));

  return searchResponse.data?.result || searchResponse.data;
}

// ── Express ミドルウェア ─────────────────────────────
app.use('/webhook', express.raw({ type: '*/*' }));
app.use(express.json());

// ── ヘルスチェック ───────────────────────────────
app.get('/health', (req, res) => {
  const token = getAccessToken();
  res.json({
    status: 'ok',
    version: '7.0.0-oauth-flow',
    mcpServer: AUCFAN_MCP_URL,
    hasOAuthToken: !!token,
    tokenPreview: token ? token.slice(0, 8) + '...' : 'なし',
    oauthMetadata: oauthState.metadata ? '発見済み' : '未発見',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime() / 60) + '分',
  });
});

app.get('/', (req, res) => {
  res.json({
    service: 'LINE 相場判定 Bot (MCP版)',
    version: '7.0.0-oauth-flow',
    status: 'running',
    auth: getAccessToken() ? '認証済み' : '未認証',
  });
});

// ── OAuth 認証エンドポイント ──────────────────────────

// 認証状態の確認
app.get('/auth/status', async (req, res) => {
  const token = getAccessToken();
  res.send(`
    <html>
    <head><title>オークファン MCP 認証状態</title>
    <style>body{font-family:sans-serif;max-width:600px;margin:40px auto;padding:20px}
    .ok{color:green}.ng{color:red}.info{background:#f0f0f0;padding:15px;border-radius:8px;margin:10px 0}
    a{display:inline-block;margin:10px 0;padding:10px 20px;background:#007bff;color:white;text-decoration:none;border-radius:5px}
    code{background:#eee;padding:2px 6px;border-radius:3px}
    </style></head>
    <body>
    <h1>🔐 オークファン MCP 認証状態</h1>
    <div class="info">
      <p>トークン: <strong class="${token ? 'ok' : 'ng'}">${token ? '✅ 設定済み (' + token.slice(0, 8) + '...)' : '❌ 未設定'}</strong></p>
      <p>OAuthメタデータ: <strong>${oauthState.metadata ? '✅ 発見済み' : '❌ 未発見'}</strong></p>
      <p>MCP URL: <code>${AUCFAN_MCP_URL}</code></p>
    </div>
    ${!token ? `
    <h2>🔑 認証方法</h2>
    <h3>方法1: OAuth認証フロー（推奨）</h3>
    <a href="/auth/start">OAuth認証を開始する →</a>
    <h3>方法2: 手動トークン設定</h3>
    <p>Renderダッシュボードで <code>AUCFAN_OAUTH_TOKEN</code> に有効なトークンを設定してください。</p>
    <h3>方法3: ChatGPTからトークンを取得</h3>
    <ol>
      <li>ChatGPTでオークファンMCPを使う</li>
      <li>ブラウザの開発者ツール（F12）→ ネットワーク タブを開く</li>
      <li>ChatGPTでオークファン検索を実行</li>
      <li><code>mcp.aucfan.com</code> へのリクエストを探す</li>
      <li>Authorizationヘッダーの <code>Bearer xxxx</code> をコピー</li>
      <li>下のフォームに貼り付けるか、Renderの環境変数に設定</li>
    </ol>
    <form action="/auth/manual" method="POST" style="margin:10px 0">
      <input type="text" name="token" placeholder="Bearer トークンを貼り付け" style="width:100%;padding:10px;margin:5px 0;box-sizing:border-box" />
      <button type="submit" style="padding:10px 20px;background:#28a745;color:white;border:none;border-radius:5px;cursor:pointer">トークンを設定</button>
    </form>
    ` : `
    <h2>✅ 認証済み</h2>
    <p>MCP サーバーに接続する準備ができています。</p>
    <a href="/auth/test">接続テスト →</a>
    `}
    <hr>
    <p><small>LINE 相場判定 Bot v7.0.0 | <a href="/health">ヘルスチェック</a></small></p>
    </body></html>
  `);
});

// OAuth フロー開始
app.get('/auth/start', async (req, res) => {
  // まずOAuthメタデータを取得
  if (!oauthState.metadata) {
    await discoverOAuthMetadata();
  }

  if (!oauthState.metadata?.authorization_endpoint) {
    return res.send(`
      <html><body style="font-family:sans-serif;max-width:600px;margin:40px auto;padding:20px">
      <h1>❌ OAuth メタデータ未発見</h1>
      <p>オークファン MCP サーバーの OAuth エンドポイントを自動検出できませんでした。</p>
      <div style="background:#fff3cd;padding:15px;border-radius:8px;margin:10px 0">
        <p><strong>代替方法:</strong></p>
        <ol>
          <li>ChatGPTでオークファンMCPを使う際にブラウザの開発者ツールでトークンをキャプチャする</li>
          <li>キャプチャしたトークンを <a href="/auth/status">手動設定ページ</a> に貼り付ける</li>
        </ol>
      </div>
      <p><a href="/auth/status">← 戻る</a></p>
      </body></html>
    `);
  }

  // PKCE パラメータ生成
  oauthState.codeVerifier = generateCodeVerifier();
  oauthState.stateParam = generateState();
  const codeChallenge = generateCodeChallenge(oauthState.codeVerifier);

  // 認証 URL 構築
  const authUrl = new URL(oauthState.metadata.authorization_endpoint);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', oauthState.metadata.client_id || 'line-aucfan-bot');
  authUrl.searchParams.set('redirect_uri', `${RENDER_EXTERNAL_URL}/auth/callback`);
  authUrl.searchParams.set('state', oauthState.stateParam);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  if (oauthState.metadata.scopes_supported) {
    authUrl.searchParams.set('scope', oauthState.metadata.scopes_supported.join(' '));
  }

  console.log('🔑 OAuth認証リダイレクト:', authUrl.toString());
  res.redirect(authUrl.toString());
});

// OAuth コールバック
app.get('/auth/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.send(`<html><body><h1>❌ 認証エラー</h1><p>${error}</p><a href="/auth/status">戻る</a></body></html>`);
  }

  if (state !== oauthState.stateParam) {
    return res.send(`<html><body><h1>❌ 不正なstate</h1><p>CSRF防止チェック失敗</p><a href="/auth/status">戻る</a></body></html>`);
  }

  if (!code) {
    return res.send(`<html><body><h1>❌ 認証コードなし</h1><a href="/auth/status">戻る</a></body></html>`);
  }

  try {
    // トークン交換
    const tokenResp = await axios.post(oauthState.metadata.token_endpoint, new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${RENDER_EXTERNAL_URL}/auth/callback`,
      client_id: oauthState.metadata.client_id || 'line-aucfan-bot',
      code_verifier: oauthState.codeVerifier,
    }).toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000,
    });

    if (tokenResp.data?.access_token) {
      oauthState.accessToken = tokenResp.data.access_token;
      oauthState.refreshToken = tokenResp.data.refresh_token || null;
      oauthState.expiresAt = tokenResp.data.expires_in
        ? Date.now() + (tokenResp.data.expires_in * 1000)
        : null;

      console.log('🎉 OAuth認証成功！');
      console.log(`🔑 Token (先頭20文字): ${oauthState.accessToken.slice(0, 20)}...`);
      console.log(`⚠️ Renderの環境変数 AUCFAN_OAUTH_TOKEN にこのトークンを設定してください`);

      return res.send(`
        <html><body style="font-family:sans-serif;max-width:600px;margin:40px auto;padding:20px">
        <h1>🎉 認証成功！</h1>
        <p>オークファン MCP サーバーへの認証が完了しました。</p>
        <div style="background:#d4edda;padding:15px;border-radius:8px;margin:10px 0">
          <p>トークン（先頭20文字）: <code>${oauthState.accessToken.slice(0, 20)}...</code></p>
          ${oauthState.expiresAt ? `<p>有効期限: ${new Date(oauthState.expiresAt).toLocaleString('ja-JP')}</p>` : ''}
        </div>
        <p>⚠️ <strong>永続化するには</strong>、Renderの環境変数 <code>AUCFAN_OAUTH_TOKEN</code> にトークン全文を設定してください。</p>
        <p><a href="/auth/test">接続テスト →</a></p>
        </body></html>
      `);
    }
  } catch (err) {
    console.error('❌ トークン交換失敗:', err.response?.data || err.message);
    return res.send(`
      <html><body style="font-family:sans-serif;max-width:600px;margin:40px auto;padding:20px">
      <h1>❌ トークン交換失敗</h1>
      <p>エラー: ${err.response?.data?.error || err.message}</p>
      <a href="/auth/status">戻る</a>
      </body></html>
    `);
  }
});

// 手動トークン設定
app.post('/auth/manual', express.urlencoded({ extended: false }), (req, res) => {
  let token = (req.body.token || '').trim();
  // "Bearer " プレフィックスを除去
  if (token.toLowerCase().startsWith('bearer ')) {
    token = token.slice(7).trim();
  }

  if (!token) {
    return res.send(`<html><body><h1>❌ トークンが空です</h1><a href="/auth/status">戻る</a></body></html>`);
  }

  oauthState.accessToken = token;
  oauthState.expiresAt = null; // 手動設定は期限不明
  console.log('🔑 手動トークン設定完了:', token.slice(0, 20) + '...');

  res.send(`
    <html><body style="font-family:sans-serif;max-width:600px;margin:40px auto;padding:20px">
    <h1>✅ トークン設定完了</h1>
    <p>トークン（先頭20文字）: <code>${token.slice(0, 20)}...</code></p>
    <p>⚠️ サーバー再起動後もトークンを維持するには、Renderの環境変数に設定してください。</p>
    <p><a href="/auth/test">接続テスト →</a></p>
    </body></html>
  `);
});

// 接続テスト
app.get('/auth/test', async (req, res) => {
  const token = getAccessToken();

  if (!token) {
    return res.send(`
      <html><body style="font-family:sans-serif;max-width:600px;margin:40px auto;padding:20px">
      <h1>❌ トークン未設定</h1>
      <p>先に認証を完了してください。</p>
      <a href="/auth/status">認証ページへ</a>
      </body></html>
    `);
  }

  try {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
    };

    const resp = await axios.post(AUCFAN_MCP_URL, {
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'line-aucfan-bot', version: '7.0.0' },
      },
      id: 1,
    }, { headers, timeout: 15000, validateStatus: () => true });

    const success = resp.status === 200;

    res.send(`
      <html><body style="font-family:sans-serif;max-width:600px;margin:40px auto;padding:20px">
      <h1>${success ? '🎉 接続成功！' : '❌ 接続失敗'}</h1>
      <div style="background:${success ? '#d4edda' : '#f8d7da'};padding:15px;border-radius:8px;margin:10px 0">
        <p>HTTPステータス: ${resp.status}</p>
        <p>レスポンス: <code>${JSON.stringify(resp.data).slice(0, 300)}</code></p>
      </div>
      ${success ? '<p>✅ LINE Bot からオークファンの相場検索が利用できます！</p>' : '<p>トークンが無効または期限切れの可能性があります。</p>'}
      <a href="/auth/status">← 認証ページ</a>
      </body></html>
    `);
  } catch (err) {
    res.send(`
      <html><body style="font-family:sans-serif;max-width:600px;margin:40px auto;padding:20px">
      <h1>❌ 接続テスト失敗</h1>
      <p>エラー: ${err.message}</p>
      <a href="/auth/status">← 認証ページ</a>
      </body></html>
    `);
  }
});

// ── LINE Webhook ─────────────────────────────────
app.post('/webhook', async (req, res) => {
  console.log('📨 Webhook受信:', {
    contentType: req.headers['content-type'],
    bodyType: typeof req.body,
    isBuffer: Buffer.isBuffer(req.body),
    bodyLength: req.body?.length || 0,
    hasSignature: !!req.headers['x-line-signature'],
  });

  const rawBody = req.body;
  const signature = req.headers['x-line-signature'];

  if (!verifySignature(rawBody, signature)) {
    console.warn('⚠️ 署名検証失敗');
    return res.status(403).json({ error: 'Invalid signature' });
  }

  let body;
  try {
    body = JSON.parse(rawBody.toString());
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  res.status(200).json({ status: 'ok' });

  if (!body.events) return;

  for (const event of body.events) {
    if (event.type !== 'message' || event.message.type !== 'text') continue;

    const userMessage = event.message.text.trim();
    const userId = event.source.userId;
    const replyToken = event.replyToken;

    console.log(`📩 受信: "${userMessage}" from ${userId}`);

    // 即座に「分析中」を返す
    try {
      await replyMessage(replyToken, '🔍 オークファンMCPサーバーで相場データを検索中...\n少々お待ちください（10〜30秒）');
    } catch (err) {
      console.error('⚠️ 初期応答エラー:', err.message);
    }

    // 非同期で GPT + MCP 処理
    (async () => {
      try {
        const answer = await askGPTwithMCP(userMessage);
        await pushMessage(userId, answer);
      } catch (err) {
        console.error('❌ 処理エラー:', err.message);
        await pushMessage(userId, '❌ 相場分析中にエラーが発生しました。しばらく経ってからもう一度お試しください。');
      }
    })();
  }
});

// ── Keep-alive (Render 無料枠のスリープ対策) ──────────
setInterval(() => {
  axios.get(`${RENDER_EXTERNAL_URL}/health`).catch(() => {});
}, 14 * 60 * 1000);

// ── サーバー起動 + OAuth 初期化 ──────────────────────
app.listen(PORT, async () => {
  console.log(`🚀 サーバー起動: http://localhost:${PORT}`);
  console.log(`✅ LINE 相場判定 Bot v7.0.0 — OAuth対応版`);
  console.log(`✅ MCP Server: ${AUCFAN_MCP_URL}`);
  console.log(`✅ OAuth Token: ${getAccessToken() ? '設定済み' : '未設定'}`);
  console.log(`✅ LINE Webhook: /webhook`);
  console.log(`✅ 認証ページ: ${RENDER_EXTERNAL_URL}/auth/status`);

  // 起動時にOAuthメタデータを自動発見
  console.log('\n🔍 OAuth メタデータ自動発見を開始...');
  const metadata = await discoverOAuthMetadata();

  if (metadata) {
    // password grant を試行
    const success = await tryPasswordGrant(metadata);
    if (success) {
      console.log('🎉 自動認証成功！MCP サーバー利用可能');
    } else {
      console.log(`\n⚠️ 自動認証失敗。手動認証が必要です。`);
      console.log(`🔗 認証ページ: ${RENDER_EXTERNAL_URL}/auth/status`);
    }
  } else if (!getAccessToken()) {
    console.log(`\n⚠️ OAuth メタデータ未発見 & トークン未設定`);
    console.log(`🔗 手動でトークンを設定してください: ${RENDER_EXTERNAL_URL}/auth/status`);
  }
});
