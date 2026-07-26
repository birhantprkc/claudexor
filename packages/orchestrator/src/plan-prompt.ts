/** Explicitly keep a plan-mode harness in read-only planning work. */
export function planPrompt(goal: string): string {
  return [
    `You are planning, NOT implementing. Explore the repository read-only and produce a plan another agent will execute later. Do not write files or output full implementations.`,
    ``,
    `## Goal`,
    goal,
    ``,
    `## Required output (markdown)`,
    `1. Approach — 2-3 sentences on how you'd solve this.`,
    `2. Steps — a numbered list; each step names the file(s) it touches and what changes.`,
    `3. Risks & edge cases.`,
    `4. End your response with a section titled exactly:`,
    ``,
    `## Open Questions`,
    ``,
    `List every decision the user must make before implementation, one per bullet, in EXACTLY this format:`,
    ``,
    `- [single] <question> :: <option A> :: <option B>`,
    `- [multi] <question> :: <option A> :: <option B>`,
    `- [text] <question that has no good fixed options>`,
    ``,
    `Rules: [single] = pick exactly one; [multi] = pick one or more; [text] = free-form (no "::" options). Ground every option in THIS repository. If nothing is ambiguous, write a single bullet: - (none)`,
    ``,
    `Keep it concise. Reference real paths you found. Do NOT paste large code blocks; describe the change instead.`,
  ].join("\n");
}
