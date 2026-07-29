import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Attachment, AttachmentInputClass } from "@claudexor/schema";
import { runControlApplicability } from "@claudexor/schema";
import { describe, expect, it } from "vitest";
import { RequestRequirementsResolver } from "./requestRequirements.js";

type ControlExpectation = { applicable: boolean; reason?: string };
type FixtureAttachment = {
  id: string;
  kind: "file";
  mime: string;
  name: string;
  sizeBytes: number;
};
type FixtureInput = {
  name: string;
  kind: "file";
  mimeTypes: string[];
  maxBytes: number;
  maxCount: number;
  transport: "text_inline";
};
type Fixture = {
  generatedBy: string[];
  runControls: Array<{
    name: string;
    schemaMode: "agent" | "ask" | "plan";
    swiftMode: string;
    reviewers: ControlExpectation;
    protectedPathApprovals: ControlExpectation;
  }>;
  attachmentInputs: FixtureInput[];
  attachmentCases: Array<{
    name: string;
    inputNames: string[];
    attachments: FixtureAttachment[];
    admitted: boolean;
    reason: "admitted" | "unsupported_input" | "max_bytes_exceeded" | "max_count_exceeded";
  }>;
  attachmentPoolCases: Array<{
    name: string;
    poolMode: "auto" | "explicit";
    attachments: FixtureAttachment[];
    lanes: Array<{ id: string; inputNames: string[] | null; available: boolean }>;
    outcome: "admitted" | "degraded" | "refused";
    admittedLaneIDs: string[];
    rejected: Array<{ laneID: string; reason: string }>;
  }>;
};

const fixturePath = fileURLToPath(
  new URL(
    "../../../apps/macos/ClaudexorApp/Tests/ClaudexorAppTests/Fixtures/composer-semantic-parity.json",
    import.meta.url,
  ),
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;
const inputByName = new Map(fixture.attachmentInputs.map((input) => [input.name, input]));

function attachments(values: FixtureAttachment[]): Attachment[] {
  return values.map((attachment) => ({
    resource_id: attachment.id,
    kind: attachment.kind,
    mime: attachment.mime,
    name: attachment.name,
    size_bytes: attachment.sizeBytes,
    sha256: `fixture:${attachment.id}`,
    path: `/fixture/${attachment.name}`,
  }));
}

function declarations(names: string[] | null): AttachmentInputClass[] | null {
  if (names === null) return null;
  return names.map((name) => {
    const input = inputByName.get(name);
    if (!input) throw new Error(`unknown attachment input fixture: ${name}`);
    return {
      kind: input.kind,
      mime_types: input.mimeTypes,
      max_bytes: input.maxBytes,
      max_count: input.maxCount,
      transport: input.transport,
    };
  });
}

describe("composer semantic parity fixture", () => {
  it("pins schema applicability and resolver attachment admission", () => {
    expect(fixture.generatedBy).toEqual(["runControlApplicability", "RequestRequirementsResolver"]);
    for (const testCase of fixture.runControls) {
      const actual = runControlApplicability({ mode: testCase.schemaMode });
      expect(actual.reviewerPanel, testCase.name).toEqual(testCase.reviewers);
      expect(actual.protectedPathApprovals, testCase.name).toEqual(testCase.protectedPathApprovals);
    }

    const resolver = new RequestRequirementsResolver();
    for (const testCase of fixture.attachmentCases) {
      const actual = resolver.resolveAttachmentLane(
        "fixture",
        attachments(testCase.attachments),
        declarations(testCase.inputNames) ?? [],
      );
      expect({ admitted: actual.admitted, reason: actual.reason }, testCase.name).toEqual({
        admitted: testCase.admitted,
        reason: testCase.reason,
      });
    }

    for (const testCase of fixture.attachmentPoolCases) {
      const actual = resolver.resolveAttachmentPool(
        testCase.poolMode,
        attachments(testCase.attachments),
        testCase.lanes.map((lane) => ({
          harnessId: lane.id,
          declarations: declarations(lane.inputNames),
          available: lane.available,
        })),
      );
      expect(
        {
          outcome: actual.outcome,
          admittedLaneIDs: actual.admittedHarnessIds,
          rejected: actual.rejected.map((lane) => ({
            laneID: lane.harnessId,
            reason: lane.reason,
          })),
        },
        testCase.name,
      ).toEqual({
        outcome: testCase.outcome,
        admittedLaneIDs: testCase.admittedLaneIDs,
        rejected: testCase.rejected,
      });
    }
  });
});
