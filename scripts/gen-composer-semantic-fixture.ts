#!/usr/bin/env tsx
/**
 * Generates the shared engine-to-Swift composer semantic fixture. The expected
 * values come only from schema run-control applicability and the orchestrator
 * attachment resolver; Swift decodes this committed projection synchronously.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Attachment, AttachmentInputClass, ModeKind } from "@claudexor/schema";
import { format } from "prettier";
import { runControlApplicability } from "../packages/schema/src/run-strategy.js";
import { RequestRequirementsResolver } from "../packages/orchestrator/src/requestRequirements.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = join(
  repoRoot,
  "apps/macos/ClaudexorApp/Tests/ClaudexorAppTests/Fixtures/composer-semantic-parity.json",
);
const resolver = new RequestRequirementsResolver();

const attachmentInputs = [
  {
    name: "text",
    kind: "file" as const,
    mimeTypes: ["text/plain"],
    maxBytes: 20,
    maxCount: 1,
    transport: "text_inline" as const,
  },
];
const inputByName = new Map(attachmentInputs.map((input) => [input.name, input]));

type FixtureAttachment = {
  id: string;
  kind: "file";
  mime: string;
  name: string;
  sizeBytes: number;
};

const textAttachment: FixtureAttachment = {
  id: "a1",
  kind: "file",
  mime: "text/plain",
  name: "notes.txt",
  sizeBytes: 12,
};

function toAttachment(value: FixtureAttachment): Attachment {
  return {
    resource_id: value.id,
    kind: value.kind,
    mime: value.mime,
    name: value.name,
    size_bytes: value.sizeBytes,
    sha256: `fixture:${value.id}`,
    path: `/fixture/${value.name}`,
  };
}

function declarations(names: string[] | null): AttachmentInputClass[] | null {
  if (names === null) return null;
  return names.map((name) => {
    const value = inputByName.get(name);
    if (!value) throw new Error(`unknown attachment input fixture: ${name}`);
    return {
      kind: value.kind,
      mime_types: value.mimeTypes,
      max_bytes: value.maxBytes,
      max_count: value.maxCount,
      transport: value.transport,
    };
  });
}

const runControlInputs: Array<{ name: string; schemaMode: ModeKind; swiftMode: string }> = [
  { name: "agent", schemaMode: "agent", swiftMode: "agent" },
  { name: "ask", schemaMode: "ask", swiftMode: "ask" },
  { name: "plan", schemaMode: "plan", swiftMode: "plan" },
  { name: "best-of-n-agent-projection", schemaMode: "agent", swiftMode: "bestOfN" },
  { name: "attempts-agent-projection", schemaMode: "agent", swiftMode: "maxAttempts" },
  { name: "until-clean-agent-projection", schemaMode: "agent", swiftMode: "untilClean" },
  { name: "create-agent-projection", schemaMode: "agent", swiftMode: "create" },
];

const attachmentCaseInputs = [
  { name: "admitted", inputNames: ["text"], attachments: [textAttachment] },
  {
    name: "unsupported-input",
    inputNames: ["text"],
    attachments: [{ ...textAttachment, mime: "application/json", name: "notes.json" }],
  },
  {
    name: "max-bytes-exceeded",
    inputNames: ["text"],
    attachments: [{ ...textAttachment, name: "large.txt", sizeBytes: 21 }],
  },
  {
    name: "max-count-exceeded",
    inputNames: ["text"],
    attachments: [
      { ...textAttachment, name: "one.txt" },
      { ...textAttachment, id: "a2", name: "two.txt" },
    ],
  },
];

const attachmentPoolInputs = [
  {
    name: "explicit-all-admitted",
    poolMode: "explicit" as const,
    attachments: [textAttachment],
    lanes: [
      { id: "claude", inputNames: ["text"], available: true },
      { id: "codex", inputNames: ["text"], available: true },
    ],
  },
  {
    name: "explicit-mixed-rejects",
    poolMode: "explicit" as const,
    attachments: [textAttachment],
    lanes: [
      { id: "claude", inputNames: ["text"], available: true },
      { id: "blind", inputNames: [], available: true },
    ],
  },
  {
    name: "auto-mixed-degrades",
    poolMode: "auto" as const,
    attachments: [textAttachment],
    lanes: [
      { id: "claude", inputNames: ["text"], available: true },
      { id: "blind", inputNames: [], available: true },
    ],
  },
  {
    name: "auto-drops-unavailable",
    poolMode: "auto" as const,
    attachments: [textAttachment],
    lanes: [
      { id: "claude", inputNames: ["text"], available: true },
      { id: "offline", inputNames: ["text"], available: false },
    ],
  },
  {
    name: "auto-zero-survivors",
    poolMode: "auto" as const,
    attachments: [textAttachment],
    lanes: [{ id: "offline", inputNames: ["text"], available: false }],
  },
  {
    name: "auto-all-incompatible",
    poolMode: "auto" as const,
    attachments: [textAttachment],
    lanes: [
      { id: "blind-a", inputNames: [], available: true },
      { id: "blind-b", inputNames: [], available: true },
    ],
  },
  {
    name: "explicit-unavailable-retained",
    poolMode: "explicit" as const,
    attachments: [textAttachment],
    lanes: [
      { id: "claude", inputNames: ["text"], available: true },
      { id: "offline", inputNames: null, available: false },
    ],
  },
  {
    name: "lane-identity-deduplicated-first-wins",
    poolMode: "explicit" as const,
    attachments: [textAttachment],
    lanes: [
      { id: "claude", inputNames: ["text"], available: true },
      { id: "claude", inputNames: [], available: true },
    ],
  },
];

const fixture = {
  generatedBy: ["runControlApplicability", "RequestRequirementsResolver"],
  runControls: runControlInputs.map((input) => ({
    ...input,
    reviewers: runControlApplicability({ mode: input.schemaMode }).reviewerPanel,
    protectedPathApprovals: runControlApplicability({ mode: input.schemaMode })
      .protectedPathApprovals,
  })),
  attachmentInputs,
  attachmentCases: attachmentCaseInputs.map((input) => {
    const result = resolver.resolveAttachmentLane(
      "fixture",
      input.attachments.map(toAttachment),
      declarations(input.inputNames) ?? [],
    );
    return { ...input, admitted: result.admitted, reason: result.reason };
  }),
  attachmentPoolCases: attachmentPoolInputs.map((input) => {
    const result = resolver.resolveAttachmentPool(
      input.poolMode,
      input.attachments.map(toAttachment),
      input.lanes.map((lane) => ({
        harnessId: lane.id,
        declarations: declarations(lane.inputNames),
        available: lane.available,
      })),
    );
    return {
      ...input,
      outcome: result.outcome,
      admittedLaneIDs: result.admittedHarnessIds,
      rejected: result.rejected.map((lane) => ({
        laneID: lane.harnessId,
        reason: lane.reason,
      })),
    };
  }),
};

const body = await format(JSON.stringify(fixture), { parser: "json", printWidth: 100 });
if (process.argv.includes("--check")) {
  if (!existsSync(fixturePath) || readFileSync(fixturePath, "utf8") !== body) {
    console.error("composer semantic fixture drift (regenerate: pnpm fixtures:swift)");
    process.exit(1);
  }
  console.log("composer semantic fixture fresh");
} else {
  writeFileSync(fixturePath, body);
  console.log(`wrote composer semantic fixture to ${fixturePath}`);
}
