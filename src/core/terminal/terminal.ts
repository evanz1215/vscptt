import * as xtermNamespace from '@xterm/headless';

// @xterm/headless is CommonJS. Under Node ESM (vitest) its members sit on `.default`; in the esbuild CJS
// bundle they sit on the namespace itself and `.default` is undefined. Accept both. The bundle regression
// test (test/core/bundle.test.ts) guards this.
type XtermModule = typeof import('@xterm/headless');
const xterm = ((xtermNamespace as unknown as { default?: XtermModule }).default ??
  xtermNamespace) as XtermModule;
const XTerm = xterm.Terminal;

export type Encoding = 'big5' | 'utf-8';

export interface TerminalOptions {
  cols?: number;
  rows?: number;
  /** PTT's WebSocket gateway starts in Big5 and switches to UTF-8 after a username ending with a comma. */
  encoding?: Encoding;
}

/** An 80x24 screen fed with raw bytes from the BBS. */
export class Terminal {
  readonly cols: number;
  readonly rows: number;

  private readonly term: InstanceType<typeof XTerm>;
  private decoder: TextDecoder;
  private currentEncoding: Encoding;
  private readonly listeners = new Set<() => void>();

  constructor(options: TerminalOptions = {}) {
    this.cols = options.cols ?? 80;
    this.rows = options.rows ?? 24;
    this.currentEncoding = options.encoding ?? 'utf-8';
    this.decoder = new TextDecoder(this.currentEncoding);
    this.term = new XTerm({
      cols: this.cols,
      rows: this.rows,
      scrollback: 0,
      allowProposedApi: true,
    });
  }

  get encoding(): Encoding {
    return this.currentEncoding;
  }

  /** Takes effect for bytes written after this call. */
  setEncoding(encoding: Encoding): void {
    if (encoding === this.currentEncoding) {
      return;
    }
    this.currentEncoding = encoding;
    this.decoder = new TextDecoder(encoding);
  }

  /** Resolves after the bytes are parsed into the screen buffer. */
  write(data: Uint8Array): Promise<void> {
    const text = this.decoder.decode(data, { stream: true });
    return new Promise((resolve) => {
      this.term.write(text, () => {
        for (const l of this.listeners) {
          l();
        }
        resolve();
      });
    });
  }

  /** Called after every parsed write. Returns an unsubscribe function. */
  onUpdate(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  line(row: number): string {
    return this.term.buffer.active.getLine(row)?.translateToString(true) ?? '';
  }

  lines(): string[] {
    return Array.from({ length: this.rows }, (_, i) => this.line(i));
  }

  text(): string {
    return this.lines().join('\n');
  }

  get cursor(): { x: number; y: number } {
    const b = this.term.buffer.active;
    return { x: b.cursorX, y: b.cursorY };
  }

  dispose(): void {
    this.listeners.clear();
    this.term.dispose();
  }
}
