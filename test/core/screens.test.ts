import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { UnexpectedScreenError } from '../../src/core/errors';
import { parseAidPopup } from '../../src/core/screens/aidPopup';
import {
  mergePages,
  parseArticle,
  parseArticlePage,
  parseArticleStatus,
} from '../../src/core/screens/article';
import { isBoardList, parseBoardList } from '../../src/core/screens/boardList';
import { isFavoritesScreen, parseFavorites } from '../../src/core/screens/favorites';
import {
  isAnyKeyPrompt,
  isBoardSelectPrompt,
  isDuplicateLoginPrompt,
  isLoginAnyKeyPrompt,
  isLoginPrompt,
  isLogoutConfirm,
  isMainMenu,
  isPasswordPrompt,
} from '../../src/core/screens/prompts';

// Real screens captured from the live server on 2026-11-03, with IP addresses replaced by 0.0.0.0.
const screen = (name: string): string[] => {
  const lines = readFileSync(`test/fixtures/screens/${name}.txt`, 'utf8').split('\n').slice(0, 24);
  while (lines.length < 24) {
    lines.push('');
  }
  return lines;
};

describe('board list', () => {
  const entry = parseBoardList(screen('board_list_entry'))!;

  it('recognises the screen and reads the board name', () => {
    expect(isBoardList(screen('board_list_entry'))).toBe(true);
    expect(entry.board).toBe('Soft_Job');
    expect(isBoardList(screen('favorites'))).toBe(false);
  });

  it('reads every column of a normal row', () => {
    const row = entry.rows.find((r) => r.number === 36731)!;
    expect(row).toMatchObject({
      selected: true,
      isPinned: false,
      mark: '',
      push: '5',
      date: '11/01',
      author: 'waper',
      kind: 'normal',
      title: '[請益] 中高齡找短期約聘軟工',
    });
    const marked = entry.rows.find((r) => r.number === 36715)!;
    expect(marked).toMatchObject({ mark: '~', push: '42', date: '10/11' });
  });

  it('puts the cursor on the newest normal article when a board is entered', () => {
    expect(entry.selected?.number).toBe(36731);
    expect(entry.rows).toHaveLength(20);
  });

  it('separates pinned rows (★), which have no number', () => {
    const pinned = entry.rows.filter((r) => r.isPinned);
    expect(pinned).toHaveLength(3);
    expect(pinned.every((r) => r.number === undefined)).toBe(true);
    expect(pinned[0]).toMatchObject({ mark: '!', push: '1', date: '8/04', author: 'MOONY135' });
    expect(pinned[0]!.screenRow).toBeGreaterThan(entry.selected!.screenRow);
  });

  it('tells deleted and reply rows apart', () => {
    expect(entry.rows.find((r) => r.number === 36725)).toMatchObject({
      kind: 'deleted',
      author: '-',
    });
    expect(entry.rows.find((r) => r.number === 36729)?.kind).toBe('reply');
  });

  it('reads a page that was scrolled by a number jump (target mid-screen)', () => {
    const jumped = parseBoardList(screen('board_list_jump_36700'))!;
    expect(jumped.selected).toMatchObject({ number: 36700, screenRow: 13 });
    expect(jumped.rows.map((r) => r.number)).toEqual(
      Array.from({ length: 20 }, (_, i) => 36690 + i)
    );
    expect(jumped.rows.some((r) => r.isPinned)).toBe(false);
  });

  it('returns null for other screens', () => {
    expect(parseBoardList(screen('favorites'))).toBeNull();
    expect(parseBoardList(screen('article_normal_p1'))).toBeNull();
  });
});

describe('favorites', () => {
  const lines = screen('favorites');

  it('is recognised and lists the boards', () => {
    expect(isFavoritesScreen(lines)).toBe(true);
    expect(isFavoritesScreen(screen('board_list_entry'))).toBe(false);
    expect(
      parseFavorites(lines).map((r) => [r.number, r.name, r.category, r.unread, r.selected])
    ).toEqual([
      [1, 'Gossiping', '綜合', true, true],
      [2, 'C_Chat', '閒談', true, false],
      [3, 'Soft_Job', '工作', false, false],
      [4, 'Python', '程設', false, false],
      [5, 'Stock', '學術', true, false],
    ]);
  });
});

