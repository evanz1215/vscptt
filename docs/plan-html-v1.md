> 此文件是 HTML 讀取方案的舊版計畫，已被 `plan.md`（WebSocket 版）取代，僅保留作為替代方案參考，內容不再維護。

# vscptt 功能開發計畫

> 建立日期：2026-11-03
> 狀態：規劃稿，待決事項見第 11 章
> 範圍：在 VS Code 內瀏覽 PTT（唯讀、以 HTML 讀取為主）

---

## 1. 目標與範圍

### 1.1 產品目標

在 VS Code 中瀏覽 PTT 看板與文章，介面貼近開發者習慣：左側樹狀檢視、文章以唯讀文件開啟、可搜尋與複製。

### 1.2 設計原則

1. **讀取走 HTML**：看板列表、文章列表、文章內容全部用 HTTP 取得，不模擬終端機，不需要登入。
2. **核心與 VS Code 分離**：`core/` 不 import `vscode`，才能單獨測試。
3. **對站方友善**：低並行、有快取、不預抓、誠實標示 User-Agent。
4. **文章用網址識別碼識別**：不使用數字 sn。
5. **最小完整**：MVP 只做瀏覽，其他功能分階段，不一次做完。

### 1.3 功能清單

| 階段     | 功能                                   | 說明                                    |
| -------- | -------------------------------------- | --------------------------------------- |
| MVP      | 熱門看板列表                           | 取自 `/bbs/hotboards.html`              |
| MVP      | 以名稱開啟看板                         | 輸入看板名，驗證存在後加入檢視          |
| MVP      | 看板文章列表                           | 最新頁 + 往較舊分頁載入，置頂文獨立顯示 |
| MVP      | 文章閱讀                               | 內文 + 推文，以唯讀文件開啟             |
| MVP      | 我的最愛                               | 本機儲存最愛看板，可新增、移除          |
| MVP      | 瀏覽器開啟 / 複製網址                  | 文章與看板都支援                        |
| MVP      | 重新整理                               | 看板、文章可手動重新整理並清除對應快取  |
| 第二階段 | 看板內搜尋                             | 標題關鍵字、作者、同標題串、推文數門檻  |
| 第二階段 | 設定項目                               | 請求間隔、並行數、快取時間              |
| 第三階段 | 語法高亮                               | 推噓箭頭、網址、引言                    |
| 第三階段 | 圖片連結預覽                           | 滑鼠移到圖片網址時顯示縮圖              |
| 第三階段 | 文章自動更新                           | 追蹤新推文，間隔不低於 5 秒             |
| 不做     | 登入、推文、發文、站內信、我的最愛同步 | 需要登入，超出唯讀範圍                  |

---

## 2. PTT 網頁結構（解析依據）

### 2.1 實測範圍

2026-11-03 對下列頁面各發出一次請求，檔案保存在規劃期間的暫存目錄，**不屬於專案**：

- `https://www.ptt.cc/bbs/hotboards.html`
- `https://www.ptt.cc/bbs/index.html`
- `https://www.ptt.cc/bbs/C_Chat/index.html`
- `https://www.ptt.cc/bbs/Gossiping/index.html`（含與不含 `over18=1` cookie 各一次）
- `https://www.ptt.cc/robots.txt`

**未實測**（需在 M0 以專案內的受控腳本取得）：文章內頁、搜尋結果頁、不存在的看板、已刪除文章、分類看板列表。

### 2.2 看板文章列表（已實測）

網址：`/bbs/<board>/index.html`（最新頁）、`/bbs/<board>/index<N>.html`（第 N 頁）

