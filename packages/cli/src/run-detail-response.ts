import { ControlRunDetail } from "@claudexor/schema";
import { CliError } from "./cli-error.js";

type JsonResponse = { json(): Promise<unknown> };

/** Decode and schema-check a successful Control API run-detail response. */
export async function readRunDetailResponse(
  response: JsonResponse,
): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw invalidRunDetailResponse("run detail endpoint returned malformed JSON");
  }
  if (!ControlRunDetail.safeParse(body).success) {
    throw invalidRunDetailResponse("run detail endpoint returned an invalid response");
  }
  return body as Record<string, unknown>;
}

function invalidRunDetailResponse(message: string): CliError {
  return new CliError("operational", message, {
    code: "invalid_service_response",
    retryable: true,
  });
}
