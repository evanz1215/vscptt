export interface CloseInfo {
  code?: number;
  reason?: string;
  error?: Error;
}

/** A byte stream to the BBS. Implementations: WebSocket (default), in-memory fake for tests. */
export interface Transport {
  readonly isOpen: boolean;
  send(data: string | Uint8Array): void;
  close(): void;
  /** Returns an unsubscribe function. */
  onData(listener: (data: Uint8Array) => void): () => void;
  /** Returns an unsubscribe function. */
  onClose(listener: (info: CloseInfo) => void): () => void;
}