| 欄位       | 選擇器                | 備註                                                                                               |
| ---------- | --------------------- | -------------------------------------------------------------------------------------------------- |
| 一列文章   | `div.r-ent`           | C_Chat 最新頁共 24 列：分隔線前 20 篇一般文章，分隔線後 4 篇置頂                                   |
| 推文數     | `.nrec`               | 內文是數字或空白；顏色 class 為 `hl f1`～`f3`。`爆`、`X1` 等形式**未在本次樣本出現**，需 M0 補樣本 |
| 標題與連結 | `.title a[href]`      | 連結形如 `/bbs/C_Chat/M.1793671462.A.6C5.html`                                                     |
| 作者       | `.meta .author`       |                                                                                                    |
| 日期       | `.meta .date`         | `MM/DD`，**沒有年份**                                                                              |
| 標記       | `.meta .mark`         | 樣本出現空白、`M`、`!`                                                                             |
| 置頂分隔   | `div.r-list-sep`      | 在它之後的 `.r-ent` 是置頂文；置頂文有網址，可用網址識別                                           |
| 已刪除文章 | `.title` 內沒有 `<a>` | 本次樣本沒有出現，**待 M0 補樣本**                                                                 |

分頁（`.btn-group-paging` 內四個連結）：

- `最舊` → `index1.html`
- `上頁` → `index<N>.html`，N 是最新頁編號減 1
- `下頁`：停用狀態時沒有 `href`
- `最新` → `index.html`

載入更多的做法：先抓 `index.html`，從「上頁」取得 N，之後逐頁往下抓 `index<N-1>.html`…。N 不是固定值，每次都要從最新頁推得。

### 2.3 熱門看板（已實測）

網址：`/bbs/hotboards.html`（共 128 筆）

| 欄位         | 選擇器                             |
| ------------ | ---------------------------------- |
| 一列看板     | `div.b-ent`                        |
| 看板名與連結 | `a.board[href]` 內的 `.board-name` |
| 線上人數     | `.board-nuser`                     |
| 分類         | `.board-class`                     |
| 中文標題     | `.board-title`                     |

### 2.4 年齡確認與防護（已實測）

- 年齡確認是**前端 JS 檢查**：頁面內有一段腳本，沒有 `over18=1` cookie 就導向確認頁。伺服器本身對有無 cookie 都回傳 HTML（本次兩者除 Cloudflare 的隨機值外相同）。
- 請求時仍建議帶 `Cookie: over18=1`，行為較符合預期，也避免之後站方改成伺服器端檢查時失效。
- 頁面掛在 **Cloudflare** 之後（頁尾有 `cdn-cgi/challenge-platform` 腳本）。本次請求回應 200，但自動化請求之後可能遇到挑戰頁，見第 8 章 R2。

### 2.5 文章內頁（**未實測**，以下為預期，M0 必須以 fixtures 驗證）

網址：`/bbs/<board>/<id>.html`

預期結構，驗證前不得當成事實：

- 主體容器 `#main-content`
- 作者、標題、時間：`.article-metaline` 內的 `.article-meta-tag` 與 `.article-meta-value`；看板名在 `.article-metaline-right`
- 推文：`div.push`，內含 `.push-tag`（推／噓／→）、`.push-userid`、`.push-content`、`.push-ipdatetime`
- 發信站、文章網址等行：`span.f2`
- 圖片連結：可能被轉成 `a.richcontent`

### 2.6 搜尋（**未實測**）

預期網址 `/bbs/<board>/search?q=<查詢>`，運算子可能包含 `thread:`、`author:`、`recommend:`（列表頁的下拉選單已出現 `thread:` 與 `author:`）。分頁參數形式需實測。

---

## 3. 架構

### 3.1 分層

```
VS Code 層（src/vscode/）  ← 只做 UI 與 VS Code API 對接
        │ 呼叫
核心服務（src/core/service） ← 組合 http、解析、快取，對外只暴露領域方法
        │ 使用
http / parsers / cache      ← 各自獨立、可單獨測試
```

### 3.2 目錄結構

