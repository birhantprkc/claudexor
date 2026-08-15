import { type ParsedArgs, flagBool, flagStr } from "./args.js";

/** `--harness a,b` selection shared by doctor/models/auth ops commands. */
export function requestedHarnesses(args: ParsedArgs): string[] | undefined {
  const only = flagStr(args, "harness");
  return only
    ? only
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
    : undefined;
}

export function harnessListPath(args: ParsedArgs, fresh = false): string {
  const query = new URLSearchParams();
  if (fresh) query.set("fresh", "true");
  if (flagBool(args, "all")) query.set("all", "true");
  for (const id of requestedHarnesses(args) ?? []) query.append("harness", id);
  const encoded = query.toString();
  return `/harnesses${encoded ? `?${encoded}` : ""}`;
}

export function unknownHarnesses(requested: string[] | undefined, observed: string[]): string[] {
  if (!requested) return [];
  const known = new Set(observed);
  return requested.filter((id) => !known.has(id));
}
