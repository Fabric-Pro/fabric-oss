/**
 * How the arguments of a change Parlume proposed read, in its meeting-chat
 * post and on the change's page in Fabric alike.
 */

/** The work item kinds and priority bands a proposed change can carry. */
const PROPOSAL_ENUM_VALUES = [
	"FEATURE",
	"BUG",
	"INITIATIVE",
	"P0_CRITICAL",
	"P1_HIGH",
	"P2_MEDIUM",
	"P3_LOW",
] as const;
type ProposalEnumValue = (typeof PROPOSAL_ENUM_VALUES)[number];

/** How the app names each one. */
function proposalEnumLabel(value: ProposalEnumValue): string {
	switch (value) {
		case "FEATURE":
			return "Feature";
		case "BUG":
			return "Bug";
		case "INITIATIVE":
			return "Initiative";
		case "P0_CRITICAL":
			return "Critical";
		case "P1_HIGH":
			return "High";
		case "P2_MEDIUM":
			return "Medium";
		case "P3_LOW":
			return "Low";
		default: {
			const unreachable: never = value;
			return unreachable;
		}
	}
}

/** An argument's name as words: "storyKind" reads "Story kind". */
export function parlumeProposalFieldLabel(key: string): string {
	const words = key
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.replace(/[_-]+/g, " ")
		.trim()
		.toLowerCase();
	return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/**
 * A kind or priority as the app names it ("BUG" reads "Bug"); any other
 * value as given.
 */
export function parlumeProposalValueLabel(value: string): string {
	const known = PROPOSAL_ENUM_VALUES.find((candidate) => candidate === value);
	return known ? proposalEnumLabel(known) : value;
}