```
src/
  extension.ts
  core/
    models.ts            # 領域型別
    urls.ts              # 網址組合與文章識別碼解析
    service.ts           # PttService
    http/
      client.ts          # fetch 包裝：UA、cookie、逾時、重試
      rateLimiter.ts     # 並行上限 + 最小間隔
      errors.ts          # 錯誤種類
    parsers/
      hotBoards.ts
      boardPage.ts       # 看板列表頁與搜尋結果頁共用
      article.ts
    cache/
      ttlCache.ts
  vscode/
    config.ts            # 讀取設定
    commands.ts
    views/
      boardsTree.ts      # 熱門看板 + 看板文章
      favoritesTree.ts
    articleProvider.ts   # TextDocumentContentProvider
    render/
      articleText.ts     # Article → 純文字
    storage/
      favoritesStore.ts  # globalState
test/
  fixtures/              # 真實頁面快照 + 來源說明
  parsers/
  core/
  vscode/
docs/
  plan.md
```

### 3.3 領域模型

```ts
type ArticleId = string; // 例："M.1793671462.A.6C5"，取自網址檔名（不含 .html）

interface Board {
  name: string; // "Stock"
  title: string; // 中文標題
  category: string;
  onlineUsers: number;
}

interface ArticleSummary {
  id: ArticleId;
  board: string;
  title: string;
  author: string;
  date: string; // "11/03"，無年份
  push: string; // 原樣保留："", "9", "爆", "X1"…
  mark: string; // "", "M", "!"…
  isPinned: boolean;
  url: string;
}

interface BoardPage {
  board: string;
  pageIndex: number; // 此頁的 N；最新頁以推算值表示
  articles: ArticleSummary[]; // 一般文章（新到舊）
  pinned: ArticleSummary[];
  olderPageIndex?: number; // 沒有則已到最舊
}

interface Push {
  kind: '推' | '噓' | '→';
  userId: string;
  content: string;
  ipDateTime: string;
}

interface Article {
  id: ArticleId;
  board: string;
  title: string;
  author: string;
  time: string; // 文章內頁的完整時間
  bodyLines: string[];
  pushes: Push[];
  url: string;
}
```

設計說明：

- `push` 與 `date` 保持原字串，不做轉換，避免因為解析假設錯誤而丟資訊。
- 解析器只回傳資料，不做任何 I/O。

### 3.4 核心服務介面

```ts
interface PttService {
  getHotBoards(): Promise<Board[]>;
  checkBoardExists(name: string): Promise<boolean>;
  getBoardPage(board: string, pageIndex?: number): Promise<BoardPage>; // 不給 = 最新頁
  getArticle(board: string, id: ArticleId): Promise<Article>;
  search(board: string, query: SearchQuery, page?: number): Promise<BoardPage>; // 第二階段
  invalidate(board?: string, id?: ArticleId): void;
}
```

### 3.5 HTTP 層

| 項目       | 設計                                                                              |
| ---------- | --------------------------------------------------------------------------------- |
| 請求       | Node 內建 `fetch`                                                                 |
| User-Agent | `vscptt/<版本>`，誠實標示，不偽裝成瀏覽器                                         |
| Cookie     | 固定帶 `over18=1`                                                                 |
| 逾時       | 預設 10 秒，使用 `AbortSignal.timeout`                                            |
| 並行       | 預設上限 2                                                                        |
| 最小間隔   | 預設 400 ms                                                                       |
| 重試       | 僅對網路錯誤與 5xx，最多 2 次，指數退避；4xx 不重試                               |
| 防護處理   | 偵測 403／429／503 與挑戰頁特徵，歸類為 `blocked`，不重試，進入冷卻（預設 60 秒） |
| 錯誤種類   | `network`、`timeout`、`notFound`、`blocked`、`server`、`parse`                    |

### 3.6 快取

- 記憶體 TTL 快取，不寫磁碟。
- 建議時間：最新頁 60 秒、舊頁 10 分鐘、文章 5 分鐘、熱門看板 5 分鐘。
- 快取鍵：`board:<name>:page:<N|latest>`、`article:<board>:<id>`、`hot`。
- 同一個鍵的並行請求合併為一個（in-flight 去重）。
- 手動重新整理時清除對應鍵。

