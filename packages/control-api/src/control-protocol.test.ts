import { CONTROL_PROTOCOL_MAJOR } from "@claudexor/schema";
import { describe, expect, it } from "vitest";
import { resolveControlProtocol } from "./control-protocol.js";

const MAJOR = String(CONTROL_PROTOCOL_MAJOR);

function boundary(input: {
  method?: string;
  requestPath: string;
  requestedMajor?: string;
  servingMode?: "normal" | "recovery_only";
  body?: unknown;
}) {
  return resolveControlProtocol({
    method: input.method ?? "GET",
    requestPath: input.requestPath,
    requestedMajor: input.requestedMajor ?? MAJOR,
    readBody: async () => input.body ?? {},
    servingMode: input.servingMode,
  });
}

describe("control protocol recovery-only gate (issue #165 D5)", () => {
  it("carries servingMode in the handshake from the canonical admission snapshot", async () => {
    const recovery = await boundary({
      method: "POST",
      requestPath: "/v2/handshake",
      servingMode: "recovery_only",
      body: { protocolMajor: CONTROL_PROTOCOL_MAJOR, client: "test" },
    });
    expect(recovery).toMatchObject({
      kind: "response",
      status: 200,
      body: { compatible: true, servingMode: "recovery_only" },
    });
    const normal = await boundary({
      method: "POST",
      requestPath: "/v2/handshake",
      body: { protocolMajor: CONTROL_PROTOCOL_MAJOR, client: "test" },
    });
    expect(normal).toMatchObject({
      kind: "response",
      status: 200,
      body: { compatible: true, servingMode: "normal" },
    });
  });

  it("typed-refuses every product route while serving recovery only", async () => {
    for (const requestPath of ["/v2/runs", "/v2/threads", "/v2/settings", "/v2/projects"]) {
      const result = await boundary({ requestPath, servingMode: "recovery_only" });
      expect(result).toMatchObject({
        kind: "response",
        status: 503,
        contentType: "application/problem+json",
        body: { code: "daemon_recovery_only", retryable: true },
      });
    }
  });

  it("keeps the journal recovery surface and the operations catalog reachable", async () => {
    await expect(
      boundary({ requestPath: "/v2/recovery/partitions/global", servingMode: "recovery_only" }),
    ).resolves.toEqual({ kind: "route", path: "/recovery/partitions/global" });
    await expect(
      boundary({
        method: "POST",
        requestPath: "/v2/recovery/partitions/global/quarantine",
        servingMode: "recovery_only",
      }),
    ).resolves.toEqual({ kind: "route", path: "/recovery/partitions/global/quarantine" });
    await expect(
      boundary({ requestPath: "/v2/operations", servingMode: "recovery_only" }),
    ).resolves.toMatchObject({ kind: "response", status: 200 });
  });

  it("routes product paths normally once admission is open (and when unwired)", async () => {
    await expect(boundary({ requestPath: "/v2/runs", servingMode: "normal" })).resolves.toEqual({
      kind: "route",
      path: "/runs",
    });
    await expect(boundary({ requestPath: "/v2/runs" })).resolves.toEqual({
      kind: "route",
      path: "/runs",
    });
  });
});
