// Pi has no --output-schema flag. Claude Code's --json-schema is itself a tool, so this
// dependency-free Pi extension registers the equivalent `scout_answer` tool. Pi validates
// its arguments against the job's plain JSON Schema before execute runs. The result
// includes the number of loaded Scout MCP tools because MCP startup failures are silent
// in JSON mode; terminate ends the run without requiring a chat reply.

export default function (pi) {
  let parameters;
  try {
    if (!process.env.SCOUT_PI_ANSWER_SCHEMA) return;
    const fs = process.getBuiltinModule("node:fs");
    const schemaText = fs.readFileSync(process.env.SCOUT_PI_ANSWER_SCHEMA, "utf8");
    parameters = JSON.parse(schemaText);
  } catch {
    // Without a usable schema, leave the tool absent; the host reports no_structured_output.
    return;
  }

  pi.registerTool({
    name: "scout_answer",
    label: "Scout answer",
    description: 'Submit the final answer once, as your last action: "ok" with 1 to 3 picks, or "empty" without items.',
    parameters,
    async execute(_id, params) {
      const scoutTools = pi.getAllTools()
        .filter((tool) => tool.name.startsWith("mcp__scout__"))
        .length;
      return {
        content: [{ type: "text", text: "Answer recorded." }],
        details: { answer: params, scoutTools },
        terminate: true,
      };
    },
  });
}
