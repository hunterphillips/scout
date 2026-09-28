// MV3's extension CSP forbids eval, and zod v4 probes for it (new Function) the first
// time it parses an object unless jitless is set. Import this module first in every
// entry that pulls in zod, so the probe and the JIT path never run.
import { z } from "zod";

z.config({ jitless: true });
