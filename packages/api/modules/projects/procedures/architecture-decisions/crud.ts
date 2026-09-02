import { ORPCError } from "@orpc/client";
import {
	acknowledgeArchitectureDecision,
	createArchitectureDecision,
	db,
	ensureDecisionType,
	getArchitectureDecision,
	hasProjectAccess,
	listArchitectureDecisions,
	listSupersededIdentifiers,
	markArchitectureDecisionsSuperseded,
	resolveArchitectureDecisionIdentifiers,
	revertArchitectureDecisionToVersion,
	setArchitectureDecisionPinned,
	setArchitectureDecisionVouched,
	softDeleteArchitectureDecision,
	updateArchitectureDecision,
} from "@repo/database";
import { z } from "zod";
import { emitActivity } from "../../../../lib/realtime";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	buildArchitectureDecisionContextContent,
	type DecisionRelationLine,
	removeArchitectureDecisionContext,
	resolveParticipantNames,
	resolveParticipants,
	syncArchitectureDecisionContext,
} from "../../lib/architecture-decision-context";
import {
	isActiveProjectMember,
	notifyDecisionOwner,
} from "../../lib/decision-owner";

const statusEnum = z.enum([
	"PROPOSED",
	"ACCEPTED",
	"SUPERSEDED",
	"DEPRECATED",
	"REJECTED",
]);
const domainEnum = z.enum([
	"infra",
	"data",
	"ai",
	"security",
	"frontend",
	"platform",
]);
const durationEnum = z.enum(["LONG_STANDING", "SHORT_TERM"]);

/**
 * Resolve the tagging inputs into a decisionTypeId. A non-empty new label
 * mints a HUMAN-confirmed taxonomy row at save time — the form pairs it with
 * an explicit null id, so it must win over the null — meaning form-discarded
 * AI suggestions never fragment the project's taxonomy. (Meeting-ingestion
 * mints at draft capture instead; see applyMeetingDecisionTagging.) Otherwise
 * an explicit id (null = clear) applies, but must belong to this project or a
 * foreign row's label would leak into reads and a garbage one surface as 500.
 */
async function resolveDecisionTypeId(
	projectId: string,
	decisionTypeId: string | null | undefined,
	newTypeName: string | null | undefined,
	actor: { userId: string; organizationId: string | undefined },
): Promise<string | null | undefined> {
	const name = newTypeName?.trim();
	if (name) {
		const type = await ensureDecisionType({
			projectId,
			name,
			origin: "HUMAN",
			userId: actor.userId,
			organizationId: actor.organizationId ?? null,
		});
		return type.id;
	}
	if (decisionTypeId !== undefined) {
		if (decisionTypeId === null) {
			return null;
		}
		const known = await db.decisionType.findFirst({
			where: { id: decisionTypeId, projectId },
			select: { id: true },
		});
		if (!known) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Unknown decision type",
			});
		}
		return decisionTypeId;
	}
	return undefined;
}

/**
 * The accountable owner must be a project member: an outsider pick would
 * route notifications about project content to someone with no access to it.
 * Tri-state passthrough — undefined (field absent) stays undefined so a
 * partial update never clears ownership by accident.
 */
async function requireProjectOwner(
	projectId: string,
	ownerUserId: string | null | undefined,
): Promise<string | null | undefined> {
	if (ownerUserId === undefined || ownerUserId === null) {
		return ownerUserId;
	}
	if (!(await isActiveProjectMember(projectId, ownerUserId))) {
		throw new ORPCError("BAD_REQUEST", {
			message: "The owner must be a member of this project",
		});
	}
	return ownerUserId;
}

