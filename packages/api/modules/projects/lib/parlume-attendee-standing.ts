import { db } from "@repo/database";
import { Permissions } from "@repo/permissions";
import { userHasProjectPermission } from "../../../orpc/middleware/require-permission";

const MAX_NAME_CHARS = 80;
const SCHEME_OR_ADDRESS = /:\/\/|@/;
// Ideographic and halfwidth full stops read as dots in a link.
const FULL_STOPS = /[。｡]/g;
// Brackets and quotes can wrap a link inside one word: "[x](example.com)".
const WRAPPERS = /[()[\]{}<>"'`“”‘’«»]+/;
const EDGE_PUNCTUATION = /^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu;
// A dotted host such as "www.example.com/path". Its ending is letters in
// one case, as a domain's is, so "Dr.Smith" stays a name.
const HOST =
	/^[^\s.]+(?:\.[^\s.]+)*\.(?:[a-z]{2,63}|[A-Z]{2,63})(?:[/:?#]\S*)?$/;

/** Whether this Fabric account may read the project Parlume answers for. */
export function mayReadParlumeProject(input: {
	userId: string;
	projectId: string;
}): Promise<boolean> {
	return userHasProjectPermission({
		...input,
		permission: Permissions.PROJECT_READ,
	});
}

/**
 * Checked as each turn starts, from the database alone: the first of the
 * confirmed attendees who can no longer read the project, or null while
 * every one of them still can.
 */
export async function findParlumeAttendeeWithoutRead(input: {
	projectId: string;
	userIds: string[];
}): Promise<{ name: string | null } | null> {
	const userIds = [...new Set(input.userIds)];
	const standing = await Promise.all(
		userIds.map((userId) =>
			mayReadParlumeProject({ userId, projectId: input.projectId }),
		),
	);
	const lost = userIds.find((_, index) => !standing[index]);
	if (lost === undefined) {
		return null;
	}
	const user = await db.user.findUnique({
		where: { id: lost },
		select: { name: true },
	});
	return { name: user?.name ?? null };
}

/** A display name fit to print: no link or address left in it, never blank. */
function printableName(name: string | null): string {
	const words = (name ?? "")
		.split(/\s+/)
		.filter((word) => word && !isLinkOrAddress(word));
	return words.join(" ").slice(0, MAX_NAME_CHARS).trim() || "a participant";
}

function isLinkOrAddress(word: string): boolean {
	const text = word.normalize("NFKC").replace(FULL_STOPS, ".");
	if (SCHEME_OR_ADDRESS.test(text)) {
		return true;
	}
	return text.split(WRAPPERS).some(isHost);
}

function isHost(part: string): boolean {
	return HOST.test(part.replace(EDGE_PUNCTUATION, ""));
}

/**
 * What Parlume says in the meeting chat before it leaves because it cannot
 * answer in front of everyone there. One plain paragraph.
 */
export function parlumeDepartureNotice(
	cause: { kind: "channel" } | { kind: "attendee"; name: string | null },
): string {
	switch (cause.kind) {
		case "channel":
			return "I'm leaving: this meeting's chat belongs to a Teams channel, and I cannot check that everyone who reads it can see this project in Fabric.";
		case "attendee":
			return `I'm leaving: I could not confirm that ${printableName(cause.name)} can see this project in Fabric. I answer only when everyone in the meeting can.`;
		default: {
			const unreachable: never = cause;
			return unreachable;
		}
	}
}
