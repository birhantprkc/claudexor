import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ControlProject,
  ControlProjectListResponse,
  ControlProjectRegisterRequest,
  ControlProjectRelinkRequest,
  ControlProjectRemoveReceipt,
  ControlDirectoryListing,
} from "@claudexor/schema";
import { assertNoInlineSecretValues } from "@claudexor/util";
import { requiredIdempotencyKey } from "./run-start.js";

export interface ProjectRouteServices {
  listProjects?: () => Promise<{ projects: unknown[] }>;
  registerProject?: (input: {
    root: string;
    idempotencyKey: string;
    clientId: string;
  }) => Promise<unknown>;
  relinkProject?: (id: string, root: string) => Promise<unknown>;
  removeProject?: (id: string) => Promise<unknown>;
  listDirectory?: (path?: string) => Promise<unknown>;
  fetchProjectFile?: (
    projectId: string,
    path: string,
  ) => Promise<{ data: Buffer; contentType: string; fileName: string }>;
}

export interface ProjectRouteContext {
  services?: ProjectRouteServices;
  readBody(req: IncomingMessage): Promise<unknown>;
  json(res: ServerResponse, status: number, body: unknown): void;
  requestError(res: ServerResponse, error: unknown, fallbackStatus?: 400 | 500): void;
  binary(
    res: ServerResponse,
    status: number,
    body: Buffer,
    contentType: string,
    fileName: string,
  ): void;
}