export const listArchitectureDecisionsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.ARCHITECTURE_DECISION_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/architecture-decisions",
		tags: ["Projects", "Architecture Decisions"],
		summary: "List architecture decisions",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			search: z.string().optional(),
			status: statusEnum.optional(),
			domain: domainEnum.optional(),
			participantUserId: z.string().optional(),
			participant: z.string().optional(),
			dateFrom: z.coerce.date().optional(),
			dateTo: z.coerce.date().optional(),
			limit: z.number().int().min(1).max(200).optional(),
			offset: z.number().int().min(0).optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const canAccess = await hasProjectAccess(
			input.projectId,
			context.user.id,
			organizationId,
		);
		if (!canAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		const result = await listArchitectureDecisions({
			projectId: input.projectId,
			search: input.search,
			status: input.status,
			domain: input.domain,
			participantUserId: input.participantUserId,
			participant: input.participant,
			dateFrom: input.dateFrom,
			dateTo: input.dateTo,
			limit: input.limit,
			offset: input.offset,
		});

		// Resolve participants + owners (name + avatar image) once per page.
		const allIds = [
			...new Set(result.items.flatMap((i) => i.participantUserIds)),
		];
		const resolved = await resolveParticipants(allIds);
		const byId = new Map(resolved.map((p) => [p.id, p]));
		const ownerIds = [
			...new Set(
				result.items
					.map((i) => i.ownerUserId)
					.filter((id): id is string => Boolean(id)),
			),
		];
		const ownerResolved = await resolveParticipants(ownerIds);
		const ownerById = new Map(ownerResolved.map((p) => [p.id, p]));

		return {
			items: result.items.map((i) => {
				const participants = i.participantUserIds.map(
					(id) => byId.get(id) ?? { id, name: id, image: null },
				);
				return {
					...i,
					participants,
					participantNames: participants.map((p) => p.name),
					owner: i.ownerUserId
						? (ownerById.get(i.ownerUserId) ?? {
								id: i.ownerUserId,
								name: i.ownerUserId,
								image: null,
							})
						: null,
				};
			}),
			total: result.total,
		};
	});

export const getArchitectureDecisionProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.ARCHITECTURE_DECISION_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/architecture-decisions/{id}",
		tags: ["Projects", "Architecture Decisions"],
		summary: "Get an architecture decision",
	})
	.input(
		z.object({
			projectId: z.string(),
			id: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const canAccess = await hasProjectAccess(
			input.projectId,
			context.user.id,
			organizationId,
		);
		if (!canAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		const decision = await getArchitectureDecision({
			id: input.id,
			projectId: input.projectId,
		});
		if (!decision) {
			throw new ORPCError("NOT_FOUND", {
				message: "Architecture decision not found",
			});
		}

		const participants = await resolveParticipants(
			decision.participantUserIds,
		);
		const participantNames = participants.map((p) => p.name);
		const owner = decision.ownerUserId
			? ((await resolveParticipants([decision.ownerUserId]))[0] ?? {
					id: decision.ownerUserId,
					name: decision.ownerUserId,
					image: null,
				})
			: null;

		// Resolve the "superseded by" pointer to a human identifier, if set.
		let supersededBy: { identifier: string; title: string } | null = null;
		if (decision.supersededById) {
			supersededBy = await db.architectureDecision.findFirst({
				where: {
					id: decision.supersededById,
					projectId: input.projectId,
				},
				select: { identifier: true, title: true },
			});
		}

		// Resolve the endorser's display name for the vouch badge.
		let vouchedByName: string | null = null;
		if (decision.vouchedById) {
			const voucher = await db.user.findFirst({
				where: { id: decision.vouchedById },
				select: { name: true, email: true },
			});
			vouchedByName = voucher?.name || voucher?.email || null;
		}

		return {
			decision: {
				...decision,
				participants,
				participantNames,
				owner,
				supersededBy,
				vouchedByName,
			},
		};
	});

export const createArchitectureDecisionProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.ARCHITECTURE_DECISION_CREATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/architecture-decisions",
		tags: ["Projects", "Architecture Decisions"],
		summary: "Create an architecture decision",
	})
	.input(
		z
			.object({
				projectId: z.string(),
				organizationId: z.string().nullable().optional(),
				title: z.string().min(1).max(255),
				decision: z.string().min(1),
				contextProblem: z.string().optional(),
				rationale: z.string().optional(),
				decisionDrivers: z.string().nullable().optional(),
				alternativesConsidered: z.string().nullable().optional(),
				consequences: z.string().nullable().optional(),
				status: statusEnum.optional(),
				domain: domainEnum.nullable().optional(),
				decisionDate: z.coerce.date().optional(),
				participantUserIds: z.array(z.string()).optional(),
				participantsText: z.string().nullable().optional(),
				relatedDecisionIds: z.array(z.string()).optional(),
				supersedesIds: z.array(z.string()).optional(),
				decisionTypeId: z.string().nullable().optional(),
				newDecisionTypeName: z.string().max(60).nullable().optional(),
				ownerUserId: z.string().nullable().optional(),
				// AC1: a captured decision must carry a duration classification.
				// Owner is the one field the criterion lets stay unassigned.
				duration: durationEnum,
				priorityFlagged: z.boolean().optional(),
				// FR4: provenance for decisions captured by hand. The meeting path
				// already records sourceKind/sourceMetadata; without this the other
				// capture path FR1 names had no source at all.
				sourceReference: z
					.string()
					.trim()
					.max(500)
					.nullable()
					.optional(),
			})
			// The half of AC1's type rule a single field cannot express: the type
			// arrives either as an existing id or as a new label to mint, and one
			// of the two must be present.
			.refine(
				(v) =>
					Boolean(v.decisionTypeId ?? v.newDecisionTypeName?.trim()),
				{
					path: ["decisionTypeId"],
					message:
						"A decision needs a type — choose an existing one or name a new one.",
				},
			),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const canAccess = await hasProjectAccess(
			input.projectId,
			user.id,
			organizationId,
		);
		if (!canAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		const actor = { userId: user.id, organizationId };
		const decisionTypeId = await resolveDecisionTypeId(
			input.projectId,
			input.decisionTypeId,
			input.newDecisionTypeName,
			actor,
		);
		const ownerUserId = await requireProjectOwner(
			input.projectId,
			input.ownerUserId,
		);

		const decision = await createArchitectureDecision({
			projectId: input.projectId,
			createdById: user.id,
			editedByName: user.name || user.email || "Unknown",
			title: input.title,
			decision: input.decision,
			contextProblem: input.contextProblem ?? "",
			rationale: input.rationale ?? "",
			decisionDrivers: input.decisionDrivers ?? null,
			alternativesConsidered: input.alternativesConsidered ?? null,
			consequences: input.consequences ?? null,
			status: input.status,
			domain: input.domain ?? null,
			decisionDate: input.decisionDate,
			participantUserIds: input.participantUserIds ?? [],
			participantsText: input.participantsText ?? null,
			relatedDecisionIds: input.relatedDecisionIds ?? [],
			decisionTypeId: decisionTypeId ?? null,
			ownerUserId,
			duration: input.duration,
			priorityFlagged: input.priorityFlagged ?? false,
			// FR4: every decision records where it came from. A hand-captured
			// one is "manual"; the reference names the ticket or feature behind
			// it when the author supplies one.
			sourceKind: "manual",
			sourceMetadata: {
				capturedBy: user.id,
				reference: input.sourceReference?.trim() || null,
			},
			userId: user.id,
			organizationId,
		});

		await applySupersedes(
			input.projectId,
			decision.id,
			input.supersedesIds,
			user,
			organizationId,
		);

		await syncAndNotify(
			decision,
			user,
			organizationId,
			"architecture_decision_created",
		);
		await notifyDecisionOwner(decision, user, organizationId, true);

		return { decision };
	});