---

## 4. VS Code 整合

### 4.1 檢視

在活動列新增 **PTT** 容器，包含兩個檢視：

1. **我的最愛**：最愛看板，展開後是文章列表。
2. **熱門看板**：熱門看板清單，展開後是文章列表。

看板節點展開後依序顯示：置頂文（獨立分組，預設折疊）、一般文章（新到舊）、最後一個「載入更多（較舊）」節點。

文章節點：

- 標籤：標題
- 描述：`[推文數] 作者 日期`
- tooltip：完整標題、作者、日期、推文數、標記
- 點擊：開啟文章

### 4.2 文章顯示

**建議做法：`TextDocumentContentProvider`**，scheme 為 `vscptt`，網址形如 `vscptt:/<board>/<id>`。

|                      | TextDocumentContentProvider  | FileSystemProvider | Webview         |
| -------------------- | ---------------------------- | ------------------ | --------------- |
| 唯讀                 | 天然唯讀                     | 要自行回報唯讀     | 天然唯讀        |
| 程式量               | 最少                         | 中等               | 最多            |
| 搜尋、複製、鍵盤操作 | 完整支援                     | 完整支援           | 需自行實作      |
| 語法高亮             | 可用自訂語言 + TextMate 文法 | 同左               | 自行用 HTML/CSS |
| 圖片內嵌             | 不支援                       | 不支援             | 支援            |

建議先用 TextDocumentContentProvider，因為「像讀程式碼一樣讀文章」最符合 VS Code 使用情境，也最少程式碼。需要內嵌圖片時，再在第三階段另開 Webview 預覽，不改動文字文件的做法。

文章文字格式：

```
標題：<title>
作者：<author>
看板：<board>
時間：<time>
網址：<url>
──────────────────────────────
<內文>
──────────────────────────────
推 userid: 內容                       MM/DD HH:mm
噓 userid: 內容                       MM/DD HH:mm
→ userid: 內容                        MM/DD HH:mm
```

### 4.3 指令

| 指令 ID                 | 用途             | 出現位置         |
| ----------------------- | ---------------- | ---------------- |
| `vscptt.refresh`        | 重新整理目前檢視 | 檢視標題列       |
| `vscptt.openBoard`      | 輸入看板名開啟   | 檢視標題列       |
| `vscptt.addFavorite`    | 加入最愛         | 看板節點右鍵     |
| `vscptt.removeFavorite` | 移除最愛         | 最愛節點右鍵     |
| `vscptt.loadMore`       | 載入較舊文章     | 「載入更多」節點 |
| `vscptt.openArticle`    | 開啟文章         | 文章節點點擊     |
| `vscptt.openInBrowser`  | 用瀏覽器開啟     | 看板、文章右鍵   |
| `vscptt.copyUrl`        | 複製網址         | 看板、文章右鍵   |
| `vscptt.clearCache`     | 清除快取         | 命令面板         |
| `vscptt.search`         | 看板內搜尋       | 第二階段         |

### 4.4 設定

| 設定                               | 預設 | 說明             |
| ---------------------------------- | ---- | ---------------- |
| `vscptt.requestIntervalMs`         | 400  | 請求之間最小間隔 |
| `vscptt.maxConcurrentRequests`     | 2    | 並行上限         |
| `vscptt.cache.latestPageSeconds`   | 60   | 最新頁快取       |
| `vscptt.cache.archivedPageSeconds` | 600  | 舊頁快取         |
| `vscptt.cache.articleSeconds`      | 300  | 文章快取         |

### 4.5 最愛儲存

使用 `ExtensionContext.globalState` 儲存看板名陣列，並呼叫 `setKeysForSync` 讓它隨 Settings Sync 同步。只存看板名，不存帳密或內容。

---

## 5. 解析設計原則

