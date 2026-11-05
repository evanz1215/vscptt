# vscptt

在 VS Code 內瀏覽 PTT（唯讀）：登入、我的最愛、以名稱開啟看板、文章列表、閱讀文章。連線使用 WebSocket（`wss://ws.ptt.cc/bbs`），畫面以終端機模擬後解析。

> **免責聲明**：這是非官方、個人製作的 PTT 瀏覽工具，與 PTT 或批踢踢實業坊沒有關係，也未經其授權或認可。它只有唯讀功能（不會發文、推文、寄信或刪除），但仍會用你的帳號登入真實的 PTT；使用時請遵守 PTT 的站規與服務條款。作者不對帳號被停權、資料遺失或任何其他損失負責，風險由使用者自行承擔。

## 帳號安全

- 密碼只在你登入時輸入。選「記住帳號和密碼」才會儲存，且只存放在 VS Code 的 SecretStorage（系統的安全儲存空間）；帳號存在 globalState。
- 密碼不會寫進設定檔、記錄、輸出面板或錯誤訊息。畫面快照寫入輸出面板前，已遮蔽 IP 位址與帳號。
- 「PTT: 清除已儲存的帳密」可隨時刪除已儲存的資料。
- 公用電腦請選「都不記住」。
- 連線只會到 `wss://ws.ptt.cc/bbs`。唯一的例外是圖片預覽：滑鼠停在圖片連結上時，VS Code 會直接向該圖片網站下載圖片，對方會看到你的網路位址（可用 `vscptt.preview.images` 關閉）。

## 使用

1. 點活動列的「PTT」圖示，或從命令選擇區執行「PTT: 登入」。
2. 輸入帳號與密碼，並選擇是否記住。密碼只存放在 VS Code 的 SecretStorage，且只有選「記住帳號和密碼」才會儲存；帳號存在 globalState。
3. 在「看板」檢視可展開「我的最愛」與「已開啟的看板」；「PTT: 開啟看板…」可用名稱開啟任何看板。
4. 點文章開啟唯讀文件；右鍵可複製文章代碼或網址。
5. 搜尋：點看板旁的放大鏡（或「PTT: 搜尋看板…」），選標題關鍵字、作者或推文數（負數搜噓文數），結果會出現在「搜尋結果」群組，可載入更多、開文章、移除；登出時清除。

帳號在別處已登入時，只有你在對話框明確按「登出對方並登入」才會踢掉對方；預設保留對方連線。沒有自動重連，中斷後請用「PTT: 重新連線」。

### 設定（修改後下次登入生效）

| 設定                                                                                          | 預設            | 說明                                                                                              |
| --------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------- |
| `vscptt.login.duplicateSession`                                                               | `ask`           | 重複登入時詢問或固定處理                                                                          |
| `vscptt.login.autoLogin`                                                                      | `false`         | 啟動時用已記住的帳密自動登入                                                                      |
| `vscptt.connection.settleMs`                                                                  | 見 package.json | 畫面穩定等待毫秒                                                                                  |
| `vscptt.connection.stepTimeoutMs`                                                             | 見 package.json | 單一步驟逾時                                                                                      |
| `vscptt.connection.keepAliveSeconds`                                                          | 見 package.json | 保持連線間隔（0 關閉）                                                                            |
| `vscptt.article.maxPages`                                                                     | 30              | 一篇文章最多讀幾個畫面                                                                            |
| `vscptt.search.maxSaved`                                                                      | 10              | 「搜尋結果」最多保留幾組搜尋                                                                      |
| `vscptt.preview.images`                                                                       | true            | 滑鼠停在文章裡的圖片連結上時顯示預覽（圖片由 VS Code 直接向圖片網站下載，對方會看到你的網路位址） |
| `vscptt.cache.latestPageSeconds` / `olderPageSeconds` / `articleSeconds` / `favoritesSeconds` | 見 package.json | 各類快取秒數                                                                                      |

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

`.vsix` 只包含 `package.json`、`README.md`、`LICENSE`、`media/ptt.svg`、`out/extension.js`（由測試確認）。程式已用 esbuild 打成單一檔案，pnpm 與 vsce 的依賴檢查不相容，所以要加 `--no-dependencies`：

```bash
pnpm exec vsce package --no-dependencies
```

`package.json` 還沒有 `repository` 欄位，vsce 會警告；公開前請補上，或加 `--allow-missing-repository`。

## 已知限制

- 只能唯讀瀏覽。同一個帳號同時只有一條連線，操作會排隊執行，所以速度取決於 PTT 的回應。
- 「我的最愛」裡的資料夾與分隔線不會顯示，放在資料夾裡的看板看不到。
- 畫面是從終端機文字解析的；PTT 改版或遇到沒見過的畫面時，可能出現「畫面和預期不同」，這時請再試一次。
- 很長或有特殊換行的文章，內容可能被截斷（上限見 `vscptt.article.maxPages`）。
- 沒有自動重連，也沒有發文、推文、寄信等寫入功能。

## 授權

MIT，見 `LICENSE`。
