// The CLI's stdout as stream-json events: UTF-8 text split on newlines, each line parsed as
// JSON, objects handed on. Blank lines, lines that are not JSON, and JSON that is not an
// object are skipped. A last line without a trailing newline is parsed at end(). Past
// `maxBytes` (UTF-8 bytes) the stream reports once and ignores everything after, including
// any buffered partial line.
//
// Nothing here throws into the caller's event emitter: an exception from `onEvent` is
// handed to `onError` and the stream stops, as if it were too large.

export type StreamRecord = Record<string, unknown>;

export const isRecord = (v: unknown): v is StreamRecord => v !== null && typeof v === "object" && !Array.isArray(v);

export interface JsonLineStreamOptions {
  maxBytes: number;
  onEvent(ev: StreamRecord): void;
  onTooLarge(): void;
  onError(err: unknown): void;
}

export interface JsonLineStream {
  /** One decoded chunk (`setEncoding("utf8")`, so no code point is split). */
  push(chunk: string): void;
  /** Parse the final line, if it had no newline. */
  end(): void;
}

export function createJsonLineStream(opts: JsonLineStreamOptions): JsonLineStream {
  let bytes = 0;
  let stopped = false;
  let buf = "";

  const parseLine = (raw: string): void => {
    const line = raw.trim();
    if (!line) return;
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (isRecord(ev)) opts.onEvent(ev);
  };

  const guarded = (fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      stopped = true;
      buf = "";
      opts.onError(err);
    }
  };

  return {
    push(chunk) {
      if (stopped) return;
      bytes += Buffer.byteLength(chunk, "utf8");
      if (bytes > opts.maxBytes) {
        stopped = true;
        buf = "";
        opts.onTooLarge();
        return;
      }
      buf += chunk;
      guarded(() => {
        let nl: number;
        while (!stopped && (nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          parseLine(line);
        }
      });
    },
    end() {
      if (stopped || !buf) return;
      const rest = buf;
      buf = "";
      guarded(() => parseLine(rest));
    },
  };
}