describe('favorites folders and separators', () => {
  const page = (rows: string[]) => {
    const lines = Array<string>(24).fill('');
    lines[0] = '【看板列表】   批踢踢實業坊';
    lines[23] = ' 我的最愛  (a)增加看板';
    rows.forEach((row, i) => (lines[3 + i] = row));
    return lines;
  };
  // The shapes pttbbs draws in mbbsd/board.c.
  const rows = parseFavorites(
    page([
      '>     1 ˇ Gossiping     綜合 ◎ [PTT] 八卦板',
      '      2   MyFavFolder  目錄 ◎我的資料夾',
      `      3   ${'-'.repeat(12)}      ${'-'.repeat(42)}`,
      `      4 D ${'-'.repeat(12)}      ${'-'.repeat(42)}`,
      '      5   C_Chat        閒談 ◎ [希洽] 希洽板',
    ])
  );

  it('tells boards, folders and separators apart and keeps their numbers', () => {
    expect(rows.map((r) => [r.number, r.kind])).toEqual([
      [1, 'board'],
      [2, 'folder'],
      [3, 'line'],
      [4, 'line'],
      [5, 'board'],
    ]);
    expect(rows[1]).toMatchObject({ name: 'MyFavFolder', title: '我的資料夾' });
    expect(rows[0]!.selected).toBe(true);
  });

  it('does not take an ordinary row of dashes in a title for a separator', () => {
    const ordinary = parseFavorites(page(['      1   ------------ some text']));
    expect(ordinary).toEqual([]);
  });
});

describe('article code popup', () => {
  it('reads the code, board and URL wherever the box is drawn', () => {
    expect(parseAidPopup(screen('popup_normal'))).toEqual({
      aid: '#1gvg4mau',
      board: 'Soft_Job',
      url: 'https://www.ptt.cc/bbs/Soft_Job/M.1793499440.A.938.html',
      id: 'M.1793499440.A.938',
    });
    expect(parseAidPopup(screen('popup_pinned'))).toMatchObject({
      aid: '#1PX17Gto',
      id: 'M.1501827536.A.DF2',
    });
  });

  it('is absent from a plain list', () => {
    expect(parseAidPopup(screen('board_list_entry'))).toBeNull();
  });

  it('shows the any-key prompt that must be answered', () => {
    expect(isAnyKeyPrompt(screen('popup_normal'))).toBe(true);
    expect(isAnyKeyPrompt(screen('board_list_entry'))).toBe(false);
  });
});

describe('article pages', () => {
  it('reads the status line', () => {
    expect(parseArticleStatus(screen('article_normal_p1'))).toEqual({
      page: 1,
      pages: 2,
      percent: 37,
      from: 1,
      to: 22,
    });
    expect(parseArticleStatus(screen('article_normal_p2'))).toMatchObject({
      page: 2,
      pages: 2,
      from: 20,
      to: 42,
    });
    expect(parseArticleStatus(screen('board_list_entry'))).toBeNull();
  });

  it('merges two pages whose last rows repeat (overlap = previous.to - current.from + 1)', () => {
    const pages = ['article_normal_p1', 'article_normal_p2'].map((n) =>
      parseArticlePage(screen(n))!
    );
    expect(mergePages(pages)).toHaveLength(43);
  });

  it('merges all ten pages of a long article to exactly 203 rows', () => {
    const pages = Array.from({ length: 10 }, (_, i) =>
      parseArticlePage(screen(`article_pinned_p${String(i + 1).padStart(2, '0')}`))!
    );
    expect(mergePages(pages)).toHaveLength(203);
  });

  it('refuses pages that do not line up', () => {
    const p1 = parseArticlePage(screen('article_normal_p1'))!;
    const p3 = parseArticlePage(screen('article_pinned_p03'))!;
    expect(() => mergePages([p1, p3])).toThrow(UnexpectedScreenError);
  });
});

describe('article content', () => {
  const rows = mergePages(
    ['article_normal_p1', 'article_normal_p2'].map((n) => parseArticlePage(screen(n))!)
  );
  const article = parseArticle(rows);

  it('reads the header', () => {
    expect(article.header).toEqual({
      author: 'waper (VanDijk)',
      board: 'Soft_Job',
      title: '[請益] 中高齡找短期約聘軟工',
      time: 'Sun Nov  1 10:17:18 2026',
    });
  });

  it('reads the URL line from the body', () => {
    expect(article.url).toBe('https://www.ptt.cc/bbs/Soft_Job/M.1793499440.A.938.html');
  });

  it('splits the body from the pushes', () => {
    expect(article.bodyLines.at(-1)).toContain('※  編輯');
    expect(article.bodyLines.some((l) => l.includes('本魯五十多歲了'))).toBe(true);
    expect(article.pushes).toHaveLength(27);
  });

  it('reads a push with its user, text, date and time', () => {
    expect(article.pushes[0]).toEqual({
      kind: '→',
      userId: 'hegemon',
      content: '有些專門幫國外接案維護老系統的會找大齡，但是你會COBOL',
      date: '11/01',
      time: '10:40',
    });
    expect(article.pushes.at(-1)).toMatchObject({ kind: '推', userId: 'fatb', date: '11/02' });
    expect(article.pushes.filter((p) => p.kind === '推')).toHaveLength(5);
  });

  it('keeps a pinned article whose list title differs from its inner title', () => {
    const pages = Array.from({ length: 10 }, (_, i) =>
      parseArticlePage(screen(`article_pinned_p${String(i + 1).padStart(2, '0')}`))!
    );
    const pinned = parseArticle(mergePages(pages));
    expect(pinned.header?.title).toBe('[公告] 2016年1月1日 新板規上路! 新年快樂');
    // the list showed "[公告] 本板板規  2017/4/10更新" for this entry
    expect(pinned.url).toBe('https://www.ptt.cc/bbs/Soft_Job/M.1501827536.A.DF2.html');
    expect(pinned.pushes).toHaveLength(20);
  });

  it('treats an article without a header as body only', () => {
    const parsed = parseArticle(['just some text', '', '']);
    expect(parsed.header).toBeNull();
    expect(parsed.bodyLines).toEqual(['just some text']);
  });
});