1. **選擇器集中**：每個解析器檔案頂端用一個常數物件放所有選擇器，改版時只改一處。
2. **缺欄位要明確失敗**：關鍵欄位（文章網址、看板名）解析不到，拋出 `parse` 錯誤，並在訊息中帶上選擇器名稱，不回傳半成品。
3. **容忍非關鍵欄位缺失**：標記、推文數缺失時用空字串。
4. **不假設編碼**：回應是 UTF-8（本次 `Content-Type` 為 `text/html; charset=utf-8`）。
5. **文字清理**：HTML 實體解碼交給 cheerio，不手寫。

---

## 6. 測試策略

| 層級       | 內容                                                 | 工具              |
| ---------- | ---------------------------------------------------- | ----------------- |
| 解析器     | 以 `test/fixtures/` 的真實快照驗證輸出               | vitest            |
| HTTP 層    | 以假的 `fetch` 驗證重試、退避、逾時、並行上限、冷卻  | vitest + 假計時器 |
| 快取       | TTL、去重、失效                                      | vitest            |
| 核心服務   | 假的 http 客戶端，驗證分頁推算與快取鍵               | vitest            |
| 文章轉文字 | 快照比對輸出                                         | vitest            |
| VS Code 層 | 樹狀資料提供者以假的服務測試；整體流程用 F5 手動清單 | vitest + 手動     |

Fixtures 規則：

- 檔名帶抓取日期，並附 `README` 記錄來源網址、抓取日期與用途。
- 只選公開看板的文章，內容精簡到足以覆蓋案例，避免保留不必要的個人資訊。
- 抓取由專案內腳本 `pnpm run fixtures:capture` 執行，內建與 HTTP 層相同的限流，**不納入預設測試與 CI**。

必須涵蓋的案例（M0 完成條件）：

1. 熱門看板列表
2. 看板最新頁（含置頂文）
3. 看板舊頁
4. 推文數的各種形式（數字、爆、負數）
5. 已刪除文章的列表列
6. 文章內頁：含推文、含圖片連結、含引言
7. 不存在的看板
8. 不存在或已刪除的文章
9. 搜尋結果頁（第二階段才需要）

---

## 7. 里程碑

### M0：實測與 fixtures

- 做什麼：建立 `fixtures:capture` 腳本（含限流），取得第 6 章列出的案例並保存；寫出各解析器的雛形。
- 完成條件：
  - 案例 1～8 的 fixtures 與來源說明已入庫。
  - 第 2.5 節的預期結構逐項標示「已驗證」或「與預期不同」，並回寫本文件。
  - 解析器對所有 fixtures 輸出符合預期（vitest 通過）。
  - 以此結果確認 D1，不通過就回到本計畫調整方案。

### M1：核心服務

- 做什麼：http 客戶端、限流、快取、`PttService`。
- 完成條件：
  - 第 6 章列出的 HTTP 層、快取、服務層測試通過。
  - `pnpm run typecheck`、`lint`、`test` 全部通過。
  - `core/` 內沒有任何 `vscode` import（可用 lint 規則或測試檢查）。

### M2：看板與文章列表檢視

- 做什麼：活動列容器、熱門看板、看板展開、載入更多、置頂分組、以名稱開啟看板、我的最愛。
- 完成條件：
  - 樹狀資料提供者的單元測試通過。
  - F5 手動清單通過：看板可展開、載入更多會往較舊頁、最愛重新啟動後仍在、不存在的看板有明確提示。

### M3：文章閱讀

- 做什麼：內容提供者、文章轉文字、瀏覽器開啟、複製網址、重新整理。
- 完成條件：
  - 文章轉文字的快照測試通過。
  - F5 手動清單通過：點文章開啟唯讀文件、推文完整、已刪除或失效文章有明確訊息、重新整理會更新內容。

### M4：搜尋

- 做什麼：標題、作者、同標題串、推文數門檻。
- 完成條件：
  - 搜尋結果頁 fixtures 與解析測試通過（需先補第 2.6 節實測）。
  - F5 手動清單通過。

### M5：收尾與發佈準備

