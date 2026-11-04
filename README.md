# vscptt

在 VS Code 內瀏覽 PTT（唯讀）：登入、我的最愛、以名稱開啟看板、文章列表、閱讀文章。連線使用 WebSocket（`wss://ws.ptt.cc/bbs`），畫面以終端機模擬後解析。

## 使用

1. 點活動列的「PTT」圖示，或從命令選擇區執行「PTT: 登入」。
2. 輸入帳號與密碼，並選擇是否記住。密碼只存放在 VS Code 的 SecretStorage，且只有選「記住帳號和密碼」才會儲存；帳號存在 globalState。
3. 在「看板」檢視可展開「我的最愛」與「已開啟的看板」；「PTT: 開啟看板…」可用名稱開啟任何看板。
4. 點文章開啟唯讀文件；右鍵可複製文章代碼或網址。
5. 搜尋：點看板旁的放大鏡（或「PTT: 搜尋看板…」），選標題關鍵字、作者或推文數（負數搜噓文數），結果會出現在「搜尋結果」群組，可載入更多、開文章、移除；登出時清除。

帳號在別處已登入時，只有你在對話框明確按「登出對方並登入」才會踢掉對方；預設保留對方連線。沒有自動重連，中斷後請用「PTT: 重新連線」。

### 設定（修改後下次登入生效）

| 設定                                                                                          | 預設            | 說明                         |
| --------------------------------------------------------------------------------------------- | --------------- | ---------------------------- |
| `vscptt.login.duplicateSession`                                                               | `ask`           | 重複登入時詢問或固定處理     |
| `vscptt.login.autoLogin`                                                                      | `false`         | 啟動時用已記住的帳密自動登入 |
| `vscptt.connection.settleMs`                                                                  | 見 package.json | 畫面穩定等待毫秒             |
| `vscptt.connection.stepTimeoutMs`                                                             | 見 package.json | 單一步驟逾時                 |
| `vscptt.connection.keepAliveSeconds`                                                          | 見 package.json | 保持連線間隔（0 關閉）       |
| `vscptt.article.maxPages`                                                                     | 30              | 一篇文章最多讀幾個畫面       |
| `vscptt.search.maxSaved`                                                                      | 10              | 「搜尋結果」最多保留幾組搜尋 |
| `vscptt.cache.latestPageSeconds` / `olderPageSeconds` / `articleSeconds` / `favoritesSeconds` | 見 package.json | 各類快取秒數                 |

## 開發

```bash
pnpm install
pnpm run build       # bundle to out/extension.js
pnpm run typecheck   # tsc --noEmit
pnpm run lint        # oxlint
pnpm run format:check
pnpm run test        # vitest (never touches the network)
pnpm run watch       # rebuild on change
```

按 F5 啟動 Extension Development Host。介面的手動驗證步驟見 `docs/manual-checklist.md`；設計與里程碑見 `docs/plan.md`。

### 真實連線測試（選用）

`test/smoke/live.test.ts`（核心層）與 `test/smoke/liveUi.test.ts`（經過擴充功能層）會登入真實 PTT，只讀取，結束時登出。沒有明確開啟就會略過，絕不放進 CI。帳密只能經環境變數傳入，不要寫進檔案或貼到任何地方。

```bash
# bash
PTT_LIVE=1 PTT_USER=<id> PTT_PASS=<password> pnpm exec vitest run test/smoke
```

```powershell
# PowerShell
$env:PTT_LIVE='1'; $env:PTT_USER='<id>'; $env:PTT_PASS='<password>'; pnpm exec vitest run test/smoke
```

避免短時間重複執行：PTT 會限制頻繁登入。若帳號已在別處登入，測試會保留對方連線並略過。

## 打包

```bash
pnpm run package     # produces a .vsix
```

打包前請在 `package.json` 設定 `publisher`。`.vsix` 只包含 `package.json`、`README.md`、`media/ptt.svg`、`out/extension.js`（由測試確認）。