describe('prompts', () => {
  it('does not mistake the Big5 splash line "忘記密碼" for the password prompt', () => {
    const lines = Array(24).fill('');
    lines[22] = '忘記密碼可參考 https://www.ptt.cc/bbs/ID_GetBack/M.1603329678.A.726.html';
    lines[20] = 'login with guest or new:';
    expect(isLoginPrompt(lines)).toBe(true);
    expect(isPasswordPrompt(lines)).toBe(false);
    lines[21] = '請輸入您的密碼:';
    expect(isPasswordPrompt(lines)).toBe(true);
  });

  it('recognises the main menu and the board-name prompt by their top rows', () => {
    const menu = Array(24).fill('');
    menu[0] = '【主功能表】                     批踢踢實業坊';
    expect(isMainMenu(menu)).toBe(true);
    const select = Array(24).fill('');
    select[0] = '【 選擇看板 】';
    select[1] = '請輸入看板名稱(按空白鍵自動搜尋):';
    expect(isBoardSelectPrompt(select)).toBe(true);
    expect(isMainMenu(select)).toBe(false);
  });
});

describe('prompt checks look only where the BBS draws its prompts', () => {
  const blank = (): string[] => Array(24).fill('');
  const listWith = (row22: string): string[] => {
    const lines = screen('board_list_entry');
    lines[22] = row22;
    return lines;
  };

  it('a title on row 22 that mentions the any-key prompt is not the prompt', () => {
    const lines = listWith('  36731 + 511/01 waper        □  [公告] 請按任意鍵繼續');
    expect(isAnyKeyPrompt(lines)).toBe(false);
    expect(isBoardList(lines)).toBe(true);
  });

  it('the any-key prompt is found on the last row, or one row up when the last row is empty', () => {
    const last = blank();
    last[23] = ' ▄ ▄ ▄  請按任意鍵繼續 ▄ ▄ ▄';
    expect(isAnyKeyPrompt(last)).toBe(true);
    const above = blank();
    above[22] = '請按任意鍵繼續';
    expect(isAnyKeyPrompt(above)).toBe(true);
    const article = blank();
    article[22] = '請按任意鍵繼續';
    article[23] = '  瀏覽 第 1/2 頁 ( 37%)  目前顯示: 第 01~22 行';
    expect(isAnyKeyPrompt(article)).toBe(false);
  });

  it('while logging in, the prompt may sit on row 22 even with something on row 23', () => {
    const lines = blank();
    lines[22] = '請按任意鍵繼續';
    lines[23] = '  系統公告';
    expect(isLoginAnyKeyPrompt(lines)).toBe(true);
    expect(isAnyKeyPrompt(lines)).toBe(false); // navigation stays strict
  });

  it('the exit prompt counts only on row 22 over the main menu', () => {
    const real = blank();
    real[0] = '【主功能表】                     批踢踢實業坊';
    real[22] = '您確定要離開【 批踢踢實業坊 】嗎(Y/N)？[N]';
    expect(isLogoutConfirm(real)).toBe(true);
    const inTitle = screen('board_list_entry');
    inTitle[10] = '  36722   510/22 someone      □  您確定要離開【 批踢踢實業坊 】嗎';
    expect(isLogoutConfirm(inTitle)).toBe(false);
  });

  it('the board-name prompt must start with its own heading', () => {
    const list = screen('board_list_entry');
    list[0] = '【板主:x】 [請輸入看板名稱 選擇看板] 看板《Dev》';
    list[1] = '請輸入看板名稱';
    expect(isBoardSelectPrompt(list)).toBe(false);
  });

  it('the duplicate-login prompt is the question itself, not any mention of the words', () => {
    const notice = blank();
    notice[3] = '公告：禁止重複登入以外的行為';
    expect(isDuplicateLoginPrompt(notice)).toBe(false);
    const question = blank();
    question[22] = '您想刪除其他重複登入的連線嗎？[Y/n]';
    expect(isDuplicateLoginPrompt(question)).toBe(true);
  });
});

