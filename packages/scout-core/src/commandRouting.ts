// Who may run a window command, and where its answer goes (panelSinks.ts).
//
// Every command arrives with the sink that sent it: the app's stdio, or the live connection's
// relay sink. `admit` decides before the coordinator applies it:
//   - `frontmost` and `shutdown` from a relay sink are refused: a scalar
//     `native_command_refused` event and, when the command named a commandId, a
//     `not_permitted` ack delivered to that sink alone. The socket server already turns such
//     frames into `refused_command` frames (StdioOnlyCommandFrameSchema), which go through
//     `refuse` too; the check in `admit` is the second line of defence, for a parsed command
//     handed in with a relay sink by any other path.
//   - A commandId whose answer is already routed to another attached sink is refused with an
//     `invalid` ack to the sender alone (`command_id_collision`), so one surface can never
//     receive another's answer (an `open_link` target above all) by reusing its id.
//   - Otherwise the command's commandId (if any) is routed to its sender and the command is
//     applied.

import { type NativeCommand, type PanelState, STDIO_ONLY_COMMANDS, type StdioOnlyCommandType } from "@scout/contracts";
import type { Diagnostics } from "./diagnostics.js";
import type { PanelSink, PanelSinks } from "./panelSinks.js";

export interface CommandRoutingOptions {
  /** Without sinks (tests), answers go through `emitPanel` and nothing is routed. */
  sinks?: Pick<PanelSinks, "routeCommand" | "routeOf" | "deliver">;
  emitPanel: (frame: PanelState) => void;
  diagnostics: Diagnostics;
}

export interface CommandRouting {
  /** Whether `cmd` from `from` may be applied now; if not, it has been answered. */
  admit(cmd: NativeCommand, from: PanelSink): boolean;
  /** Refuse a native-app-only command from `from` (see the header). */
  refuse(type: StdioOnlyCommandType, commandId: string | undefined, from: PanelSink): void;
}

const isStdioOnly = (type: string): type is StdioOnlyCommandType => (STDIO_ONLY_COMMANDS as readonly string[]).includes(type);

export function createCommandRouting(options: CommandRoutingOptions): CommandRouting {
  const { sinks, diagnostics } = options;

  /** One frame to `to` alone. */
  const answer = (to: PanelSink, frame: PanelState): void => {
    try {
      if (sinks) sinks.deliver(to, frame);
      else options.emitPanel(frame);
    } catch {
      diagnostics.event("panel_emit_failed", {});
    }
  };

  const refuse = (type: StdioOnlyCommandType, commandId: string | undefined, from: PanelSink): void => {
    diagnostics.event("native_command_refused", { type, sink: from.kind, ...(commandId === undefined ? {} : { acked: true }) });
    if (commandId !== undefined) answer(from, { type: "ack", commandId, ok: false, code: "not_permitted" });
  };

  return {
    refuse,
    admit(cmd, from) {
      if (from.kind === "relay" && isStdioOnly(cmd.type)) {
        refuse(cmd.type, "commandId" in cmd && typeof cmd.commandId === "string" ? cmd.commandId : undefined, from);
        return false;
      }
      if (!("commandId" in cmd) || sinks === undefined) return true;
      const owner = sinks.routeOf(cmd.commandId);
      if (owner !== undefined && owner !== from) {
        diagnostics.event("command_id_collision", { sink: from.kind });
        answer(from, { type: "ack", commandId: cmd.commandId, ok: false, code: "invalid" });
        return false;
      }
      sinks.routeCommand(cmd.commandId, from);
      return true;
    },
  };
}
