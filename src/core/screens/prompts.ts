/** The 24 lines of the screen. Every screen check is a pure function of these. */
export type Lines = readonly string[];

const row = (lines: Lines, i: number): string => lines[i] ?? '';
const all = (lines: Lines): string => lines.join('\n');

// Text that other people write (article titles, bodies, pushes) can appear on any list or article row, so
// checks that decide what to TYPE look at the fixed rows where the BBS draws its own prompts, never at the
// whole screen.

// Pre-login screens are Big5, so only ASCII ("guest") is safe to look for there.
export const isLoginPrompt = (l: Lines): boolean => all(l).includes('guest');
// Match the full prompt: the Big5 splash also says "忘記密碼可參考…".
export const isPasswordPrompt = (l: Lines): boolean => all(l).includes('請輸入您的密碼');

export const isWrongPassword = (l: Lines): boolean => all(l).includes('密碼不對');
export const isNoSuchAccount = (l: Lines): boolean => all(l).includes('無此帳號');
export const isTryLater = (l: Lines): boolean => all(l).includes('請稍後再試');
export const isFrequentLoginNotice = (l: Lines): boolean => all(l).includes('請勿頻繁登入');
export const isDuplicateLoginPrompt = (l: Lines): boolean => all(l).includes('刪除其他重複登入');
export const isDeleteAttemptsPrompt = (l: Lines): boolean => all(l).includes('刪除以上錯誤嘗試');

/**
 * "請按任意鍵繼續" is drawn on the last row (also under the AID box and on the goodbye screen). Some login
 * screens put it one row higher, but then the last row is empty; a list or article never has an empty last row.
 */
export const isAnyKeyPrompt = (l: Lines): boolean =>
  row(l, 23).includes('任意鍵') || (row(l, 22).includes('任意鍵') && row(l, 23).trim() === '');

/**
 * The same prompt while logging in. No list or article is on screen yet, so nothing a user wrote can be
 * mistaken for it. Every login screen seen so far had it on row 23; row 22 is kept because an older client
 * checked both rows, so a notice that uses row 22 would not leave the login stuck.
 */
export const isLoginAnyKeyPrompt = (l: Lines): boolean =>
  row(l, 22).includes('任意鍵') || row(l, 23).includes('任意鍵');

export const isMainMenu = (l: Lines): boolean => row(l, 0).startsWith('【主功能表】');
/** Drawn on row 22 over the main menu (row 0 still says 主功能表). */
export const isLogoutConfirm = (l: Lines): boolean =>
  isMainMenu(l) && row(l, 22).includes('您確定要離開');
export const isBoardSelectPrompt = (l: Lines): boolean =>
  row(l, 0).startsWith('【 選擇看板 】') && row(l, 1).includes('請輸入看板名稱');

/** The prompt PTT draws on the last row after /, a or Z. Nothing a user wrote is ever on that row. */
export const isSearchPrompt = (l: Lines): boolean =>
  /^搜尋(標題|作者|推文數)/.test(row(l, 23).trimStart());

/** `#` on a list asks for an article code on the last row: "搜尋文章代碼(AID): #". */
export const isAidPrompt = (l: Lines): boolean => row(l, 23).trimStart().startsWith('搜尋文章代碼');

/** Drawn on the last row, over a normal list, when a search matched nothing (with a "press any key" prompt). */
export const isNoSearchResult = (l: Lines): boolean => row(l, 23).includes('找不到符合條件的文章');
