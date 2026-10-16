/**
 * What the Living Memory write-folder procedures share (ADR-022): the shape a
 * folder is shown in, and the refusals they answer with.
 *
 * A refusal is decided INSIDE the query's transaction, under the sync's lock
 * (`createContextWriteTarget`, `updateContextWriteTarget`), and turned into an
 * error here, after the transaction has ended. Every one is `BAD_REQUEST`
 * with `data.code` (and `data.path`, naming the folder, where there is one),
 * as `configure` answers, except the one about rights, which is `FORBIDDEN`.
 */
import { ORPCError } from "@orpc/client";
import type { ContextWriteTargetView } from "@repo/database";
import type { WriteTargetProblem } from "@repo/temporal/memory-write/target-rules";

export type WriteTargetRefusal =
	| { kind: "direct-push-requires-admin" }
	| { kind: "nothing-to-update" }
	| { kind: "invalid"; problem: WriteTargetProblem };

export function writeTargetRefusalError(
	refusal: WriteTargetRefusal,
): ORPCError<"FORBIDDEN" | "BAD_REQUEST", Record<string, string>> {
	switch (refusal.kind) {
		case "direct-push-requires-admin":
			return new ORPCError("FORBIDDEN", {
				message:
					"Only project admins and owners can turn on direct push, because it lets agents commit to the synced branch without a pull request.",
				data: { code: "DIRECT_PUSH_REQUIRES_ADMIN" },
			});
		case "nothing-to-update":
			return new ORPCError("BAD_REQUEST", {
				message: "Send a folder or a mode to change.",
				data: { code: "NOTHING_TO_UPDATE" },
			});
		case "invalid": {
			const { code, path, withPath, message } = refusal.problem;
			return new ORPCError("BAD_REQUEST", {
				message,
				data: {
					code,
					path,
					...(withPath === undefined ? {} : { withPath }),
				},
			});
		}
	}
}

/** The write folders belong to a sync; without one there is nothing to attach to. */
export function writeTargetsNotConfigured(): ORPCError<
	"BAD_REQUEST",
	{ code: string }
> {
	return new ORPCError("BAD_REQUEST", {
		message:
			"Connect a repository to this project's Living Memory before choosing write folders.",
		data: { code: "NOT_CONFIGURED" },
	});
}

export function writeTargetNotFound(): ORPCError<"NOT_FOUND", undefined> {
	return new ORPCError("NOT_FOUND", { message: "Write folder not found" });
}

/**
 * A write folder as the Context tab and the agents' tools are shown it. Who
 * enabled direct push is kept (an id, never a name) because the record is the
 * point of asking an administrator.
 */
export function toWriteTargetView(target: ContextWriteTargetView) {
	return {
		id: target.id,
		folder: target.folder,
		mode: target.mode,
		version: target.version,
		directPushEnabledById: target.directPushEnabledById,
		directPushEnabledAt: target.directPushEnabledAt,
		updatedById: target.userId,
		createdAt: target.createdAt,
		updatedAt: target.updatedAt,
	};
}
