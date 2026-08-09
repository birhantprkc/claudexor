import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface EnvelopeRecoveryRecord {
  envelopeId: string;
  workspaceMode: "in_place" | "isolated";
}

/** Read only the identity needed to dispose a crashed envelope. The caller
 * decides whether missing legacy data is safe to fall back from. */
export function readEnvelopeRecoveryRecord(base: string): EnvelopeRecoveryRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(join(base, "owner.json"), "utf8")) as {
      envelope_id?: unknown;
      workspace_mode?: unknown;
    };
    if (
      typeof parsed.envelope_id !== "string" ||
      (parsed.workspace_mode !== "in_place" && parsed.workspace_mode !== "isolated")
    ) {
      return null;
    }
    return { envelopeId: parsed.envelope_id, workspaceMode: parsed.workspace_mode };
  } catch {
    return null;
  }
}
