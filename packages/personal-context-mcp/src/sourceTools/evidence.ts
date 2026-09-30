// Evidence ids for one run: `e1`, `e2`, ... in the order results are sent. The map from id
// to location stays here and in audit.jsonl; a tool result carries only the id.
//
// Ids are minted inside a transaction. A call whose result is refused (budget, audit
// failure) rolls back, so every id the model ever sees was issued, in order, with no gaps,
// and no id is issued for a result the model never received. Callers mint, measure and
// commit synchronously, so two transactions never interleave.

export type EvidenceKind = "activity" | "note" | "focus";

export interface EvidenceLocation {
  kind: EvidenceKind;
  sourceId: string;
  /** Relative note path, observation id, or Focus item id. Never content. */
  path?: string;
  /** 1-based inclusive line range, for notes. */
  lines?: [number, number];
}

export interface EvidenceRecord extends EvidenceLocation {
  id: string;
}

export interface EvidenceTransaction {
  mint(loc: EvidenceLocation): string;
  /** The records minted so far in this transaction. */
  readonly records: readonly EvidenceRecord[];
  commit(): readonly EvidenceRecord[];
  rollback(): void;
}

export interface EvidenceLedger {
  begin(): EvidenceTransaction;
  get(id: string): EvidenceRecord | undefined;
  /** Every committed record, in issue order. */
  all(): readonly EvidenceRecord[];
}

export function createEvidenceLedger(): EvidenceLedger {
  let next = 1;
  const committed = new Map<string, EvidenceRecord>();
  let open = false;

  return {
    begin() {
      if (open) throw new Error("evidence-transaction-open");
      open = true;
      const start = next;
      const records: EvidenceRecord[] = [];
      let done = false;
      const close = (): void => {
        if (done) throw new Error("evidence-transaction-closed");
        done = true;
        open = false;
      };
      return {
        records,
        mint(loc) {
          if (done) throw new Error("evidence-transaction-closed");
          const rec: EvidenceRecord = { id: `e${next++}`, ...loc };
          if (loc.lines) rec.lines = [loc.lines[0], loc.lines[1]];
          records.push(rec);
          return rec.id;
        },
        commit() {
          close();
          for (const r of records) committed.set(r.id, Object.freeze(r));
          return Object.freeze([...records]);
        },
        rollback() {
          close();
          next = start;
        },
      };
    },
    get: (id) => committed.get(id),
    all: () => Object.freeze([...committed.values()]),
  };
}
