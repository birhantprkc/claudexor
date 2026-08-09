import { describe, expect, it } from "vitest";
import { excludePlainDiffPathPrefix } from "./plain-diff.js";

const ownedPrefix = ".claudexor-artifacts/run-1";

function textRecord(path: string, line: string): string {
  return [
    `diff -ruN a/${path} b/${path}`,
    `--- a/${path}\t2026-08-09 00:00:00.000000000 +0300`,
    `+++ b/${path}\t2026-08-09 00:00:01.000000000 +0300`,
    "@@ -0,0 +1 @@",
    `+${line}`,
    "",
  ].join("\n");
}

describe("excludePlainDiffPathPrefix", () => {
  it("separates an owned text record from a following user binary record", () => {
    const diff = `${textRecord(`${ownedPrefix}/log.txt`, "generated")}Binary files a/user.bin and b/user.bin differ\n`;

    const filtered = excludePlainDiffPathPrefix(diff, ownedPrefix);

    expect(filtered).toBe("Binary files a/user.bin and b/user.bin differ\n");
  });

  it("separates a user text record from a following owned binary record", () => {
    const userRecord = textRecord("notes.txt", "keep me");
    const diff = `${userRecord}Binary files a/${ownedPrefix}/shot.png and b/${ownedPrefix}/shot.png differ\n`;

    const filtered = excludePlainDiffPathPrefix(diff, ownedPrefix);

    expect(filtered).toBe(userRecord);
  });

  it("preserves input without a structural record boundary", () => {
    const ambiguous = "unparsed output mentioning .claudexor-artifacts/run-1/log.txt\n";

    expect(excludePlainDiffPathPrefix(ambiguous, ownedPrefix)).toBe(ambiguous);
  });
});
