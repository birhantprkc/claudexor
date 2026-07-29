import { accessSync, constants, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";
import { labelStreams, runCaptureRaw, type CaptureResult } from "@claudexor/core";
import { GitCapability, type GitCapability as GitCapabilityValue } from "@claudexor/schema";

const INSTALL_COMMAND_LINE_TOOLS =
  "Install Apple Command Line Tools with `xcode-select --install`, then retry.";
const INSTALL_GIT = "Install Git and make it available on PATH, then retry.";

export interface GitProbeDependencies {
  resolveGit?: () => string | null;
  runVersion?: (executable: string) => Promise<CaptureResult>;
  runXcodeSelect?: () => Promise<CaptureResult>;
}

export interface GitCapabilityProblem {
  code: "git_missing" | "git_developer_tools_stub" | "git_failed";
  reason: string;
  remediation: string | null;
}

/** Canonical user-safe problem for every Git capability consumer. */
export function gitCapabilityProblem(capability: GitCapabilityValue): GitCapabilityProblem | null {
  if (capability.status === "available") return null;
  const reason =
    capability.status === "developer_tools_stub"
      ? "Git is unavailable because Apple Command Line Tools are not installed."
      : capability.status === "missing"
        ? "Git is not installed or is not available on this engine's PATH."
        : "Git was found but could not run successfully in this engine environment.";
  return {
    code: `git_${capability.status}`,
    reason,
    remediation: capability.remediation,
  };
}

function appleDeveloperToolsStub(detail: string): boolean {
  const normalized = detail.toLowerCase();
  return normalized.includes("xcode-select") && normalized.includes("developer tools");
}

function executableOnPath(name: string, path = process.env.PATH ?? ""): string | null {
  for (const entry of path.split(delimiter)) {
    const candidate = join(entry || ".", name);
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      // Continue to the next PATH entry.
    }
  }
  return null;
}

function executableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Probe the actual Git executable used by this daemon, not path/file presence. */
export async function probeGitCapability(
  dependencies: GitProbeDependencies = {},
): Promise<GitCapabilityValue> {
  const executable = (dependencies.resolveGit ?? (() => executableOnPath("git")))();
  if (!executable) {
    return GitCapability.parse({
      status: "missing",
      version: null,
      detail: "No executable named git was found on PATH.",
      remediation: INSTALL_GIT,
    });
  }
  try {
    // On clean macOS `/usr/bin/git` is an Apple launcher whose execution can
    // open the developer-tools installer. Ask xcode-select first; this probe is
    // non-mutating and prevents a readiness refresh from surprising the user.
    if (
      executable === "/usr/bin/git" &&
      (dependencies.runXcodeSelect !== undefined || executableFile("/usr/bin/xcode-select"))
    ) {
      const xcodeSelect = await (
        dependencies.runXcodeSelect ??
        (() =>
          runCaptureRaw("/usr/bin/xcode-select", ["--print-path"], {
            timeoutMs: 10_000,
            inheritEnv: "mirror_native",
          }))
      )();
      if (xcodeSelect.code !== 0 || !xcodeSelect.stdout.trim()) {
        return GitCapability.parse({
          status: "developer_tools_stub",
          version: null,
          detail: labelStreams(xcodeSelect.stderr, xcodeSelect.stdout),
          remediation: INSTALL_COMMAND_LINE_TOOLS,
        });
      }
    }
    const result = await (
      dependencies.runVersion ??
      ((path) =>
        runCaptureRaw(path, ["--version"], {
          timeoutMs: 10_000,
          inheritEnv: "mirror_native",
        }))
    )(executable);
    const detail = labelStreams(result.stderr, result.stdout);
    if (result.code === 0) {
      return GitCapability.parse({
        status: "available",
        version: result.stdout.trim() || null,
        detail: null,
        remediation: null,
      });
    }
    if (appleDeveloperToolsStub(`${result.stderr}\n${result.stdout}`)) {
      return GitCapability.parse({
        status: "developer_tools_stub",
        version: null,
        detail,
        remediation: INSTALL_COMMAND_LINE_TOOLS,
      });
    }
    return GitCapability.parse({
      status: "failed",
      version: null,
      detail,
      remediation: INSTALL_GIT,
    });
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
    return GitCapability.parse({
      status: missing ? "missing" : "failed",
      version: null,
      detail: error instanceof Error ? error.message : String(error),
      remediation: INSTALL_GIT,
    });
  }
}

export class GitCapabilityError extends Error {
  readonly code: string;

  constructor(readonly capability: GitCapabilityValue) {
    const problem = gitCapabilityProblem(capability);
    if (!problem) throw new Error("GitCapabilityError requires an unavailable capability");
    super([problem.reason, problem.remediation].filter(Boolean).join(" "));
    this.name = "GitCapabilityError";
    this.code = problem.code;
  }
}

export function requireGitCapability(capability: GitCapabilityValue): void {
  if (capability.status !== "available") throw new GitCapabilityError(capability);
}
