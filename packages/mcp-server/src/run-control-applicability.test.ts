import { describe, expect, it } from "vitest";
import { defaultClaudexorTools } from "./index.js";

describe("MCP run-control applicability", () => {
  const tools = defaultClaudexorTools(async () => ({ summary: "ok" }));

  it.each(["claudexor_ask", "claudexor_plan"])(
    "%s does not advertise Agent-only review controls",
    (name) => {
      const schema = tools.find((tool) => tool.name === name)?.inputSchema as any;
      expect(schema.properties.reviewerPanel).toBeUndefined();
      expect(schema.properties.reviewerModels).toBeUndefined();
      expect(schema.properties.reviewerEfforts).toBeUndefined();
      expect(schema.properties.protectedPathApprovals).toBeUndefined();
    },
  );

  it("keeps Agent review controls on Agent tools", () => {
    const schema = tools.find((tool) => tool.name === "claudexor_run")?.inputSchema as any;
    expect(schema.properties.reviewerPanel.type).toBe("array");
    expect(schema.properties.protectedPathApprovals.type).toBe("array");
  });

  it("does not invent an MCP attachment/upload surface for Plan", () => {
    const schema = tools.find((tool) => tool.name === "claudexor_plan")?.inputSchema as any;
    for (const key of ["attachments", "attachment", "resources", "resourceIds", "images"]) {
      expect(schema.properties[key]).toBeUndefined();
    }
  });
});
