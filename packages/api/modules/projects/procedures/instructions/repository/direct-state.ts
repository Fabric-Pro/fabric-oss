/**
 * Shared metadata-only direct repository state. Both the session oRPC route
 * and v1 API-key routes use this boundary, so a provider failure cannot turn
 * a post-I/O project-access refusal into a public "unavailable" result.
 */
import { ORPCError } from "@orpc/client";
import {
	assertDirectRepositoryReadAllowed,
	assertDirectRepositorySourceCurrent,
	type DirectRepositoryPin,
	type DirectRepositorySource,
	loadDirectRepositorySource,
	resolveDirectRepositoryHead,
} from "./direct-source";

export type DirectRepositoryAvailability =
	| "READY"
	| "UPLOAD"
	| "MIGRATING"
	| "DISCONNECTED"
	| "CREDENTIALS_EXPIRED"
	| "NOT_FOUND"
	| "UNAVAILABLE";

type UnavailableDirectRepositoryAvailability = Exclude<
	DirectRepositoryAvailability,
	"READY"
>;

export type ResolvedDirectRepositoryState =
	| {
			availability: "READY";
			readState: "DIRECT";
			source: DirectRepositorySource;
			pin: DirectRepositoryPin;
	  }
	| {
			availability: Exclude<DirectRepositoryAvailability, "READY">;
			readState: "DIRECT";
	  };

function errorCode(error: unknown): string | null {
	if (!(error instanceof ORPCError)) {
		return null;
	}
	const data = error.data;
	return typeof data === "object" &&
		data !== null &&
		"code" in data &&
		typeof data.code === "string"
		? data.code
		: null;
}

export function directRepositoryAvailability(
	error: unknown,
): UnavailableDirectRepositoryAvailability {
	switch (errorCode(error)) {
		case "NOT_REPOSITORY_SOURCED":
			return "UPLOAD";
		case "INSTRUCTION_MIGRATION_IN_PROGRESS":
			return "MIGRATING";
		case "REPOSITORY_NOT_FOUND":
		case "REPOSITORY_UNAVAILABLE":
			return "DISCONNECTED";
		case "REPOSITORY_CREDENTIALS_EXPIRED":
			return "CREDENTIALS_EXPIRED";
		case "BRANCH_NOT_FOUND":
		case "COMMIT_NOT_FOUND":
			return "NOT_FOUND";
		default:
			return "UNAVAILABLE";
	}
}

function isProjectReadRefusal(error: unknown): boolean {
	return (
		error instanceof ORPCError &&
		(error.code === "FORBIDDEN" ||
			(error.code === "NOT_FOUND" && errorCode(error) === null))
	);
}

/**
 * Resolve one direct-repository head. A provider failure still performs a
 * fresh project-access/configuration fence before exposing its availability.
 */
export async function resolveDirectRepositoryState(input: {
	projectId: string;
	userId: string;
	signal?: AbortSignal;
}): Promise<ResolvedDirectRepositoryState> {
	let source: DirectRepositorySource | null = null;
	try {
		source = await loadDirectRepositorySource(input);
		const pin = await resolveDirectRepositoryHead(source);
		await assertDirectRepositorySourceCurrent({ ...input, source });
		return { availability: "READY", readState: "DIRECT", source, pin };
	} catch (error) {
		input.signal?.throwIfAborted();
		await assertDirectRepositoryReadAllowed(input);
		if (source !== null) {
			try {
				await assertDirectRepositorySourceCurrent({ ...input, source });
			} catch (recheckError) {
				if (isProjectReadRefusal(recheckError)) {
					throw recheckError;
				}
				return {
					availability: directRepositoryAvailability(recheckError),
					readState: "DIRECT",
				};
			}
		}
		if (isProjectReadRefusal(error)) {
			throw error;
		}
		return {
			availability: directRepositoryAvailability(error),
			readState: "DIRECT",
		};
	}
}