export async function handleProjectRoute(
  ctx: ProjectRouteContext,
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (method === "GET" && path === "/filesystem/directories") {
    const service = ctx.services?.listDirectory;
    if (!service) return unsupported(ctx, res);
    let requestedPath: string | undefined;
    try {
      const url = new URL(req.url ?? "", "http://localhost");
      for (const key of url.searchParams.keys()) {
        if (key !== "path") throw new Error(`unexpected query parameter: ${key}`);
      }
      if (url.searchParams.getAll("path").length > 1) {
        throw new Error("path may be specified only once");
      }
      requestedPath = url.searchParams.get("path") ?? undefined;
    } catch (error) {
      ctx.requestError(res, error);
      return true;
    }
    let listing: unknown;
    try {
      listing = await service(requestedPath);
    } catch (error) {
      ctx.requestError(res, error, 500);
      return true;
    }
    try {
      ctx.json(res, 200, ControlDirectoryListing.parse(listing));
    } catch {
      invalidServiceResponse(ctx, res, "listDirectory");
    }
    return true;
  }

  if (method === "GET" && path === "/projects") {
    const service = ctx.services?.listProjects;
    if (!service) return unsupported(ctx, res);
    let response: { projects: unknown[] };
    try {
      response = await service();
    } catch (error) {
      ctx.requestError(res, error, 500);
      return true;
    }
    try {
      ctx.json(
        res,
        200,
        ControlProjectListResponse.parse({ projects: response.projects.map(projectWire) }),
      );
    } catch {
      invalidServiceResponse(ctx, res, "listProjects");
    }
    return true;
  }

  if (method === "POST" && path === "/projects") {
    const service = ctx.services?.registerProject;
    if (!service) return unsupported(ctx, res);
    let input: { root: string; idempotencyKey: string; clientId: string };
    try {
      const idempotencyKey = requiredIdempotencyKey(req);
      const raw = await ctx.readBody(req);
      assertNoInlineSecretValues(raw);
      const body = ControlProjectRegisterRequest.parse(raw);
      input = { root: body.root, idempotencyKey, clientId: "control-api" };
    } catch (error) {
      ctx.requestError(res, error);
      return true;
    }
    let project: unknown;
    try {
      project = await service(input);
    } catch (error) {
      ctx.requestError(res, error, 500);
      return true;
    }
    try {
      ctx.json(res, 200, projectWire(project));
    } catch {
      invalidServiceResponse(ctx, res, "registerProject");
    }
    return true;
  }

  const projectRelinkMatch = /^\/projects\/([^/]+)\/relink$/.exec(path);
  if (method === "POST" && projectRelinkMatch) {
    const service = ctx.services?.relinkProject;
    if (!service) return unsupported(ctx, res);
    let projectId: string;
    let root: string;
    try {
      projectId = decodeURIComponent(projectRelinkMatch[1] as string);
      const raw = await ctx.readBody(req);
      assertNoInlineSecretValues(raw);
      root = ControlProjectRelinkRequest.parse(raw).root;
    } catch (error) {
      ctx.requestError(res, error);
      return true;
    }
    let project: unknown;
    try {
      project = await service(projectId, root);
    } catch (error) {
      ctx.requestError(res, error, 500);
      return true;
    }
    try {
      ctx.json(res, 200, projectWire(project));
    } catch {
      invalidServiceResponse(ctx, res, "relinkProject");
    }
    return true;
  }

  const projectFileMatch = /^\/projects\/([^/]+)\/file$/.exec(path);
  if (method === "GET" && projectFileMatch) {
    const service = ctx.services?.fetchProjectFile;
    if (!service) return unsupported(ctx, res);
    let projectId: string;
    let requestedPath: string;
    try {
      projectId = decodeURIComponent(projectFileMatch[1] as string);
      const url = new URL(req.url ?? "", "http://localhost");
      for (const key of url.searchParams.keys()) {
        if (key !== "path") throw new Error(`unexpected query parameter: ${key}`);
      }
      if (url.searchParams.getAll("path").length !== 1) {
        throw new Error("one path query parameter is required");
      }
      requestedPath = url.searchParams.get("path") ?? "";
    } catch (error) {
      ctx.requestError(res, error);
      return true;
    }
    let file: { data: Buffer; contentType: string; fileName: string };
    try {
      file = await service(projectId, requestedPath);
    } catch (error) {
      ctx.requestError(res, error, 500);
      return true;
    }
    try {
      ctx.binary(res, 200, file.data, file.contentType, file.fileName);
    } catch {
      invalidServiceResponse(ctx, res, "fetchProjectFile");
    }
    return true;
  }

  // QA-049: DELETE /projects/:id — retire a durable project (registry entry +
  // journal-partition archival), typed-fenced against non-purged threads and
  // live/queued runs. Not a relink match, so it lives after that branch.
  const projectDeleteMatch = /^\/projects\/([^/]+)$/.exec(path);
  if (method === "DELETE" && projectDeleteMatch) {
    const service = ctx.services?.removeProject;
    if (!service) return unsupported(ctx, res);
    let projectId: string;
    try {
      projectId = decodeURIComponent(projectDeleteMatch[1] as string);
    } catch (error) {
      ctx.requestError(res, error);
      return true;
    }
    let receipt: unknown;
    try {
      receipt = await service(projectId);
    } catch (error) {
      ctx.requestError(res, error, 500);
      return true;
    }
    try {
      ctx.json(res, 200, ControlProjectRemoveReceipt.parse(receipt));
    } catch {
      invalidServiceResponse(ctx, res, "removeProject");
    }
    return true;
  }
  return false;
}

function unsupported(ctx: ProjectRouteContext, res: ServerResponse): true {
  ctx.json(res, 501, { error: "projects are not supported by this build" });
  return true;
}

function invalidServiceResponse(
  ctx: ProjectRouteContext,
  res: ServerResponse,
  service: string,
): void {
  ctx.requestError(
    res,
    Object.assign(new Error(`${service} returned a response that violates its schema`), {
      status: 500,
      code: "invalid_service_response",
    }),
    500,
  );
}

function projectWire(input: unknown): ControlProject {
  const project = input as Record<string, unknown>;
  return ControlProject.parse({
    schemaVersion: project["schema_version"],
    id: project["id"],
    root: project["root"],
    createdAt: project["created_at"],
    updatedAt: project["updated_at"],
    // F3: disclosed nesting relations (default [] when the service omits them).
    nesting: project["nesting"] ?? [],
  });
}