describe('the article URL is the last "文章網址" line', () => {
  it('ignores a quoted URL earlier in the body', () => {
    const rows = [
      ' 作者  a (b)                                  看板  Dev',
      ' 標題  t',
      ' 時間  now',
      '─ ─ ─',
      '※ 文章網址: https://www.ptt.cc/bbs/Dev/M.5.A.555.html',
      '--',
      '※ 發信站: 批踢踢實業坊(ptt.cc), 來自: 0.0.0.0',
      '※ 文章網址: https://www.ptt.cc/bbs/Dev/M.1.A.001.html',
    ];
    expect(parseArticle(rows).url).toBe('https://www.ptt.cc/bbs/Dev/M.1.A.001.html');
  });
});

describe('the exit prompt as the live server drew it', () => {
  // Rebuilt from the screen seen on 2026-11-03 (main menu title on row 0, the question on row 22).
  it('is recognised on the real layout, and a plain main menu is not mistaken for it', () => {
    const lines = screen('exit_prompt');
    expect(isMainMenu(lines)).toBe(true);
    expect(isLogoutConfirm(lines)).toBe(true);

    const menu = [...lines];
    menu[22] = '';
    expect(isLogoutConfirm(menu)).toBe(false);
  });
});

describe('the last page of a short article', () => {
  // Seen live: a 24-line article showed lines 1-23 as "1~22" and lines 2-24 as "2~23", repeating 22 rows.
  const lines = Array.from({ length: 24 }, (_, i) => `line ${i + 1}`);
  const page = (from: number, to: number, first: number) => ({
    rows: lines.slice(first, first + 23),
    status: { page: from === 1 ? 1 : 2, pages: 2, percent: 100, from, to },
  });

  it('still merges when it repeats one row more than the status numbers say', () => {
    const merged = mergePages([page(1, 22, 0), page(2, 23, 1)] as never);
    expect(merged).toEqual(lines);
  });

  it('still refuses rows that differ', () => {
    const broken = page(2, 23, 1);
    broken.rows[5] = 'something else';
    expect(() => mergePages([page(1, 22, 0), broken] as never)).toThrow(UnexpectedScreenError);
  });
});

describe('articles with wrapped lines or no page total', () => {
  it('reads a status line that has no "/total"', () => {
    const lines = Array.from({ length: 24 }, () => '');
    lines[23] = '  瀏覽 第 1 頁 (  0%)  目前顯示: 第 01~22 行 (y)回應(X)推文    (← )離開(h)說明 ';
    expect(parseArticleStatus(lines)).toMatchObject({
      page: 1,
      pages: 0,
      percent: 0,
      from: 1,
      to: 22,
    });
  });

  it('finds the overlap from the rows when long lines make the line numbers misleading', () => {
    // Seen live: "14~27" on screen while the previous page said "1~?": source lines, not screen rows.
    const rows = Array.from({ length: 60 }, (_, i) => `row ${i}`);
    const status = (from: number, to: number) => ({ page: 1, pages: 5, percent: 20, from, to });
    const first = { rows: rows.slice(0, 23), status: status(1, 14) };
    const second = { rows: rows.slice(22, 45), status: status(14, 27) }; // one screen row repeated
    const third = { rows: rows.slice(44, 60).concat(Array(7).fill('')), status: status(27, 40) };
    expect(mergePages([first, second] as never)).toEqual(rows.slice(0, 45));
    expect(mergePages([first, second, third] as never).slice(0, 60)).toEqual(rows);
  });
});

describe('a cross-posted article', () => {
  it('does not take the original article’s address as its own', () => {
    const rows = [
      ' 作者  someone (nick)                                         看板  Dev ',
      ' 標題  Fw: [閒聊] hello                                                ',
      ' 時間  Sun Oct  4 23:58:28 2026                                         ',
      '─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ',
      '※  [本文轉錄自 Other 看板 #1abcdEFG ]',
      'text of the original',
      '--',
      '※  發信站: 批踢踢實業坊(ptt.cc), 來自: 192.0.2.1 (臺灣)',
      '※  文章網址: https://www.ptt.cc/bbs/Other/M.1791129118.A.FDF.html',
      '',
      '--',
      '※  發信站: 批踢踢實業坊(ptt.cc)',
      '※  轉錄者: someone (192.0.2.1 臺灣), 10/04/2026 23:58:28',
      '推 bob: nice                                                        10/06 09:06',
    ];
    const parsed = parseArticle(rows);
    expect(parsed.url).toBeUndefined();
    expect(parsed.pushes).toHaveLength(1);
  });
});
