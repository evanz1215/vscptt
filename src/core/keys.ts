/** Key sequences the BBS understands. Verified against the live server on 2026-11-03 except where noted. */
export const Keys = {
  ENTER: '\r',
  SPACE: ' ',
  LEFT: '\x1b[D',
  RIGHT: '\x1b[C',
  UP: '\x1b[A',
  DOWN: '\x1b[B',
  PGUP: '\x1b[5~',
  PGDN: '\x1b[6~',
  /** Ctrl-L: redraw. Used as a harmless keep-alive. Whether it resets the idle timer is not verified. */
  REDRAW: '\x0c',
} as const;
