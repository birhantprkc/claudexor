import type { AdapterRegistry, HarnessAdapter } from "@claudexor/core";
import {
  Attachment,
  ControlRunStartRequest,
  HarnessManifest,
  type AttachmentInputClass,
} from "@claudexor/schema";
import { describe, expect, it } from "vitest";
import { createRunRequirementsPreflight } from "./request-preflight.js";

const attachment = Attachment.parse({
  resource_id: "res-1",
  kind: "file",
  mime: "text/plain",
  name: "notes.txt",
  sha256: `sha256:${"a".repeat(64)}`,
  size_bytes: 12,
  path: "/external/resources/notes.txt",
});

const textInput: AttachmentInputClass = {
  kind: "file",
  mime_types: ["text/plain"],
  max_bytes: 1024,
  max_count: 1,
  transport: "text_inline",
};

function adapter(
  id: string,
  options: { attachments?: AttachmentInputClass[]; browser?: boolean } = {},
): HarnessAdapter {
  return {
    id,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: "local",
        capability_profile: { attachment_inputs: options.attachments ?? [] },
        capabilities: { implement: true, browser_tool: options.browser ?? false },
        access_profiles_supported: ["readonly", "workspace_write", "full"],
      });
    },
    async doctor() {
      throw new Error("preflight must use the supplied readiness projection");
    },
    async *run() {
      throw new Error("preflight must not run a harness");
    },
  };
}

function registry(...adapters: HarnessAdapter[]): AdapterRegistry {
  return new Map(adapters.map((candidate) => [candidate.id, candidate]));
}

const resources = {
  resolve: (refs?: { resourceId: string }[]) => ((refs?.length ?? 0) > 0 ? [attachment] : []),
};

describe("run request requirements preflight", () => {
  const gitAvailable = async () => ({
    status: "available" as const,
    version: "git version test",
    detail: null,
    remediation: null,
  });

  it("requires every explicit attachment lane but filters an incompatible auto lane", async () => {
    const compatible = adapter("compatible", { attachments: [textInput] });
    const incompatible = adapter("incompatible");
    const adapters = registry(compatible, incompatible);
    const statusAll = async () => [
      { id: compatible.id, status: "ok" as const, enabledIntents: ["implement" as const] },
      { id: incompatible.id, status: "ok" as const, enabledIntents: ["implement" as const] },
    ];
    const preflight = createRunRequirementsPreflight(resources, "/no-project", {
      registry: adapters,
      statusAll,
      gitCapability: gitAvailable,
    });
    const baseRequest = {
      prompt: "read attachment",
      mode: "agent",
      scope: { kind: "project", root: "/project", context: "auto" },
      attachments: [{ resourceId: attachment.resource_id }],
    } as const;

    await expect(
      preflight(
        ControlRunStartRequest.parse({
          ...baseRequest,
          harnesses: [compatible.id, incompatible.id],
        }),
      ),
    ).rejects.toMatchObject({ code: "attachment_pool_unsupported" });
    await expect(preflight(ControlRunStartRequest.parse(baseRequest))).resolves.toBeUndefined();
  });

  it("uses the project trust default when Browser access is omitted", async () => {
    const browser = adapter("browser", { browser: true });
    const resolvedRoots: string[] = [];
    const preflight = createRunRequirementsPreflight(resources, "/no-project", {
      registry: registry(browser),
      accessDefault: (root) => {
        resolvedRoots.push(root);
        return "full";
      },
      gitCapability: gitAvailable,
    });

    await expect(
      preflight(
        ControlRunStartRequest.parse({
          prompt: "browse",
          mode: "agent",
          scope: { kind: "project", root: "/trusted-project" },
          harnesses: [browser.id],
          browser: true,
        }),
      ),
    ).resolves.toBeUndefined();
    expect(resolvedRoots).toEqual(["/trusted-project"]);

    await expect(
      preflight(
        ControlRunStartRequest.parse({
          prompt: "plan with browser",
          mode: "plan",
          scope: { kind: "project", root: "/trusted-project" },
          harnesses: [browser.id],
          browser: true,
        }),
      ),
    ).rejects.toMatchObject({ code: "browser_unavailable" });
    expect(resolvedRoots).toEqual(["/trusted-project"]);
  });

  it("refuses only Git-dependent run shapes before harness work", async () => {
    let calls = 0;
    const preflight = createRunRequirementsPreflight(resources, "/no-project", {
      gitCapability: async () => {
        calls += 1;
        return {
          status: "developer_tools_stub",
          version: null,
          detail: "xcode-select: no developer tools",
          remediation:
            "Install Apple Command Line Tools with `xcode-select --install`, then retry.",
        };
      },
    });

    await expect(
      preflight(ControlRunStartRequest.parse({ prompt: "read", mode: "ask" })),
    ).resolves.toBeUndefined();
    await expect(
      preflight(
        ControlRunStartRequest.parse({
          prompt: "repair live",
          mode: "agent",
          untilClean: true,
          execution: { isolation: "live" },
        }),
      ),
    ).resolves.toBeUndefined();
    expect(calls).toBe(0);

    await expect(
      preflight(
        ControlRunStartRequest.parse({
          prompt: "best of",
          mode: "agent",
          n: 2,
          execution: { isolation: "envelope" },
        }),
      ),
    ).rejects.toMatchObject({
      code: "git_developer_tools_stub",
      status: 503,
      retryable: true,
      requiredActions: [expect.stringContaining("xcode-select --install")],
      context: { capability: "git", capabilityStatus: "developer_tools_stub" },
    });
    await expect(
      preflight(
        ControlRunStartRequest.parse({
          prompt: "single live",
          mode: "agent",
          execution: { isolation: "live" },
        }),
      ),
    ).rejects.toMatchObject({ code: "git_developer_tools_stub", status: 503 });
    expect(calls).toBe(2);
  });

  it("honors the daemon's effective thread-workspace Git decision", async () => {
    let probes = 0;
    const preflight = createRunRequirementsPreflight(resources, "/no-project", {
      requiresGit: () => true,
      gitCapability: async () => {
        probes += 1;
        return {
          status: "missing" as const,
          version: null,
          detail: "git executable was not found",
          remediation: "Install Git and retry.",
        };
      },
    });

    await expect(
      preflight(
        ControlRunStartRequest.parse({
          prompt: "repair live",
          mode: "agent",
          untilClean: true,
          execution: { isolation: "live" },
        }),
      ),
    ).rejects.toMatchObject({ code: "git_missing", status: 503 });
    expect(probes).toBe(1);
  });

  it("defers only Git for durable thread jobs while keeping browser admission eager", async () => {
    let probes = 0;
    const lane = adapter("plain");
    const preflight = createRunRequirementsPreflight(
      resources,
      "/no-project",
      {
        requiresGit: () => true,
        gitCapability: async () => {
          probes += 1;
          return {
            status: "missing" as const,
            version: null,
            detail: null,
            remediation: "Install Git and retry.",
          };
        },
        registry: registry(lane),
        statusAll: async () => [
          { id: lane.id, status: "ok" as const, enabledIntents: ["implement" as const] },
        ],
      },
      { git: "durable_job" },
    );

    await expect(
      preflight(ControlRunStartRequest.parse({ prompt: "durable thread", mode: "agent" })),
    ).resolves.toBeUndefined();
    expect(probes).toBe(0);

    await expect(
      preflight(
        ControlRunStartRequest.parse({
          prompt: "browser",
          mode: "agent",
          browser: true,
          access: "full",
        }),
      ),
    ).rejects.toMatchObject({ code: "browser_unavailable" });
    expect(probes).toBe(0);
  });
});