- 做什麼：錯誤訊息整理、設定項目、README、`vsce package`、CI。
- 完成條件：
  - `pnpm run package` 產出 `.vsix` 並可安裝。
  - README 包含功能說明、設定、限制與免責聲明。
  - CI（typecheck、lint、format:check、test、build）通過。

### 後續（視需求）

語法高亮、圖片預覽、文章自動更新、磁碟快取。

---

## 8. 風險與對策

| 編號 | 風險                                                                                                            | 影響               | 對策                                                                                                                                       |
| ---- | --------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| R1   | **站方政策**：`robots.txt` 對一般代理（`*`）允許，但明確禁止多個 AI 代理，並宣告 `ai-train=no`、`use=reference` | 方案合規性         | 擴充功能是使用者操作的瀏覽客戶端，不做訓練、不批次抓取、不預抓；README 明確寫出。**我沒有查證 PTT 的使用條款，發佈前需由你確認**（D1、D5） |
| R2   | **Cloudflare 防護**：自動化請求可能被擋或出現挑戰頁                                                             | 功能無法使用       | 偵測並歸類 `blocked`，冷卻後再試；訊息中提示改用瀏覽器開啟。**不偽裝成瀏覽器、不繞過挑戰**                                                 |
| R3   | **HTML 改版**：選擇器失效                                                                                       | 列表或文章無法顯示 | 選擇器集中、明確的 `parse` 錯誤、fixtures 回歸測試、`fixtures:capture` 可手動重抓比對                                                      |
| R4   | **請求過量**                                                                                                    | 被封鎖、影響站方   | 並行 2、間隔 400 ms、快取、去重、不預抓                                                                                                    |
| R5   | **日期沒有年份**                                                                                                | 跨年排序或顯示不準 | 列表只顯示原字串；文章內頁顯示完整時間                                                                                                     |
| R6   | **內容與隱私**：文章含他人資料                                                                                  | 隱私               | 只在記憶體快取，不寫磁碟；fixtures 精簡                                                                                                    |
| R7   | 文章內頁、搜尋頁結構與預期不同                                                                                  | 計畫細節需調整     | M0 先驗證，再開始 M1 之後的工作                                                                                                            |

---

## 9. 非功能需求

- **相容性**：`engines.vscode` 為 `^1.100.0`，`@types/vscode` 鎖 `1.100.0`。
- **效能**：首次展開看板應只發出 1～2 個請求（最新頁；必要時多一次推算頁碼）。
- **失敗體驗**：任何網路或解析錯誤，不能讓樹狀檢視整個空白；錯誤要顯示在節點上並可重試。
- **無背景流量**：未開啟任何看板時，不發出任何請求。

---

## 10. 開發流程約定

- 每個里程碑獨立 commit 與驗證，完成條件逐項通過才進入下一個。
- `pnpm run typecheck`、`lint`、`format:check`、`test`、`build` 全部通過才能 commit。
- 文件與計畫的實測事實要附日期；與實測不符時先更新本文件。

---

## 11. 待你決定的事項

| 編號 | 問題                                                                                         | 我的建議                                                    |
| ---- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| D1   | 是否採用 HTML 爬取方案？（`robots.txt` 對 `*` 允許，但站點有 AI 代理限制與 Cloudflare 防護） | 採用，使用誠實 UA、低頻率；M0 實測後再最終確認              |
| D2   | 文章用文字文件或 Webview 顯示？                                                              | 文字文件（TextDocumentContentProvider）；圖片預覽放第三階段 |
| D3   | MVP 是否包含搜尋？                                                                           | 不含，放 M4                                                 |
| D4   | 最愛看板如何儲存？                                                                           | `globalState` + Settings Sync                               |
| D5   | 是否上架 Marketplace？                                                                       | 先自用；上架前先確認 PTT 使用條款，並在 UA 加上專案連結     |
| D6   | 是否保留 WebSocket 登入功能？                                                                | 不做，第一版只讀取                                          |
