// The job's output schema as Codex sends it (`--output-schema <jobDir>/schema.json`).
//
// Codex passes it on as an OpenAI strict structured output: every property must be listed in
// `required`, and `pattern`, `minLength`, `minItems` and `maxItems` are refused at request time.
// So the strict form cannot express the contract's `{status:"empty"}` (no items) or its 1..3
// item bound: the model answers `{status:"empty", items:[]}` for empty, and
// normalizeCodexOutput maps that back before validateJobOutput (outputValidation.ts) applies
// the contract's own rules, including the item bound and the candidate-id pattern.

export const CODEX_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["ok", "empty"] },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { id: { type: "string" }, reason: { type: "string" } },
        required: ["id", "reason"],
      },
    },
  },
  required: ["status", "items"],
});

/**
 * The strict schema's answer in the contract's shape: `items` is dropped when `status` is
 * `empty` (whatever it held). Anything else is returned unchanged, for validateJobOutput to judge.
 */
export function normalizeCodexOutput(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const o = value as Record<string, unknown>;
  if (o.status !== "empty" || !("items" in o)) return value;
  const { items: _items, ...rest } = o;
  return rest;
}
