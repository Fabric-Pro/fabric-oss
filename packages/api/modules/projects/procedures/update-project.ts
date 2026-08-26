import { ORPCError } from "@orpc/client";
import {
	cleanupCodeSearchOnRepoUnlink,
	db,
	fieldMappingConfigSchema,
	moveWizardTempContextsToProject,
	Prisma,
	type ProjectDocumentType,
	seedTerminalStatusesIfEmpty,
	syncLegacyProjectRepoOnDisconnect,
	updateProject,
} from "@repo/database";
import {
	ClarifyingQuestionFrequencySchema,
	MaturationStatusSchema,
	ProjectStatusSchema,
	QaStrategyLevelSchema,
} from "@repo/database/prisma/zod";
import { hasPermission } from "@repo/permissions";
import { getTemporalClient } from "@repo/temporal";
import {
	MAX_ATTACHMENT_RETENTION_DAYS,
	MIN_ATTACHMENT_RETENTION_DAYS,
} from "@repo/utils/attachment";
import { isPmAttachmentSyncEnabled } from "@repo/utils/feature-flag";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../lib/audit";
import { resolveEffectiveProjectPermissions } from "../../../lib/effective-project-permissions";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import {
	cancelCodeIndexingForRepo,
	startCodeIndexingForProject,
} from "../lib/code-indexing-trigger";

