import { BUILT_IN_TO_FABRIC_TOOLS } from "@repo/database";

/**
 * Built-in capabilities an Agent Task may not be given.
 *
 * An agent task runs with nobody watching, usually holding private project data
 * read through the owner's MCP servers. Three kinds of capability would let it
 * send that data (or the authority to reach more of it) somewhere the owner
 * never approved, so they are refused both when a workflow is published and
 * when the step runs, through the one check below:
 *
 * - frames, which it could create and share itself;
 * - other agents, which may hold tools this step was not given;
 * - anything that reaches an address of the agent's own choosing (web search and
 *   browsing, code execution): a requested URL, or a page it reads, can carry
 *   data out in the address itself.
 *
 * A test scans every tool a capability maps to for parameters that take an
 * address, so a capability added later that fetches one cannot slip past this
 * list unnoticed.
 */
const EGRESS_REASON =
	"an agent running unattended can use it to reach addresses of its own choosing, which could carry private data out";

const DISALLOWED_REASONS: Readonly<Record<string, string>> = {
	"create-frames":
		"an agent running unattended cannot create or share frames itself; use a Publish Frame step to save its result",
	"run-agent":
		"an agent running unattended cannot hand work to other agents, which may hold tools this step was not given",
	"web-search": EGRESS_REASON,
	"web-search-browse": EGRESS_REASON,
	"code-interpreter":
		"an agent running unattended cannot run code, which can reach the network and send private data out",
};

/** Why an unattended agent may not hold this capability, or undefined when it may. */
export function unattendedCapabilityRefusal(
	capability: string,
): string | undefined {
	return Object.hasOwn(DISALLOWED_REASONS, capability)
		? DISALLOWED_REASONS[capability]
		: undefined;
}

/**
 * What is wrong with giving an Agent Task `capability`, written to follow the
 * node's name or stand alone as a step error, or undefined when it is fine.
 * The one check behind publishing and running.
 */
export function agentTaskCapabilityProblem(
	capability: string,
): string | undefined {
	if (!Object.hasOwn(BUILT_IN_TO_FABRIC_TOOLS, capability)) {
		return `"${capability}" is not a built-in capability an agent can use.`;
	}
	const refusal = unattendedCapabilityRefusal(capability);
	return refusal
		? `"${capability}" is not allowed in an agent task: ${refusal}.`
		: undefined;
}
