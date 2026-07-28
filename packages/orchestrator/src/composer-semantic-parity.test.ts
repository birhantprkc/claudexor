import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runControlApplicability } from "@claudexor/schema";
import { describe, expect, it } from "vitest";
import { RequestRequirementsResolver } from "./requestRequirements.js";

type ControlExpectation = { applicable: boolean; reason?: string };
type Fixture = {
  runControls: Array<{
    name: string;
    schemaMode: "agent" | "ask" | "plan";
    swiftMode: string;
    reviewers: ControlExpectation;
    protectedPathApprovals: ControlExpectation;
  }>;
  attachmentInput: {
    kind: "file";
    mimeTypes: string[];
    maxBytes: number;
    maxCount: number;
    transport: "text_inline";
  };
  attachmentCases: Array<{
    name: string;
    attachments: Array<{
      id: string;
      kind: "file";
      mime: string;
      name: string;
      sizeBytes: number;
    }>;
    admitted: boolean;
    reason: "admitted" | "unsupported_input" | "max_bytes_exceeded" | "max_count_exceeded";
  }>;
};

const fixturePath = fileURLToPath(
  new URL(
    "../../../apps/macos/ClaudexorApp/Tests/ClaudexorAppTests/Fixtures/composer-semantic-parity.json",
    import.meta.url,
  ),
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;

describe("composer semantic parity fixture", () => {
  it("pins schema applicability and resolver attachment admission", () => {
    for (const testCase of fixture.runControls) {
      const actual = runControlApplicability({ mode: testCase.schemaMode });
      expect(actual.reviewerPanel, testCase.name).toEqual(testCase.reviewers);
      expect(actual.protectedPathApprovals, testCase.name).toEqual(testCase.protectedPathApprovals);
    }

    const resolver = new RequestRequirementsResolver();
    const declaration = {
      kind: fixture.attachmentInput.kind,
      mime_types: fixture.attachmentInput.mimeTypes,
      max_bytes: fixture.attachmentInput.maxBytes,
      max_count: fixture.attachmentInput.maxCount,
      transport: fixture.attachmentInput.transport,
    };
    for (const testCase of fixture.attachmentCases) {
      const attachments = testCase.attachments.map((attachment) => ({
        resource_id: attachment.id,
        kind: attachment.kind,
        mime: attachment.mime,
        name: attachment.name,
        size_bytes: attachment.sizeBytes,
        sha256: `fixture:${attachment.id}`,
        path: `/fixture/${attachment.name}`,
      }));
      const actual = resolver.resolveAttachmentLane("fixture", attachments, [declaration]);
      expect({ admitted: actual.admitted, reason: actual.reason }, testCase.name).toEqual({
        admitted: testCase.admitted,
        reason: testCase.reason,
      });
    }
  });
});