export const updateProjectProcedure = tenantProtectedProcedure
	.use(
		requireProjectPermission(Permissions.PROJECT_UPDATE, {
			projectIdKey: "id",
		}),
	)
	.route({
		method: "PATCH",
		path: "/projects/:id",
		tags: ["Projects"],
		summary: "Update project",
		description: "Update a project",
	})
	.input(
		z.object({
			id: z.string(),
			organizationId: z.string().nullable().optional(),
			name: z.string().min(1).max(255).optional(),
			description: z.string().optional(),
			/**
			 * Which readiness checklist grades this project (Fizzy #2165).
			 *
			 * Settable here as well as at creation, because every project that
			 * predates readiness has no phase — without an update path they would
			 * stay unjudged forever, and the checklist's own "Project phase
			 * selected" row points at Project Settings.
			 *
			 * `null` is a real value, not "leave alone": it clears the phase and
			 * returns the project to unjudged.
			 */
			projectPhase: z
				.enum(["DISCOVERY_PLANNING", "DEVELOPMENT_EXECUTION"])
				.nullable()
				.optional(),
			/** Cleared automatically when the phase leaves Discovery. */
			expectedDevelopmentStartDate: z.coerce.date().nullable().optional(),
			goals: z.string().optional(),
			techStack: z.array(z.string()).optional(),
			features: z.array(z.string()).optional(),
			projectTypes: z.array(z.string()).optional(),
			status: ProjectStatusSchema.optional(),
			tags: z.array(z.string()).optional(),
			color: z.string().optional(),
			icon: z.string().optional(),
			// Project Management settings
			// mcpServerId identifies the server type; mcpConfigId pins the exact user config
			projectManagementMcpServerId: z.string().nullable().optional(),
			projectManagementMcpConfigId: z.string().nullable().optional(),
			projectManagementContainerId: z.string().nullable().optional(),
			projectManagementContainerName: z.string().nullable().optional(),
			projectManagementAdditionalContext: z.any().nullable().optional(),
			// Auto-push PM sync toggle
			autoPushPmSync: z.boolean().optional(),
			// Project-level Read-only mode — blocks outbound
			// writes to connected sources. Admin/owner only (checked in handler).
			readOnlyMode: z.boolean().optional(),
			// Per-project attachment-sync opt-in (Fizzy #1746)
			syncAttachments: z.boolean().optional(),
			// Attachment retention window in days (Fizzy #1749). null clears the
			// override so the project inherits its organization, then the server
			// default. Admin/owner only (checked in the handler).
			attachmentRetentionDays: z
				.number()
				.int()
				.min(MIN_ATTACHMENT_RETENTION_DAYS)
				.max(MAX_ATTACHMENT_RETENTION_DAYS)
				.nullable()
				.optional(),
			// AI Assistant clarifying-question frequency (admin-configurable)
			clarifyingQuestionFrequency:
				ClarifyingQuestionFrequencySchema.optional(),
			// QA Strategy depth level (admin-configurable, Fizzy #1535)
			qaStrategyLevel: QaStrategyLevelSchema.optional(),
			// QA test-case generation settings
			generateManualTestCases: z.boolean().optional(),
			applyTddApproach: z.boolean().optional(),
			// QA RCA→BUG opt-in: auto-open bugs for failing test cases
			autoCreateBugsFromFailures: z.boolean().optional(),
			// PM terminal-status auto-close (card #1360 Phase A)
			pmAutoCloseEnabled: z.boolean().optional(),
			// PM custom field read-mapping feature flag
			pmFieldMappingEnabled: z.boolean().optional(),
			pmTerminalStatuses: z
				.array(z.string().trim().min(1).max(100))
				.max(50)
				.optional(),
			// PRD Source settings
			prdSourceTitle: z.string().nullable().optional(),
			prdSourceUrl: z.string().nullable().optional(),
			// GitHub Repository settings (default for code tasks)
			repositoryUrl: z.string().nullable().optional(),
			repositoryOwner: z.string().nullable().optional(),
			repositoryName: z.string().nullable().optional(),
			defaultBranch: z.string().nullable().optional(),
			implementationDefaultChannel: z
				.enum(["BACKGROUND_AGENTS", "LOCAL_AGENTS"])
				.nullable()
				.optional(),
			implementationDefaultProvider: z
				.enum(["BACKGROUND_AGENTS", "KANBAN_LOCAL"])
				.nullable()
				.optional(),
			implementationDefaultWorkingDirectory: z
				.string()
				.nullable()
				.optional(),
			// Website URLs (project-level context for AI)
			primaryWebsiteUrl: z.string().nullable().optional(),
			additionalWebsiteUrls: z.array(z.string()).nullable().optional(),
			// Feature Maturation V2 — Project-level hidden stages configuration
			hiddenMaturationStatuses: z
				.array(z.enum(MaturationStatusSchema.options))
				.transform((val) => Array.from(new Set(val)))
				.refine(
					(val) => val.length < MaturationStatusSchema.options.length,
					{
						message: "At least one stage must remain visible.",
					},
				)
				.optional(),
			// Optional: wizard session ID for migrating temp contexts when editing project
			tempSessionId: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Authorization is enforced by `requireProjectPermission` above.

		// A few fields are stricter than the general PROJECT_UPDATE gate: only
		// project admins/owners (org admin/owner or project
		// OWNER/PROJECT_ADMIN — the PROJECT_SETTINGS_EDIT grant) may change
		// them. Field-level because the rest of this procedure stays editable
		// by regular members/editors. Resolved AT MOST ONCE — and only when at
		// least one such field is actually present in the input — so a PATCH
		// carrying more than one of these doesn't resolve permissions twice on
		// top of the resolution `requireProjectPermission` already did in
		// middleware.
		const ADMIN_ONLY_FIELD_MESSAGE: Partial<
			Record<keyof typeof input, string>
		> = {
			readOnlyMode:
				"Only project admins or owners can change Read-only mode.",
			// Enabling this starts pushing every story's attachments to the
			// linked PM tool (Fizzy #1746).
			syncAttachments:
				"Only project admins or owners can change attachment sync.",
			// Shortening this permanently deletes hidden attachments after a
			// 7-day grace period, with no restore surface (Fizzy #1749).
			attachmentRetentionDays:
				"Only project admins or owners can change the attachment retention period.",
		};
		const presentAdminOnlyFields = (
			Object.keys(ADMIN_ONLY_FIELD_MESSAGE) as Array<keyof typeof input>
		).filter((key) => input[key] !== undefined);
		if (presentAdminOnlyFields.length > 0) {
			const access = await resolveEffectiveProjectPermissions(
				input.id,
				user.id,
			);
			const canToggle =
				access?.source === "owner" ||
				(access != null &&
					hasPermission(
						access.permissions,
						Permissions.PROJECT_SETTINGS_EDIT,
					));
			if (!canToggle) {
				throw new ORPCError("FORBIDDEN", {
					message:
						ADMIN_ONLY_FIELD_MESSAGE[presentAdminOnlyFields[0]],
				});
			}
		}

		// The reconcile engine now reads `Project.syncAttachments` (the GitLab
		// push path in `reconcileStoryAttachments`), but only when the server
		// flag FABRIC_FEATURE_PM_ATTACHMENT_SYNC is on — see
		// isPmAttachmentSyncEnabled() below. While that flag is off, nothing
		// reads the column, so a `true` written through this endpoint — which
		// is routed and OpenAPI-tagged, reachable by any caller holding
		// PROJECT_SETTINGS_EDIT — would sit invisible and later be read as
		// standing consent to push a project's attachments once the flag (or
		// the settings toggle it also gates) is switched on. So the guard
		// below stays for exactly as long as the flag can be off: remove it
		// only when the flag itself is removed, not when the engine ships.
		//
		// Refuse only `true`. Clearing stays legal: `false` is the value every
		// project now holds after the reset migration, so a client PATCHing a
		// whole object round-tripped from `projects.get` keeps working, and
		// turning off something inert is never the request worth blocking. The
		// disconnect/archive path below forces `false` from outside the input
		// and is deliberately unaffected.
		//
		// Ordered AFTER the permission check so an unauthorized caller still
		// gets FORBIDDEN — the feature's availability is not a reason to skip
		// telling them they had no right to the field either way.
		// Narrowed to the case where the opt-in would actually be persisted. A
		// disconnect or archive in the same request already forces `false`
		// (`shouldDeactivatePoll` below), so rejecting there would fail the
		// disconnect over a value that was never going to be written.
		const wouldPersistOptIn =
			input.syncAttachments === true &&
			input.projectManagementMcpConfigId !== null &&
			input.status !== "ARCHIVED";
		if (wouldPersistOptIn && !isPmAttachmentSyncEnabled()) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Attachment sync is not available on this deployment. The setting cannot be enabled.",
			});
		}

		// Validate the field read-mapping config when the caller
		// includes a `fieldMapping` key in the PM additional-context blob. The
		// client sends the full merged context (preserving sibling keys), so we
		// only validate the sub-key's shape here — malformed → typed rejection.
		const additionalContext = input.projectManagementAdditionalContext;
		if (
			additionalContext &&
			typeof additionalContext === "object" &&
			!Array.isArray(additionalContext) &&
			"fieldMapping" in additionalContext &&
			(additionalContext as Record<string, unknown>).fieldMapping != null
		) {
			const parsed = fieldMappingConfigSchema.safeParse(
				(additionalContext as Record<string, unknown>).fieldMapping,
			);
			if (!parsed.success) {
				throw new ORPCError("BAD_REQUEST", {
					message: "Invalid field mapping configuration.",
				});
			}
			// Soft cap is client-enforced; log server-side if exceeded
			// so a runaway aggregation config is visible without hard-rejecting.
			const FIELD_MAPPING_SOFT_CAP = 15;
			if (parsed.data.fields.length > FIELD_MAPPING_SOFT_CAP) {
				console.warn(
					`[update-project] fieldMapping exceeds soft cap (${parsed.data.fields.length} > ${FIELD_MAPPING_SOFT_CAP}) for project ${input.id}`,
				);
			}
		}

		// Fetch current repo URL to detect link/unlink transitions, the current
		// terminal-status list to decide whether to force a re-snapshot, and the
		// stored retention window so a no-op save can be told from a real change.
		const existingProject = await db.project.findUnique({
			where: { id: input.id },
			select: {
				repositoryUrl: true,
				pmTerminalStatuses: true,
				attachmentRetentionDays: true,
			},
		});
		const previousRepoUrl = existingProject?.repositoryUrl ?? null;

		// If repo URL is being cleared, clean up code search artifacts first
		const repoChanged =
			previousRepoUrl &&
			input.repositoryUrl !== undefined &&
			input.repositoryUrl !== previousRepoUrl;
		const repoCleared = input.repositoryUrl === null && previousRepoUrl;

		if (repoCleared || repoChanged) {
			// The Phase 2 code index is per-repo; connected integrations own their
			// own rows and are torn down by the disconnect flow. Changing or
			// clearing the project's default `repositoryUrl` therefore only affects
			// the legacy null-integration row (a project that indexed via personal
			// OAuth without a ProjectRepositoryIntegration). Integration-backed
			// indexes are left intact, so switching the primary repo — or removing
			// one connected repo — never wipes another repo's index.

			// Step 1: Cancel the legacy row's in-flight indexing BEFORE cleanup.
			await cancelCodeIndexingForRepo({
				projectId: input.id,
				repositoryIntegrationId: null,
			});

			// Step 2: Delete DB rows (safe now — no in-flight upserts)
			const { deletedContextQdrantIds, organizationId: contextOrgId } =
				await cleanupCodeSearchOnRepoUnlink(input.id, previousRepoUrl, {
					preserveCodeSearchSetting: !!repoChanged,
				});

			// Step 3: Delete Qdrant vectors
			try {
				const client = await getTemporalClient();
				for (const ctx of deletedContextQdrantIds) {
					await client.workflow.start(
						"contextDeletionWorkflow" as any,
						withCorrelationMemo({
							taskQueue: "project-documents",
							workflowId: `ctx-delete-${ctx.id}`,
							args: [
								{
									contextId: ctx.id,
									projectId: input.id,
									userId: user.id,
									organizationId: contextOrgId ?? undefined,
									qdrantId: ctx.qdrantId,
								},
							],
						}),
					);
				}
			} catch (error) {
				console.error(
					"[update-project] Failed to start cleanup workflow:",
					error,
				);
			}

			try {
				const { deleteProjectCodeIndexVectors } = await import(
					"@repo/rag"
				);
				const { deleteProjectCodeIndex } = await import(
					"@repo/database"
				);
				// Scope to the legacy null-integration row only.
				await deleteProjectCodeIndexVectors(
					input.id,
					contextOrgId,
					null,
				);
				await deleteProjectCodeIndex(input.id, null);
			} catch (error) {
				console.error(
					"[update-project] Failed to delete code index vectors:",
					error,
				);
			}
		}

		// Deactivate ADO state polling when PM is disconnected or project is archived
		const shouldDeactivatePoll =
			input.projectManagementMcpConfigId === null ||
			input.status === "ARCHIVED";

		// Update project
		const project = await updateProject(
			input.id,
			user.id,
			{
				name: input.name,
				description: input.description,
				projectPhase: input.projectPhase,
				// Leaving Discovery makes the start date meaningless, so clear it
				// rather than leave a stale date behind the phase that used it.
				expectedDevelopmentStartDate:
					input.projectPhase === "DEVELOPMENT_EXECUTION"
						? null
						: input.expectedDevelopmentStartDate,
				goals: input.goals,
				techStack: input.techStack,
				features: input.features,
				projectTypes: input.projectTypes,
				status: input.status,
				tags: input.tags,
				color: input.color,
				icon: input.icon,
				projectManagementMcpServerId:
					input.projectManagementMcpServerId,
				projectManagementMcpConfigId:
					input.projectManagementMcpConfigId,
				projectManagementContainerId:
					input.projectManagementContainerId,
				projectManagementContainerName:
					input.projectManagementContainerName,
				projectManagementAdditionalContext:
					input.projectManagementAdditionalContext,
				prdSourceTitle: input.prdSourceTitle,
				prdSourceUrl: input.prdSourceUrl,
				repositoryUrl: input.repositoryUrl,
				repositoryOwner: input.repositoryOwner,
				repositoryName: input.repositoryName,
				defaultBranch: input.defaultBranch,
				implementationDefaultChannel:
					input.implementationDefaultChannel,
				implementationDefaultProvider:
					input.implementationDefaultProvider,
				implementationDefaultWorkingDirectory:
					input.implementationDefaultWorkingDirectory,
				primaryWebsiteUrl: input.primaryWebsiteUrl,
				additionalWebsiteUrls: input.additionalWebsiteUrls ?? undefined,
				// Drop wizard-only ephemera once the project is promoted to ACTIVE
				...(input.status === "ACTIVE"
					? { wizardState: Prisma.JsonNull }
					: {}),
				// Deactivate ADO state polling on disconnect or archive
				...(shouldDeactivatePoll ? { adoStatePollActive: false } : {}),
				// Auto-push PM sync toggle (pass through when provided)
				...(input.autoPushPmSync !== undefined
					? { autoPushPmSync: input.autoPushPmSync }
					: {}),
				// Read-only mode (Fizzy #2007, pass through when provided —
				// admin/owner enforcement happened above)
				...(input.readOnlyMode !== undefined
					? { readOnlyMode: input.readOnlyMode }
					: {}),
				// Attachment-sync opt-in (Fizzy #1746, pass through when provided).
				// A disconnect/archive (shouldDeactivatePoll) always wins over the
				// input value: the UI hides this toggle once no PM tool is
				// configured, so a flag left ON would have no affordance to clear,
				// and a later connect to a DIFFERENT PM tool must not inherit an
				// opt-in nobody made for it.
				...(shouldDeactivatePoll
					? { syncAttachments: false }
					: input.syncAttachments !== undefined
						? { syncAttachments: input.syncAttachments }
						: {}),
				// Attachment retention window (Fizzy #1749). The timestamp arms
				// the grace floor and is stamped ONLY on a real change: a no-op
				// save must not postpone every pending purge.
				//
				// The `?? null` is load-bearing beyond null-safety. `findUnique`
				// is nullable, so without it a missing row reads as `undefined`
				// and `null !== undefined` would stamp on a request that changed
				// nothing, needlessly re-arming the grace floor.
				...(input.attachmentRetentionDays !== undefined &&
				input.attachmentRetentionDays !==
					(existingProject?.attachmentRetentionDays ?? null)
					? {
							attachmentRetentionDays:
								input.attachmentRetentionDays,
							attachmentRetentionDaysUpdatedAt: new Date(),
						}
					: {}),
				// Clarifying-question frequency (pass through when provided)
				...(input.clarifyingQuestionFrequency !== undefined
					? {
							clarifyingQuestionFrequency:
								input.clarifyingQuestionFrequency,
						}
					: {}),
				// QA Strategy depth level (pass through when provided)
				...(input.qaStrategyLevel !== undefined
					? { qaStrategyLevel: input.qaStrategyLevel }
					: {}),
				// QA test-case generation settings — passed through when provided
				...(input.generateManualTestCases !== undefined
					? { generateManualTestCases: input.generateManualTestCases }
					: {}),
				...(input.applyTddApproach !== undefined
					? { applyTddApproach: input.applyTddApproach }
					: {}),
				...(input.autoCreateBugsFromFailures !== undefined
					? {
							autoCreateBugsFromFailures:
								input.autoCreateBugsFromFailures,
						}
					: {}),
				// Auto-close toggle (pass through when provided)
				...(input.pmAutoCloseEnabled !== undefined
					? { pmAutoCloseEnabled: input.pmAutoCloseEnabled }
					: {}),
				// PM field read-mapping flag
				...(input.pmFieldMappingEnabled !== undefined
					? { pmFieldMappingEnabled: input.pmFieldMappingEnabled }
					: {}),
				...(input.hiddenMaturationStatuses !== undefined
					? {
							hiddenMaturationStatuses:
								input.hiddenMaturationStatuses,
						}
					: {}),
				// Editing the terminal list forces a full re-snapshot on the next
				// poll (the poller skips tickets whose ChangedDate <= lastAdoStatePollAt),
				// so null the timestamp to trigger a backfill (spec D1) — but ONLY
				// when the normalized list actually changed. A no-op write (same set)
				// must not wipe the timestamp and re-scan every ticket.
				...(input.pmTerminalStatuses !== undefined
					? (() => {
							const normalize = (list: string[]) =>
								Array.from(
									new Set(
										list
											.map((s) => s.trim())
											.filter((s) => s.length > 0),
									),
								);
							const normalizedNext = normalize(
								input.pmTerminalStatuses,
							);
							const normalizedCurrent = normalize(
								existingProject?.pmTerminalStatuses ?? [],
							);
							const changed =
								normalizedNext.length !==
									normalizedCurrent.length ||
								normalizedNext.some(
									(s) => !normalizedCurrent.includes(s),
								);
							return {
								pmTerminalStatuses: normalizedNext,
								...(changed
									? { lastAdoStatePollAt: null }
									: {}),
							};
						})()
					: {}),
			},
			organizationId,
		);

		// Seed terminal statuses on first PM connect (best-effort, non-blocking).
		// A PM connection is identified by EITHER the pinned config id OR the
		// server-type id being set.
		if (
			input.projectManagementMcpConfigId ||
			input.projectManagementMcpServerId
		) {
			await seedTerminalStatusesIfEmpty(input.id);
		}

		// If legacy repo was cleared, promote the next active integration (if any)
		if (repoCleared && previousRepoUrl) {
			await syncLegacyProjectRepoOnDisconnect(input.id, previousRepoUrl);
		}

		// If tempSessionId provided, migrate temp contexts to project (for edit mode)
		let migratedContexts: {
			movedCount: number;
			contextIds: string[];
		} | null = null;

		if (input.tempSessionId) {
			try {
				const migrationResult = await moveWizardTempContextsToProject(
					input.tempSessionId,
					input.id,
					user.id,
					organizationId,
				);

				migratedContexts = {
					movedCount: migrationResult.movedCount,
					contextIds: migrationResult.contextIds,
				};

				// If contexts were migrated and have embeddings, bind them to the project
				if (
					migrationResult.movedCount > 0 &&
					Object.keys(migrationResult.contextIdMapping).length > 0
				) {
					try {
						const temporalClient = await getTemporalClient();

						// Start the binding workflow asynchronously (fire-and-forget)
						// Don't await completion to avoid blocking the API response
						await temporalClient.workflow.start(
							"wizardToProjectBindingWorkflow" as any,
							withCorrelationMemo({
								taskQueue: "project-documents",
								workflowId: `wizard-binding-${input.id}-${Date.now()}`,
								args: [
									{
										sessionId: migrationResult.sessionId,
										projectId: input.id,
										contextIdMapping:
											migrationResult.contextIdMapping,
										userId: user.id,
										organizationId,
									},
								],
							}),
						);
					} catch {
						// Don't fail project update if binding fails
						// The embeddings can still be queried by sessionId until binding completes
					}
				}

				// Create documents from tagged contexts after migration
				if (migrationResult.movedCount > 0) {
					try {
						const taggedContexts = await db.projectContext.findMany(
							{
								where: {
									id: { in: migrationResult.contextIds },
								},
								select: {
									id: true,
									content: true,
									metadata: true,
									originalFilename: true,
									extractionStatus: true,
								},
							},
						);

						for (const ctx of taggedContexts) {
							const metadata = ctx.metadata as Record<
								string,
								unknown
							> | null;
							const documentTag = metadata?.documentTag as
								| string
								| undefined;
							if (!documentTag) {
								continue;
							}

							// Skip contexts without content — still being extracted.
							// Temporal projectContextProcessingWorkflow will handle it.
							if (
								!ctx.content ||
								ctx.content.trim().length === 0
							) {
								continue;
							}

							const docType = documentTag as ProjectDocumentType;
							const title =
								(metadata?.documentTitle as string) ||
								ctx.originalFilename?.replace(
									/\.[^/.]+$/,
									"",
								) ||
								`${documentTag} Document`;

							const existingActive =
								await db.projectDocument.findFirst({
									where: {
										projectId: input.id,
										type: docType,
										isActive: true,
									},
								});

							const importedDoc = await db.projectDocument.create(
								{
									data: {
										projectId: input.id,
										type: docType,
										title,
										content: ctx.content,
										status: "COMPLETE",
										source: "IMPORTED",
										sourceContextId: ctx.id,
										isActive: !existingActive,
										wordCount: ctx.content
											.split(/\s+/)
											.filter((w: string) => w.length > 0)
											.length,
										version: 1,
										userId: user.id,
										organizationId: organizationId ?? null,
									},
								},
							);

							// Create initial document version for version history
							await db.documentVersion.create({
								data: {
									documentId: importedDoc.id,
									version: 1,
									content: ctx.content,
									changeDescription:
										"Imported from uploaded context",
									changedBy: user.id,
								},
							});
						}
					} catch (tagError) {
						console.error(
							"[UpdateProject] Failed to create documents from tagged contexts:",
							tagError,
						);
					}
				}
			} catch {
				// Don't fail project update if context migration fails
			}
		}

		// Auto-start code analysis when a repo is newly linked or changed
		const repoJustLinked =
			input.repositoryUrl &&
			input.repositoryOwner &&
			input.repositoryName &&
			(!previousRepoUrl || repoChanged);

		if (repoJustLinked && project.codeAnalysisStatus !== "SCANNING") {
			try {
				const { issueAIToken } = await import("@repo/ai-token");
				const aiToken = await issueAIToken({
					userId: user.id,
					organizationId,
					source: "auto-code-analysis",
					expirySeconds: 3600,
				});

				const client = await getTemporalClient();
				// Use existingProjectSetupWorkflow with empty selectedDocumentTypes
				// to run only code analysis (Phase 1) without generating documents
				await client.workflow.start(
					"existingProjectSetupWorkflow" as any,
					withCorrelationMemo({
						taskQueue: "project-documents",
						workflowId: `existing-setup-${input.id}-${Date.now()}`,
						args: [
							{
								projectId: input.id,
								userId: user.id,
								organizationId,
								aiToken,
								repoUrls: [input.repositoryUrl],
								selectedDocumentTypes: [],
								projectTypes:
									(project.projectTypes as string[]) || [],
								projectName: project.name,
							},
						],
						workflowExecutionTimeout: "45m",
					}),
				);
			} catch (error) {
				// Don't fail the update if auto-analysis fails
				console.error(
					"[update-project] Failed to auto-start code analysis:",
					error,
				);
			}

			// Auto-start Phase 2 code indexing for every connected repo. Gated by
			// FEATURE_CODE_INDEXING + the project's codeSearchEnabled setting
			// inside the helper, which starts one per-repo workflow.
			try {
				const result = await startCodeIndexingForProject({
					projectId: input.id,
					userId: user.id,
					organizationId,
				});
				if (result.started > 0) {
					console.log(
						`[update-project] Started code indexing for ${result.started} repo(s) in`,
						input.id,
					);
				} else if (result.skipped.length > 0) {
					console.warn(
						"[update-project] No credentials found for code indexing",
					);
				}
			} catch (error) {
				console.error(
					"[update-project] Failed to auto-start code indexing:",
					error,
				);
			}
		}

		// Audit-log emission. Archive flips status to ARCHIVED so
		// it gets its own action key per the spec. All other field changes —
		// including a normal status edit back to ACTIVE — emit `project.updated`.
		const isArchive = input.status === "ARCHIVED";
		const changedFields = Object.entries(input)
			.filter(
				([key, value]) =>
					value !== undefined &&
					key !== "id" &&
					key !== "organizationId" &&
					key !== "tempSessionId",
			)
			.map(([key]) => key);
		recordAuditFromRequest(context, {
			action: isArchive ? "project.archived" : "project.updated",
			category: "project",
			organizationId,
			projectId: project.id,
			resource: {
				type: "project",
				id: project.id,
				name: project.name,
			},
			metadata: {
				changedFields,
				...(isArchive ? { previousStatus: "ACTIVE" } : {}),
				...(input.hiddenMaturationStatuses !== undefined
					? {
							hiddenMaturationStatuses:
								input.hiddenMaturationStatuses,
						}
					: {}),
			},
		});

		return { project, migratedContexts };
	});
