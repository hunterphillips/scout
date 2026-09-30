// The model-name rule, shared by config parsing and the launch profile. No imports, so
// config.ts can use it without loading child_process.

/** Only a plain alias or model name; never anything that parses as a flag. */
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._\-[\]]{0,63}$/;
