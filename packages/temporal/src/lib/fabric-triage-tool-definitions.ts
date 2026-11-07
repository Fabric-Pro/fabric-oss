import type { FabricToolDefinition } from "./fabric-tool-definition";

const id = { type: "string", pattern: "^[A-Za-z0-9._:-]{1,200}$" };
export const FABRIC_TRIAGE_TOOL_DEFINITIONS = (
	["list", "start", "status", "result", "cancel", "review"] as const
).map((op) => {
	const write = ["start", "cancel", "review"].includes(op);
	return {
		name: `fabric_triage_${op}`,
		description: {
			list: "List only your private signal-review runs. Results are selected-evidence proposals, never an all-project health verdict.",
			start: "Run the finite Harness triager on one to five selected private observations. Paid work requires your current scopes and permissions. Reuse the same requestId and original input after uncertainty. Manual local Temporal execution only; no automatic ticket creation.",
			status: "Read minimized private triage run status.",
			result: "Read your private cited triage proposals after fresh source access checks.",
			cancel: "Cancel your triage run; uncertain already-dispatched spend remains reserved.",
			review: "Keep or dismiss a private proposal. This does not create a ticket, share source content or apply a change.",
		}[op],
		scope: write ? "projects:write" : "projects:read",
		annotations: { readOnlyHint: !write, idempotentHint: op !== "start" },
		...(write ? { confirm: "always" as const } : {}),
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				projectId: id,
				...(op !== "start" && op !== "list" ? { runId: id } : {}),
				...(op === "list"
					? { before: { type: "string", maxLength: 2048 } }
					: {}),
				...(op === "start"
					? {
							requestId: { type: "string", format: "uuid" },
							goal: {
								type: "string",
								minLength: 1,
								maxLength: 2000,
							},
							evidenceIds: {
								type: "array",
								minItems: 1,
								maxItems: 5,
								uniqueItems: true,
								items: id,
							},
						}
					: {}),
				...(op === "review"
					? {
							proposalId: {
								type: "string",
								pattern: "^[a-f0-9]{64}$",
							},
							decision: {
								type: "string",
								enum: ["KEEP", "DISMISS"],
							},
						}
					: {}),
			},
			required: [
				"projectId",
				...(op !== "start" && op !== "list" ? ["runId"] : []),
				...(op === "start" ? ["requestId", "goal", "evidenceIds"] : []),
				...(op === "review" ? ["proposalId", "decision"] : []),
			],
		},
	} satisfies FabricToolDefinition;
});
export const TRIAGE_TOOL_NAMES = FABRIC_TRIAGE_TOOL_DEFINITIONS.map(
	(t) => t.name,
);
