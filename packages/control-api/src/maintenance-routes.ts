import type { IncomingMessage, ServerResponse } from "node:http";
import { ControlGcReceipt, ControlGcRequest } from "@claudexor/schema";
import { routeValue, serviceResponse } from "./route-stages.js";

export interface MaintenanceRouteServices {
  /** One retention pass over engine-owned runtime artifacts (W3.6). */
  runRetention(request: ControlGcRequest): Promise<ControlGcReceipt>;
}

export interface MaintenanceRouteContext {
  services?: Partial<MaintenanceRouteServices>;
  readBody(req: IncomingMessage): Promise<unknown>;
  json(res: ServerResponse, status: number, body: unknown): void;
  requestError(res: ServerResponse, error: unknown, fallbackStatus?: 400 | 500): void;
}

export async function handleMaintenanceRoute(
  ctx: MaintenanceRouteContext,
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (method === "POST" && path === "/maintenance/gc") {
    const service = ctx.services?.runRetention;
    if (!service) return false;
    const request = await routeValue(ctx, res, 400, async () =>
      ControlGcRequest.parse((await ctx.readBody(req)) ?? {}),
    );
    if (!request.ok) return true;
    const receipt = await routeValue(ctx, res, 500, () => service(request.value));
    if (!receipt.ok) return true;
    return serviceResponse(ctx, res, "runRetention", () =>
      ctx.json(res, 200, ControlGcReceipt.parse(receipt.value)),
    );
  }
  return false;
}
