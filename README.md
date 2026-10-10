# agents-workers

部署在 Cloudflare Workers 免費版中的 AI Agent。

GitHub 倉庫：[`scupro/agents-workers`](https://github.com/scupro/agents-workers)

## 功能

- **多模型自動路由**：`clef-flash`（決策模型）分類任務 →
  - 路由/決策：`@cf/cloudflare/clef-flash`
  - Agent 任務 & 對話：`@cf/meta/llama-3.1-8b-instruct-fp8-fast`（不存在時自動回退 `…-fp8`）
  - 代碼：`@cf/mistralai/mistral-small-3.1-24b-instruct`（回退 `@cf/mistral/…` 舊 slug）
- **免費額度自動切換(Neurons 制)**:Workers AI 免費版 = **每日 10,000 Neurons**(UTC 重置)。按官方單價表本地估算消耗寫入 KV 每日計數,達安全線 8000 或被 CF 實際拒服時自動切外接 API(OpenAI 兼容格式,支持 OpenRouter/DeepSeek/Moonshot 等);前端也可**手動**鎖定 Workers AI / 外接 API
- **工具調用**：`exec_code`、`doc_read`、`doc_write`、`list_docs`、`memory_set`、`memory_get`、`list_memory`、`read_skill`
- **文檔存儲**：D1（會話/消息）+ KV（文檔/記憶/用量計數）；前端帶 localStorage 降級
- **Memory**:短期會話上下文 + 長期 KV 記憶(自動注入 system prompt)
- **Skills**：
  - 內建行為技能:general / code / docs / memory(前端多選啟用)
  - 預設加載 [mattpocock/skills](https://github.com/mattpocock/skills) 常用精選:`tdd`、`code-review`、`implement`、`pr`、`research`(MIT 授權,存於 `public/skills/*.md`,按需 `read_skill` 加載全文,不佔 prompt 空間)
- **Web 前端**:原生 JS 聊天界面,顯示每條回覆的模型/任務類型/路由來源

## 目錄結構

```
agents/
├── wrangler.json          # CF 配置（D1 / KV / Workers AI + models）
├── migrations/0001_init.sql
├── src/
│   ├── index.js           # 入口:路由 + 靜態服務
│   ├── llm.js             # LLM 適配:多模型路由 + 額度自動切換
│   ├── router.js          # 任務分類(clef-flash,失敗降級關鍵詞启发式)
│   ├── usage.js           # 免費額度計數 + provider override
│   ├── agent.js           # Agent 循環(JSON tool-call 協議,上限 4 輪)
│   ├── tools.js           # 工具註冊表(含 read_skill)
│   ├── skills.js          # 內建技能 + vendor skills 清單
│   ├── kv.js / memory.js / db.js / routes.js
└── public/
    ├── index.html / app.js / style.css
    └── skills/            # mattpocock 精選 skills + index.json
```

## 模型路由一覽

| 角色 | 默認模型 | 變量 |
|------|----------|------|
| 路由/決策 | `@cf/cloudflare/clef-flash` | `ROUTER_MODEL` |
| Agent/對話 | `@cf/meta/llama-3.1-8b-instruct-fp8-fast` → 回退 `…-fp8` | `AGENT_MODEL` / `AGENT_MODEL_FALLBACK` |
| 代碼 | `@cf/mistralai/mistral-small-3.1-24b-instruct` → 回退 `@cf/mistral/…`（舊 slug） | `CODE_MODEL` / `CODE_MODEL_FALLBACK` |
| 外接(自動/手動) | `LLM_MODEL`(代碼可用 `LLM_CODE_MODEL`) | `LLM_API_KEY` / `LLM_BASE_URL` |

路由失敗(本地開發、模型下線、無綁定)自動降級為關鍵詞启发式,**永不因分類不可用而阻斷對話**。

## 免費額度 → 外接 API 切換(Neurons 制)

CF 免費版實際計量 = **每日 10,000 Neurons,UTC 00:00 重置**(來源:[官方定價頁](https://developers.cloudflare.com/workers-ai/platform/pricing/)),不是調用次數。Worker 內讀不到 CF 權威 neuron 計數(那需要 Dashboard 或 API token 權限),因此採用**本地估算**:

1. 每次 Workers AI 調用(含 clef-flash 路由)經 `runAI()` 計量:
   - 響應帶 `usage` tokens → 按 `usage.js` 內置官方單價表精確換算(如 llama-fp8-fast:4119 n/M 輸入、34868 n/M 輸出;clef-flash:8182 n/M 僅輸入)
   - 無 `usage` → chars/4 估算(±20%)
   - 典型對話一次 ≈ 10–25 neurons → 10,000 約撐 400–800 次/日
2. 每日累計寫入 KV `ai:neurons:YYYY-MM-DD`(UTC 日期 key,次日自動歸零,TTL 3 天自清)
3. 三種切換方式:
   - **估算安全線**:累計 ≥ `NEURON_SAFE_LIMIT`(默認 8000,留 20% 緩衝)→ auto 直接走外接,連 clef-flash 也不再調用
   - **錯誤兜底**:CF 真實拒服(quota/429/limit 錯誤)→ 標記 `ai:exhausted:<當日>` → 走外接
   - **手動**:`POST /api/provider {"provider":"auto"|"workers_ai"|"openai"}` 或前端下拉框(持久化 override,推薦金鑰不全信估算時用)

### 估算的已知誤差(所以才設 8000 安全線)

- KV get+put 非原子 → 高併發會少計
- 10,000/日是**帳號級**額度,同帳號其他 Worker 的消耗本專案看不見
- 權威用量以 [Workers AI Dashboard](https://dash.cloudflare.com/?to=/:account/ai/workers-ai) 為準

恢復免費額度:UTC 次日自動重置;急用可手動刪 KV `ai:exhausted:<日期>` key(`npx wrangler kv key delete ...`)。若完全不想用外接 API,留空金鑰即可——超線後仍可強制 `workers_ai` 模式(CF 端自然拒服)。

## 快速開始

### 1. 安裝依賴並登錄

```bash
cd agents
npm install
npx wrangler login
```

### 2. 創建數據庫

```bash
# D1 數據庫（存會話和消息）
npx wrangler d1 create agent-db

# KV 命名空間（存文檔和記憶）
npx wrangler kv:namespace create DOCS
```

將輸出中創建的 `database_id` 和 `id` 填入 `wrangler.json` 中对应的占位符：

```json
"d1_databases": [{ "binding": "DB", "database_id": "<你的D1 ID>", "database_name": "agent-db", ... }],
"kv_namespaces": [{ "binding": "DOCS", "id": "<你的KV ID>", ... }]
```

### 3. 應用 D1 遷移

```bash
npx wrangler d1 migrations apply agent-db
```

### 4. 配置外接 API Key(推薦,額度用盡自動切換需要)

```bash
# 金鑰用 secret(加密存儲)
npx wrangler secret put LLM_API_KEY

# 其餘(非敏感)可寫在 wrangler.json vars 中:
#   "vars": { "LLM_BASE_URL": "https://api.openrouter.ai/v1", "LLM_MODEL": "deepseek/deepseek-chat-v3-0324", "LLM_CODE_MODEL": "deepseek/deepseek-chat-v3-0324" }
```

兼容任何 OpenAI 格式 API(OpenRouter、Groq、DeepSeek、Moonshot、DeepInfra 等)。若完全不想用外接 API,可保持留空——此時只用 Workers AI,無自動降級。

### 5. 部署

```bash
npx wrangler deploy
```

打開 `https://agents-workers.<你的子域>.workers.dev` 即可使用。

## 通過 GitHub Actions 自動部署

推送到 `main` 分支會自動觸發部署。

### 1. 添加 GitHub Secrets

在 GitHub 倉庫 [Settings → Secrets and variables → Actions](https://github.com/scupro/agents-workers/settings/secrets/actions) 添加：

**必填：**

| Secret | 說明 | 來源 |
|--------|------|------|
| `CF_API_TOKEN` | Cloudflare API Token(有 Workers 部署權限) | Cloudflare Dashboard → My Profile → API Tokens |
| `CF_ACCOUNT_ID` | Cloudflare 帳號 ID | Cloudflare Dashboard → 右上角帳號名 → Account ID |
| `D1_DATABASE_ID` | D1 數據庫 ID | `npx wrangler d1 info` 或 Dashboard → D1 → Database → ID |
| `KV_DOCS_ID` | KV 命名空間 ID | `npx wrangler kv:namespace list` 或 Dashboard → KV → Namespace → ID |

**可選**(啟用外接 API 降級)：

| Secret | 說明 | 範例 |
|--------|------|------|
| `LLM_API_KEY` | 外接 LLM API 金鑰 | `sk-or-...`(OpenRouter)、`sk-...`(DeepSeek) |
| `LLM_BASE_URL` | API Base URL(OpenAI 兼容) | `https://api.openrouter.ai/v1` |
| `LLM_MODEL` | 外接模型名 | `deepseek/deepseek-chat-v3-0324` |
| `LLM_CODE_MODEL` | 代碼模型名(可省略,默認同 LLM_MODEL) | — |

**可選 Variables**(在 [Settings → Variables](https://github.com/scupro/agents-workers/settings/variables/actions) 添加)：

| Variable | 說明 | 默認值 |
|----------|------|--------|
| `NEURON_SAFE_LIMIT` | 每日 Neurons 安全線(超過自動切換外接) | `8000` |

### 2. 確認 wrangler.json 中的佔位符

`.github/workflows/deploy.yml` 會在部署前用 `sed` 替換 `wrangler.json` 中的：

```json
"d1_databases": [{ "database_id": "${D1_DATABASE_ID}", ... }],
"kv_namespaces": [{ "id": "${KV_DOCS_ID}", ... }]
```

確保這些佔位符與 secrets 中的 key 名稱一致。

### 3. 啟用 LLM 降級(可選)

如需自動切換外接 API,在 `.github/workflows/deploy.yml` 的 `Deploy` step 的 `env:` 中取消註釋：

```yaml
env:
  CF_API_TOKEN: ${{ secrets.CF_API_TOKEN }}
  CF_ACCOUNT_ID: ${{ secrets.CF_ACCOUNT_ID }}
  LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
  LLM_BASE_URL: ${{ secrets.LLM_BASE_URL }}
  LLM_MODEL: ${{ secrets.LLM_MODEL }}
  LLM_CODE_MODEL: ${{ secrets.LLM_CODE_MODEL }}
  NEURON_SAFE_LIMIT: ${{ vars.NEURON_SAFE_LIMIT }}
```

> **注意**：`wrangler-action` 的 `env` 中的變量會作為 `wrangler secret` 注入 Worker(加密)。`LLM_BASE_URL` 和 `LLM_MODEL` 其實不敏感,也可寫入 wrangler.json `vars` 避免每次都用 secret 覆蓋。

## 本地開發

```bash
npx wrangler dev
# 打開 http://localhost:8787
```

本地開發模式下，D1/KV 使用 Cloudflare 模擬器，數據存於 `.wrangler/`。

## 瀏覽器本地存儲(降級路徑)

後端不可達時(如 `wrangler dev` 未綁定 D1/KV),前端自動降級:
- 會話列表快取在 `localStorage`(`agents-workers.sessions`)
- 消息歷史仍以後端 D1 為準;若需完全離線運行,可在 `public/app.js`
  的 `send()` 錯誤分支擴展本地消息存儲
當前默認使用 D1 + KV(免費額度足夠個人使用):

| 資源 | 免費額度 | 用途 |
|------|---------|------|
| D1 | 5GB 存儲 + 500M 行讀 | 會話/消息 |
| KV | 1GB 寫 + 10億 讀 | 文檔/記憶 |
| Workers AI | 每日 10,000 Neurons（帳號級，UTC 重置） | LLM |

## 免費版限制提醒

- 請求體大小：100KB（Workers 免費版）
- 會話歷史會話：自動分頁，限制 token
- 文檔大小：KV 值 ≤ 25MB，建議 < 1MB
