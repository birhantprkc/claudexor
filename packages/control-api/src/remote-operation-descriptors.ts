import type { OperationDraft } from "./operation-draft.js";
import { queryParam } from "./operation-parameters.js";

export const REMOTE_OPERATION_DRAFTS = [
  {
    method: "GET",
    path: "/v2/filesystem/directories",
    mutability: "read_only",
    requestSchema: null,
    responseSchema: "ControlDirectoryListing",
    responseKind: "json",
    summary: "List a directory contained by the server user's home.",
    parameters: [
      queryParam({
        name: "path",
        description: "Absolute directory under the server user's home; omit to start at HOME.",
      }),
    ],
  },
  {
    method: "GET",
    path: "/v2/projects/:id/file",
    mutability: "read_only",
    requestSchema: null,
    responseSchema: null,
    responseKind: "binary",
    summary: "Fetch one bounded file contained by a registered project.",
    parameters: [
      queryParam({
        name: "path",
        required: true,
        description: "Relative path contained by the registered project.",
      }),
    ],
  },
] as const satisfies readonly OperationDraft[];
