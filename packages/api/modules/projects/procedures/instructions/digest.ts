import { ORPCError } from "@orpc/client";
import {
	findReadableInstructionVersion,
	getInstructionSeenMarker,
	getInstructionSnapshot,
	getPublishedInstructionSnapshot,
	listInstructionProposalsResolvedSince,
	listInstructionVersionsPublishedSince,
	recordInstructionSeen,
} from "@repo/database";
import { z } from "zod";
import { projectNotFoundUnlessVisible } from "../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { compareInstructionVersions } from "./compare-core";
import { requireHostingOrganizationId } from "./hosting-organization";
import {
	canReviewInstructionProposals,
	isInstructionSnapshotContentReadable,
} from "./proposal-authorization";

const SHORT_SHA_LENGTH = 7;

const projectInput = z.object({
	projectId: z.string(),
	organizationId: z.string().nullable().optional(),
});

/**
 * The marker's version as a snapshot the compare can read: its own id when
 * that snapshot still exists and is readable, else whichever readable
 * snapshot carries the stored version number. Null when both are gone, and
 * then only the versions and proposals are shown.
 */
async function seenSnapshotOf(input: {
	projectId: string;
	organizationId: string;
	snapshotId: string | null;
	version: number | null;
}): Promise<{ id: string; version: number } | null> {
	if (input.snapshotId !== null) {
		const snapshot = await getInstructionSnapshot(
			input.snapshotId,
			input.projectId,
			input.organizationId,
		);
		if (snapshot && isInstructionSnapshotContentReadable(snapshot)) {
			return { id: snapshot.id, version: snapshot.version };
		}
	}
	if (input.version === null) {
		return null;
	}
	return findReadableInstructionVersion({
		projectId: input.projectId,
		organizationId: input.organizationId,
		version: input.version,
	});
}

/**
 * AUTHORIZATION: tenantProtectedProcedure + projectNotFoundUnlessVisible + requireProjectPermission(INSTRUCTION_READ).
 *
 * What changed on the project's coding instructions since the caller last
 * looked: the versions published since, the paths that differ between the
 * version they saw and the one published now, and the proposals approved or
 * rejected since, filtered by the proposal visibility the History list
 * applies (a member who cannot review sees approved ones and their own).
 *
 * `firstVisit: true` when no marker is stored: there is nothing to compare
 * against, so the tab shows no digest and records the marker. Reading never
 * writes; `markSeen` does.
 *
 * A repository-backed project's versions are the full snapshots its syncs
 * made, so the same snapshot compare applies; each version also carries the
 * branch and short commit it was synced from.
 */
export const getInstructionsDigestProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.INSTRUCTION_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/instructions/digest",
		tags: ["Projects", "Instructions"],
		summary:
			"What changed in the coding instructions since your last visit",
	})
	.input(projectInput)
	.handler(async ({ input, context }) => {
		const organizationId = await requireHostingOrganizationId(
			input.projectId,
			context.user.id,
		);
		const [marker, published] = await Promise.all([
			getInstructionSeenMarker(input.projectId, context.user.id),
			getPublishedInstructionSnapshot(input.projectId),
		]);
		const current = published
			? { snapshotId: published.id, version: published.version }
			: null;
		if (marker === null) {
			return {
				firstVisit: true as const,
				hasChanges: false,
				current,
				seen: null,
				versions: [],
				paths: null,
				proposals: [],
			};
		}
		const canReview = await canReviewInstructionProposals({
			projectId: input.projectId,
			userId: context.user.id,
		});
		const [versions, proposals, seenSnapshot] = await Promise.all([
			listInstructionVersionsPublishedSince({
				projectId: input.projectId,
				organizationId,
				afterVersion: marker.version ?? 0,
				throughVersion: current?.version ?? null,
			}),
			listInstructionProposalsResolvedSince({
				projectId: input.projectId,
				organizationId,
				since: marker.seenAt,
				...(canReview ? {} : { proposerUserId: context.user.id }),
			}),
			seenSnapshotOf({
				projectId: input.projectId,
				organizationId,
				snapshotId: marker.snapshotId,
				version: marker.version,
			}),
		]);
		const pointerMoved =
			current !== null && current.snapshotId !== marker.snapshotId;
		const paths =
			pointerMoved && seenSnapshot !== null
				? await compareInstructionVersions({
						fromSnapshotId: seenSnapshot.id,
						toSnapshotId: current.snapshotId,
						organizationId,
					})
				: null;
		return {
			firstVisit: false as const,
			hasChanges:
				pointerMoved || versions.length > 0 || proposals.length > 0,
			current,
			seen: {
				snapshotId: marker.snapshotId,
				version: marker.version,
				seenAt: marker.seenAt,
				// False when the version they saw was pruned or deleted, so
				// only versions and proposals can be shown.
				comparable: seenSnapshot !== null,
			},
			versions: versions.map((version) => ({
				snapshotId: version.id,
				version: version.version,
				source: version.source,
				sourceRef: version.sourceRef,
				shortCommitSha: version.sourceCommitSha
					? version.sourceCommitSha.slice(0, SHORT_SHA_LENGTH)
					: null,
				publishedAt: version.publishedAt,
				author: version.user,
			})),
			paths,
			proposals: proposals.map((proposal) => ({
				id: proposal.id,
				version: proposal.version,
				status: proposal.proposalStatus,
				reviewedAt: proposal.reviewedAt,
				title: titleOf(proposal.proposalNote),
				proposer: proposal.user,
				reviewer: proposal.reviewer,
			})),
		};
	});

function titleOf(note: unknown): string | null {
	if (typeof note !== "object" || note === null) {
		return null;
	}
	const { title } = note as { title?: unknown };
	return typeof title === "string" && title !== "" ? title : null;
}

/**
 * AUTHORIZATION: tenantProtectedProcedure + projectNotFoundUnlessVisible + requireProjectPermission(INSTRUCTION_READ).
 *
 * Records that the caller has seen the coding instructions as of the
 * published version they were shown (`snapshotId`, null when nothing was
 * published). Called on "Mark all as seen", and by the tab when it is
 * actually viewed with nothing to show; never on project load. Naming the
 * version shown, rather than reading the pointer here, keeps a version
 * published while the digest was open from being marked seen unshown.
 */
export const markInstructionsSeenProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.INSTRUCTION_READ))
	.route({
		method: "POST",
		path: "/projects/:projectId/instructions/seen",
		tags: ["Projects", "Instructions"],
		summary: "Record that you have seen the current coding instructions",
	})
	.input(projectInput.extend({ snapshotId: z.string().nullable() }))
	.handler(async ({ input, context }) => {
		const organizationId = await requireHostingOrganizationId(
			input.projectId,
			context.user.id,
		);
		let version: number | null = null;
		if (input.snapshotId !== null) {
			const snapshot = await getInstructionSnapshot(
				input.snapshotId,
				input.projectId,
				organizationId,
			);
			if (!snapshot || !isInstructionSnapshotContentReadable(snapshot)) {
				throw new ORPCError("NOT_FOUND", {
					message: "Snapshot not found",
				});
			}
			version = snapshot.version;
		}
		await recordInstructionSeen({
			projectId: input.projectId,
			userId: context.user.id,
			organizationId,
			snapshotId: input.snapshotId,
			version,
		});
		return { ok: true as const };
	});
