#!/usr/bin/env node
// Daemon entry wrapper (same contract as the claudexor bin). The boot is an
// EXPLICIT call — the module import itself is side-effect-free (X228/X231),
// so a wrapper path in argv[1] can never silently skip the daemon start.
import { runClaudexordEntry } from "@claudexor/cli/claudexord";
runClaudexordEntry();