export const updateArchitectureDecisionProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.ARCHITECTURE_DECISION_UPDATE))
	.route({
		method: "PATCH",
		path: "/projects/{projectId}/architecture-decisions/{id}",
		tags: ["Projects", "Architecture Decisions"],
		summary: "Update an architecture decision",
	})
	.input(
		z.object({
			projectId: z.string(),
			id: z.string(),
			organizationId: z.string().nullable().optional(),
			title: z.string().min(1).max(255).optional(),
			decision: z.string().min(1).optional(),
			contextProblem: z.string().optional(),
			rationale: z.string().optional(),
			decisionDrivers: z.string().nullable().optional(),
			alternativesConsidered: z.string().nullable().optional(),
			consequences: z.string().nullable().optional(),
			status: statusEnum.optional(),
			domain: domainEnum.nullable().optional(),
			decisionDate: z.coerce.date().optional(),
			participantUserIds: z.array(z.string()).optional(),
			participantsText: z.string().nullable().optional(),
			supersededById: z.string().nullable().optional(),
			relatedDecisionIds: z.array(z.string()).optional(),
			supersedesIds: z.array(z.string()).optional(),
			decisionTypeId: z.string().nullable().optional(),
			newDecisionTypeName: z.string().max(60).nullable().optional(),
			ownerUserId: z.string().nullable().optional(),
			duration: durationEnum.nullable().optional(),
			priorityFlagged: z.boolean().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const canAccess = await hasProjectAccess(
			input.projectId,
			user.id,
			organizationId,
		);
		if (!canAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		// Capture the prior owner so an owner CHANGE can notify as an
		// assignment rather than a routine content update.
		const prior = await db.architectureDecision.findFirst({
			where: { id: input.id, projectId: input.projectId },
			select: { ownerUserId: true },
		});

		const actor = { userId: user.id, organizationId };
		const decisionTypeId = await resolveDecisionTypeId(
			input.projectId,
			input.decisionTypeId,
			input.newDecisionTypeName,
			actor,
		);
		const ownerUserId = await requireProjectOwner(
			input.projectId,
			input.ownerUserId,
		);

		const decision = await updateArchitectureDecision({
			id: input.id,
			projectId: input.projectId,
			editedById: user.id,
			editedByName: user.name || user.email || "Unknown",
			data: {
				title: input.title,
				decision: input.decision,
				contextProblem: input.contextProblem,
				rationale: input.rationale,
				decisionDrivers: input.decisionDrivers,
				alternativesConsidered: input.alternativesConsidered,
				consequences: input.consequences,
				status: input.status,
				domain: input.domain,
				decisionDate: input.decisionDate,
				participantUserIds: input.participantUserIds,
				participantsText: input.participantsText,
				supersededById: input.supersededById,
				relatedDecisionIds: input.relatedDecisionIds,
				...(decisionTypeId !== undefined ? { decisionTypeId } : {}),
				...(ownerUserId !== undefined ? { ownerUserId } : {}),
				...(input.duration !== undefined
					? { duration: input.duration }
					: {}),
				...(input.priorityFlagged !== undefined
					? { priorityFlagged: input.priorityFlagged }
					: {}),
			},
		});
		if (!decision) {
			throw new ORPCError("NOT_FOUND", {
				message: "Architecture decision not found",
			});
		}

		await applySupersedes(
			input.projectId,
			decision.id,
			input.supersedesIds,
			user,
			organizationId,
		);

		await syncAndNotify(
			decision,
			user,
			organizationId,
			"architecture_decision_updated",
		);
		await notifyDecisionOwner(
			decision,
			user,
			organizationId,
			Boolean(prior?.ownerUserId !== decision.ownerUserId),
		);

		return { decision };
	});

export const deleteArchitectureDecisionProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.ARCHITECTURE_DECISION_DELETE))
	.route({
		method: "DELETE",
		path: "/projects/{projectId}/architecture-decisions/{id}",
		tags: ["Projects", "Architecture Decisions"],
		summary: "Delete an architecture decision",
	})
	.input(
		z.object({
			projectId: z.string(),
			id: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const canAccess = await hasProjectAccess(
			input.projectId,
			user.id,
			organizationId,
		);
		if (!canAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		const removed = await softDeleteArchitectureDecision({
			id: input.id,
			projectId: input.projectId,
		});
		if (!removed) {
			throw new ORPCError("NOT_FOUND", {
				message: "Architecture decision not found",
			});
		}

		if (removed.contextId) {
			await removeArchitectureDecisionContext({
				contextId: removed.contextId,
				projectId: input.projectId,
				userId: user.id,
				organizationId,
			});
		}

		await emitActivity({
			projectId: input.projectId,
			userId: user.id,
			userName: user.name || user.email || "Anonymous",
			activityType: "architecture_decision_deleted",
			resourceType: "architecture_decision",
			resourceId: input.id,
			resourceName: input.id,
			timestamp: new Date().toISOString(),
		});

		return { success: true };
	});

export const revertArchitectureDecisionVersionProcedure =
	tenantProtectedProcedure
		.use(requireProjectPermission(Permissions.ARCHITECTURE_DECISION_UPDATE))
		.route({
			method: "POST",
			path: "/projects/{projectId}/architecture-decisions/{id}/revert",
			tags: ["Projects", "Architecture Decisions"],
			summary: "Revert an architecture decision to a prior version",
		})
		.input(
			z.object({
				projectId: z.string(),
				id: z.string(),
				version: z.number().int().min(1),
				organizationId: z.string().nullable().optional(),
			}),
		)
		.handler(async ({ input, context }) => {
			const user = context.user;
			const organizationId = resolveOrganizationId(
				input.organizationId,
				context.session,
			);
			const canAccess = await hasProjectAccess(
				input.projectId,
				user.id,
				organizationId,
			);
			if (!canAccess) {
				throw new ORPCError("FORBIDDEN", {
					message: "You don't have access to this project",
				});
			}

			// A revert can flip ownership back to the snapshot's owner, so
			// capture the prior owner first to route that as an assignment.
			const prior = await db.architectureDecision.findFirst({
				where: { id: input.id, projectId: input.projectId },
				select: { ownerUserId: true },
			});

			const decision = await revertArchitectureDecisionToVersion({
				id: input.id,
				projectId: input.projectId,
				version: input.version,
				editedById: user.id,
				editedByName: user.name || user.email || "Unknown",
			});
			if (!decision) {
				throw new ORPCError("NOT_FOUND", {
					message: "Architecture decision or version not found",
				});
			}

			// A snapshot can name an owner who has since left the project. Restoring
			// it verbatim would hand accountability — and a notification naming the
			// decision — to a non-member, so clear it instead of reviving it.
			const restored =
				decision.ownerUserId &&
				!(await isActiveProjectMember(
					input.projectId,
					decision.ownerUserId,
				))
					? ((await updateArchitectureDecision({
							id: input.id,
							projectId: input.projectId,
							editedById: user.id,
							editedByName: user.name || user.email || "Unknown",
							data: { ownerUserId: null },
						})) ?? decision)
					: decision;

			await syncAndNotify(
				restored,
				user,
				organizationId,
				"architecture_decision_updated",
			);
			await notifyDecisionOwner(
				restored,
				user,
				organizationId,
				prior?.ownerUserId !== restored.ownerUserId,
			);

			return { decision: restored };
		});

/**
 * The owner signs off on a decision they were assigned (AC3/UC2). Notifying the
 * owner records that they were told; this records that they accepted, so
 * "has the owner acted?" is a question the log can answer.
 *
 * Gated on READ rather than UPDATE on purpose: acknowledging is not editing the
 * decision, and an owner who can see a decision assigned to them must be able to
 * accept it without also holding edit rights. The narrowing that matters is
 * ownership, and the query enforces it by matching ownerUserId.
 */
export const acknowledgeArchitectureDecisionProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.ARCHITECTURE_DECISION_READ))
	.route({
		method: "POST",
		path: "/projects/{projectId}/architecture-decisions/{id}/acknowledge",
		tags: ["Projects", "Architecture Decisions"],
		summary: "Acknowledge a decision you own",
	})
	.input(
		z.object({
			projectId: z.string(),
			id: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const canAccess = await hasProjectAccess(
			input.projectId,
			user.id,
			organizationId,
		);
		if (!canAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		const decision = await acknowledgeArchitectureDecision({
			id: input.id,
			projectId: input.projectId,
			ownerUserId: user.id,
		});
		if (!decision) {
			throw new ORPCError("FORBIDDEN", {
				message: "Only the decision's owner can acknowledge it",
			});
		}

		await emitActivity({
			projectId: input.projectId,
			userId: user.id,
			userName: user.name || user.email || "Anonymous",
			activityType: "architecture_decision_acknowledged",
			resourceType: "architecture_decision",
			resourceId: decision.id,
			resourceName: decision.identifier,
			timestamp: new Date().toISOString(),
		});

		return { decision };
	});

export const pinArchitectureDecisionProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.ARCHITECTURE_DECISION_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/architecture-decisions/{id}/pin",
		tags: ["Projects", "Architecture Decisions"],
		summary: "Pin or unpin an architecture decision",
	})
	.input(
		z.object({
			projectId: z.string(),
			id: z.string(),
			pinned: z.boolean(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const canAccess = await hasProjectAccess(
			input.projectId,
			user.id,
			organizationId,
		);
		if (!canAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}
		const decision = await setArchitectureDecisionPinned({
			id: input.id,
			projectId: input.projectId,
			pinned: input.pinned,
		});
		if (!decision) {
			throw new ORPCError("NOT_FOUND", {
				message: "Architecture decision not found",
			});
		}
		return { decision };
	});

export const vouchArchitectureDecisionProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.ARCHITECTURE_DECISION_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/architecture-decisions/{id}/vouch",
		tags: ["Projects", "Architecture Decisions"],
		summary: "Endorse (vouch) or un-endorse an architecture decision",
	})
	.input(
		z.object({
			projectId: z.string(),
			id: z.string(),
			vouched: z.boolean(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const canAccess = await hasProjectAccess(
			input.projectId,
			user.id,
			organizationId,
		);
		if (!canAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}
		const decision = await setArchitectureDecisionVouched({
			id: input.id,
			projectId: input.projectId,
			vouched: input.vouched,
			vouchedById: user.id,
		});
		if (!decision) {
			throw new ORPCError("NOT_FOUND", {
				message: "Architecture decision not found",
			});
		}
		// Re-embed so the AI context reflects the new endorsement state.
		await syncAndNotify(
			decision,
			user,
			organizationId,
			"architecture_decision_updated",
		);
		return { decision };
	});

/** Re-embed the AI context (AC5) and emit an activity event after a write. */
async function syncAndNotify(
	decision: {
		id: string;
		projectId: string;
		identifier: string;
		title: string;
		status: string;
		contextProblem: string;
		decision: string;
		rationale: string;
		decisionDrivers: string | null;
		alternativesConsidered: string | null;
		consequences: string | null;
		domain: string | null;
		participantsText: string | null;
		participantUserIds: string[];
		decisionDate: Date;
		contextId: string | null;
		supersededById: string | null;
		relatedDecisionIds: string[];
		vouchedAt: Date | null;
		vouchedById: string | null;
		sourceKind: string | null;
	},
	user: { id: string; name?: string | null; email?: string | null },
	organizationId: string | undefined,
	activityType: string,
): Promise<void> {
	const participantNames = await resolveParticipantNames(
		decision.participantUserIds,
	);
	const relations = await resolveRelationLines(decision);
	let vouchedByName: string | null = null;
	if (decision.vouchedAt && decision.vouchedById) {
		const voucher = await db.user.findFirst({
			where: { id: decision.vouchedById },
			select: { name: true, email: true },
		});
		vouchedByName = voucher?.name || voucher?.email || null;
	}
	const content = buildArchitectureDecisionContextContent({
		identifier: decision.identifier,
		title: decision.title,
		status: decision.status,
		domain: decision.domain,
		contextProblem: decision.contextProblem,
		decision: decision.decision,
		rationale: decision.rationale,
		decisionDrivers: decision.decisionDrivers,
		alternativesConsidered: decision.alternativesConsidered,
		consequences: decision.consequences,
		participantsText: decision.participantsText,
		participantNames,
		decisionDate: decision.decisionDate,
		vouched: decision.vouchedAt
			? { byName: vouchedByName, at: decision.vouchedAt }
			: null,
		sourceKind: decision.sourceKind,
		relations,
	});

	await syncArchitectureDecisionContext({
		decisionId: decision.id,
		projectId: decision.projectId,
		contextId: decision.contextId,
		content,
		sourceTitle: `${decision.identifier} ${decision.title}`,
		userId: user.id,
		organizationId,
	});

	await emitActivity({
		projectId: decision.projectId,
		userId: user.id,
		userName: user.name || user.email || "Anonymous",
		activityType,
		resourceType: "architecture_decision",
		resourceId: decision.id,
		resourceName: decision.title,
		timestamp: new Date().toISOString(),
	});
}

/** Resolve a decision's relationships into the named lines the AI block uses. */
async function resolveRelationLines(decision: {
	id: string;
	projectId: string;
	supersededById: string | null;
	relatedDecisionIds: string[];
}): Promise<DecisionRelationLine[]> {
	const lines: DecisionRelationLine[] = [];
	// What this decision supersedes (reverse lookup of supersededById).
	const supersedes = await listSupersededIdentifiers({
		projectId: decision.projectId,
		supersederId: decision.id,
	});
	for (const s of supersedes) {
		lines.push({ identifier: s.identifier, kind: "supersedes" });
	}
	// Resolve supersededBy + related ids → human identifiers.
	const refIds = [
		...(decision.supersededById ? [decision.supersededById] : []),
		...decision.relatedDecisionIds,
	];
	const idMap = await resolveArchitectureDecisionIdentifiers({
		projectId: decision.projectId,
		ids: refIds,
	});
	const supersededByIdentifier = decision.supersededById
		? idMap.get(decision.supersededById)
		: undefined;
	if (supersededByIdentifier) {
		lines.push({
			identifier: supersededByIdentifier,
			kind: "supersededBy",
		});
	}
	for (const id of decision.relatedDecisionIds) {
		const identifier = idMap.get(id);
		if (identifier) {
			lines.push({ identifier, kind: "related" });
		}
	}
	return lines;
}

/**
 * Apply a "this supersedes X, Y" relationship: flip each target to SUPERSEDED +
 * back-link to the superseder, then re-embed each target's AI context so the
 * model stops treating it as active. Best-effort; never blocks the write.
 */
async function applySupersedes(
	projectId: string,
	supersederId: string,
	supersedesIds: string[] | undefined,
	user: { id: string; name?: string | null; email?: string | null },
	organizationId: string | undefined,
): Promise<void> {
	if (!supersedesIds || supersedesIds.length === 0) {
		return;
	}
	const changed = await markArchitectureDecisionsSuperseded({
		projectId,
		targetIds: supersedesIds,
		supersederId,
	});
	for (const id of changed) {
		const target = await getArchitectureDecision({ id, projectId });
		if (target) {
			await syncAndNotify(
				target,
				user,
				organizationId,
				"architecture_decision_updated",
			);
		}
	}
}
