import { ORPCError } from "@orpc/client";
import {
	createProject,
	db,
	moveWizardTempContextsToProject,
	Prisma,
	type ProjectDocumentType,
	seedTerminalStatusesIfEmpty,
} from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../lib/audit";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";
import { resolvePmTarget } from "../lib/resolve-pm-target";

export const createProjectProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.PROJECT_CREATE))
	.route({
		method: "POST",
		path: "/projects",
		tags: ["Projects"],
		summary: "Create project",
		description: "Create a new project",
	})
	.input(
		z.object({
			name: z.string().min(1).max(255),
			description: z.string().optional(),
			/**
			 * Which readiness checklist the project is graded against (Fizzy #2165).
			 *
			 * Optional here on purpose. The creation wizard requires it, but this
			 * route also serves the public API, the v1 API, the CLI and an agent
			 * tool — making it mandatory would break every existing client. A
			 * project created without one is simply *unjudged*: readiness asks the
			 * user to pick a phase rather than grading them against a default.
			 */
			projectPhase: z
				.enum(["DISCOVERY_PLANNING", "DEVELOPMENT_EXECUTION"])
				.optional(),
			/** Only meaningful for Discovery projects; must not be in the past. */
			expectedDevelopmentStartDate: z.coerce.date().optional(),
			goals: z.string().optional(),
			techStack: z.array(z.string()).optional(),
			features: z.array(z.string()).optional(),
			projectTypes: z.array(z.string()).optional(),
			organizationId: z.string().nullable().optional(),
			tags: z.array(z.string()).optional(),
			color: z.string().optional(),
			icon: z.string().optional(),
			// Optional: wizard session ID for migrating temp contexts
			tempSessionId: z.string().optional(),
			// Optional: GitHub repository fields for code-based setup
			repositoryUrl: z.string().optional(),
			repositoryOwner: z.string().optional(),
			repositoryName: z.string().optional(),
			defaultBranch: z.string().optional(),
			// Optional: PM integration for "existing project" flow
			projectManagementMcpServerId: z.string().nullable().optional(),
			projectManagementMcpConfigId: z.string().nullable().optional(),
			projectManagementContainerId: z.string().nullable().optional(),
			projectManagementContainerName: z.string().nullable().optional(),
			projectManagementAdditionalContext: z
				.record(z.string(), z.unknown())
				.nullable()
				.optional(),
			// Website URLs (project-level context for AI)
			primaryWebsiteUrl: z
				.union([z.string().url(), z.literal("")])
				.optional(),
			additionalWebsiteUrls: z
				.array(z.union([z.string().url(), z.literal("")]))
				.optional(),
			// Skip automatic story sync on creation (used when existingProjectSetupWorkflow handles backlog ingest)
			skipAutoSync: z.boolean().optional(),
			// Optional: client-generated UUID to find and activate an existing DRAFT instead of creating a duplicate
			draftKey: z.string().uuid().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		try {
			const user = context.user;
			const organizationId = resolveOrganizationId(
				input.organizationId,
				context.session,
			);

			// Verify organization membership if in org context
			if (organizationId) {
				const membership = await verifyOrganizationMembership(
					organizationId,
					user.id,
				);

				if (!membership) {
					throw new ORPCError("FORBIDDEN", {
						message: "You are not a member of this organization",
					});
				}
			}

			// Check for duplicate project name within the same tenant context.
			// In org context: check all projects in the org (any owner).
			// In personal context: check only this user's personal projects.
			const tenantFilter = organizationId
				? { organizationId }
				: { organizationId: null, userId: user.id };

			const duplicate = await db.project.findFirst({
				where: {
					...tenantFilter,
					name: { equals: input.name.trim(), mode: "insensitive" },
					status: { not: "DRAFT" },
					deletedAt: null,
				},
				select: { id: true },
			});

			if (duplicate) {
				throw new ORPCError("CONFLICT", {
					message: `A project named "${input.name.trim()}" already exists`,
				});
			}

			// If a draftKey was provided, try to find and activate an existing DRAFT
			let project: Awaited<ReturnType<typeof createProject>> | null =
				null;
			if (input.draftKey) {
				const existingDraft = await db.project.findFirst({
					where: {
						draftKey: input.draftKey,
						userId: user.id,
						organizationId: organizationId ?? null,
						status: "DRAFT",
						deletedAt: null,
					},
				});
				if (existingDraft) {
					project = await db.project.update({
						where: { id: existingDraft.id },
						data: {
							name: input.name,
							description: input.description,
							projectPhase: input.projectPhase,
							expectedDevelopmentStartDate:
								input.expectedDevelopmentStartDate,
							goals: input.goals,
							techStack: input.techStack || [],
							features: input.features || [],
							projectTypes: input.projectTypes || [],
							tags: input.tags || [],
							color: input.color,
							icon: input.icon,
							repositoryUrl: input.repositoryUrl,
							repositoryOwner: input.repositoryOwner,
							repositoryName: input.repositoryName,
							defaultBranch: input.defaultBranch,
							projectManagementMcpServerId:
								input.projectManagementMcpServerId ?? undefined,
							projectManagementMcpConfigId:
								input.projectManagementMcpConfigId ?? undefined,
							projectManagementContainerId:
								input.projectManagementContainerId ?? undefined,
							projectManagementContainerName:
								input.projectManagementContainerName ??
								undefined,
							projectManagementAdditionalContext:
								input.projectManagementAdditionalContext ===
								null
									? Prisma.JsonNull
									: (input.projectManagementAdditionalContext as Prisma.InputJsonValue),
							primaryWebsiteUrl:
								input.primaryWebsiteUrl?.trim() || undefined,
							additionalWebsiteUrls:
								input.additionalWebsiteUrls?.filter((u) =>
									u?.trim(),
								),
							status: "ACTIVE",
							// Drop wizard-only ephemera now that the draft is being promoted
							wizardState: Prisma.JsonNull,
						},
					});
				}
			}

			// No draft to activate — create a fresh project as ACTIVE
			if (!project) {
				project = await createProject({
					name: input.name,
					description: input.description,
					projectPhase: input.projectPhase,
					expectedDevelopmentStartDate:
						input.expectedDevelopmentStartDate,
					goals: input.goals,
					techStack: input.techStack,
					features: input.features,
					projectTypes: input.projectTypes,
					userId: user.id,
					organizationId,
					tags: input.tags,
					color: input.color,
					icon: input.icon,
					repositoryUrl: input.repositoryUrl,
					repositoryOwner: input.repositoryOwner,
					repositoryName: input.repositoryName,
					defaultBranch: input.defaultBranch,
					projectManagementMcpServerId:
						input.projectManagementMcpServerId ?? undefined,
					projectManagementMcpConfigId:
						input.projectManagementMcpConfigId ?? undefined,
					projectManagementContainerId:
						input.projectManagementContainerId ?? undefined,
					projectManagementContainerName:
						input.projectManagementContainerName ?? undefined,
					projectManagementAdditionalContext:
						input.projectManagementAdditionalContext as
							| Prisma.InputJsonValue
							| null
							| undefined,
					primaryWebsiteUrl:
						input.primaryWebsiteUrl?.trim() || undefined,
					additionalWebsiteUrls: input.additionalWebsiteUrls?.filter(
						(u) => u?.trim(),
					),
					status: "ACTIVE",
				});
			}

			if (!project) {
				throw new ORPCError("INTERNAL_SERVER_ERROR", {
					message: "Failed to create project",
				});
			}

			// Seed terminal statuses on PM connect (best-effort, non-blocking).
			// A PM connection is identified by EITHER the pinned config id OR the
			// server-type id being set.
			if (
				input.projectManagementMcpConfigId ||
				input.projectManagementMcpServerId
			) {
				await seedTerminalStatusesIfEmpty(project.id);
			}

			// Create documents from onboarding artifacts (PRD, Architecture, Technical Specs)
			// when provided in projectManagementAdditionalContext (Existing Project flow)
			const additionalContext =
				input.projectManagementAdditionalContext as
					| Record<string, unknown>
					| null
					| undefined;
			if (additionalContext && typeof additionalContext === "object") {
				const docSpecs: Array<{
					type: ProjectDocumentType;
					contentKey: string;
					title: string;
				}> = [
					{
						type: "PRD",
						contentKey: "prdContent",
						title: "Product Requirements Document",
					},
					{
						type: "ARCHITECTURE",
						contentKey: "archContent",
						title: "Architecture",
					},
					{
						type: "TECHNICAL_SPEC",
						contentKey: "specsContent",
						title: "Technical Specs",
					},
				];

				for (const spec of docSpecs) {
					const content = additionalContext[spec.contentKey];
					if (typeof content !== "string" || !content.trim()) {
						continue;
					}

					try {
						// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching null bytes to sanitize content
						const sanitized = content.replace(/\u0000/g, "");
						const existingActive =
							await db.projectDocument.findFirst({
								where: {
									projectId: project.id,
									type: spec.type,
									isActive: true,
								},
							});

						const doc = await db.projectDocument.create({
							data: {
								projectId: project.id,
								type: spec.type,
								title: spec.title,
								content: sanitized,
								status: "COMPLETE",
								source: "IMPORTED",
								isActive: !existingActive,
								wordCount: sanitized
									.split(/\s+/)
									.filter((w) => w.length > 0).length,
								version: 1,
								userId: user.id,
								organizationId: organizationId ?? null,
							},
						});

						await db.documentVersion.create({
							data: {
								documentId: doc.id,
								version: 1,
								content: sanitized,
								changeDescription: "Imported from onboarding",
								changedBy: user.id,
								userId: user.id,
								organizationId: organizationId ?? null,
							},
						});
					} catch (docError) {
						console.error(
							`[CreateProject] Failed to create ${spec.type} document:`,
							docError,
						);
					}
				}
			}

			// If tempSessionId provided, migrate temp contexts to project
			let migratedContexts: {
				movedCount: number;
				contextIds: string[];
				contextIdMapping?: Record<string, string>;
				sessionId?: string;
			} | null = null;

			if (input.tempSessionId) {
				try {
					const migrationResult =
						await moveWizardTempContextsToProject(
							input.tempSessionId,
							project.id,
							user.id,
							organizationId,
						);

					migratedContexts = {
						movedCount: migrationResult.movedCount,
						contextIds: migrationResult.contextIds,
						contextIdMapping: migrationResult.contextIdMapping,
						sessionId: migrationResult.sessionId,
					};

					// If contexts were migrated and have embeddings, bind them to the project
					if (
						migrationResult.movedCount > 0 &&
						Object.keys(migrationResult.contextIdMapping).length > 0
					) {
						try {
							const temporalClient = await getTemporalClient();

							await temporalClient.workflow.execute(
								"wizardToProjectBindingWorkflow" as any,
								withCorrelationMemo({
									taskQueue: "project-documents",
									workflowId: `wizard-binding-${project.id}-${Date.now()}`,
									args: [
										{
											sessionId:
												migrationResult.sessionId,
											projectId: project.id,
											contextIdMapping:
												migrationResult.contextIdMapping,
											userId: user.id,
											organizationId,
										},
									],
								}),
							);

							console.log(
								`[CreateProject] Triggered embedding binding for ${migrationResult.movedCount} contexts to project ${project.id}`,
							);
						} catch (bindingError) {
							console.error(
								"[CreateProject] Failed to trigger embedding binding:",
								bindingError,
							);
						}
					}

					// Create documents from tagged contexts after migration
					// Note: Don't filter by extractionStatus — extraction may still
					// be in progress. Check for content + documentTag in the loop.
					if (migrationResult.movedCount > 0) {
						try {
							const taggedContexts =
								await db.projectContext.findMany({
									where: {
										id: {
											in: migrationResult.contextIds,
										},
									},
									select: {
										id: true,
										content: true,
										metadata: true,
										originalFilename: true,
										extractionStatus: true,
									},
								});

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

								// Skip contexts without content — they're still being extracted.
								// The Temporal projectContextProcessingWorkflow will create
								// the document after extraction completes (it reads documentTag
								// from metadata).
								if (
									!ctx.content ||
									ctx.content.trim().length === 0
								) {
									console.log(
										`[CreateProject] Skipping document creation for context ${ctx.id} — extraction ${ctx.extractionStatus}, content empty. Temporal workflow will handle it.`,
									);
									continue;
								}

								const docType =
									documentTag as ProjectDocumentType;
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
											projectId: project.id,
											type: docType,
											isActive: true,
										},
									});

								const importedDoc =
									await db.projectDocument.create({
										data: {
											projectId: project.id,
											type: docType,
											title,
											content: ctx.content,
											status: "COMPLETE",
											source: "IMPORTED",
											sourceContextId: ctx.id,
											isActive: !existingActive,
											wordCount: ctx.content
												.split(/\s+/)
												.filter(
													(w: string) => w.length > 0,
												).length,
											version: 1,
											userId: user.id,
											organizationId:
												organizationId ?? null,
										},
									});

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

								console.log(
									`[CreateProject] Created imported document from tagged context: ${ctx.id} (${documentTag})`,
								);
							}
						} catch (tagError) {
							console.error(
								"[CreateProject] Failed to create documents from tagged contexts:",
								tagError,
							);
						}
					}
				} catch (error) {
					// Log but don't fail project creation if context migration fails
					console.error(
						"Failed to migrate wizard temp contexts:",
						error,
					);
				}
			}

			// Auto-sync tasks from PM tool when project has PM integration (existing project flow)
			// Skip when existingProjectSetupWorkflow will handle backlog ingest instead
			let storySyncStarted = false;
			if (
				!input.skipAutoSync &&
				project.projectManagementMcpServerId &&
				project.projectManagementContainerId
			) {
				try {
					const target = await resolvePmTarget({
						project: {
							projectManagementMcpServerId:
								project.projectManagementMcpServerId,
							projectManagementMcpConfigId:
								project.projectManagementMcpConfigId,
							organizationId: project.organizationId,
						},
						userId: user.id,
						organizationId: project.organizationId,
					});

					if (target) {
						const temporalClient = await getTemporalClient();
						const workflowId = `story-sync-${project.id}-${Date.now()}`;

						await temporalClient.workflow.start(
							"storySyncWorkflow",
							withCorrelationMemo({
								taskQueue: "ai-chat",
								workflowId,
								args: [
									{
										projectId: project.id,
										mcpServerId:
											project.projectManagementMcpServerId,
										mcpConfigId:
											target.kind === "mcp"
												? target.mcpConfigId
												: null,
										containerId:
											project.projectManagementContainerId,
										containerName:
											project.projectManagementContainerName ??
											undefined,
										additionalContext:
											(project.projectManagementAdditionalContext as Record<
												string,
												string
											> | null) ?? undefined,
										userId: user.id,
										organizationId:
											project.organizationId ?? undefined,
										direction: "pull",
										enableTypeMapping:
											process.env
												.FEATURE_PM_TYPE_MAPPING ===
											"true",
									},
								],
							}),
						);

						storySyncStarted = true;
						console.log(
							`[CreateProject] Started auto-sync for project ${project.id} (workflow: ${workflowId}, target: ${target.kind})`,
						);
					}
				} catch (syncError) {
					console.error(
						"[CreateProject] Failed to start task sync:",
						syncError,
					);
				}
			}

			// Audit-log emission. Fire-and-forget; never blocks the
			// create. Project status distinguishes wizard drafts (DRAFT) from
			// real projects (ACTIVE), which matters for forensic queries.
			recordAuditFromRequest(context, {
				action: "project.created",
				category: "project",
				organizationId,
				projectId: project.id,
				resource: {
					type: "project",
					id: project.id,
					name: project.name,
				},
				metadata: {
					status: project.status,
					hasRepo: Boolean(project.repositoryUrl),
					hasPmIntegration: Boolean(
						project.projectManagementMcpConfigId,
					),
				},
			});

			return {
				project,
				storySyncStarted,
				migratedContexts: migratedContexts
					? {
							movedCount: migratedContexts.movedCount,
							contextIds: migratedContexts.contextIds,
						}
					: null,
			};
		} catch (error) {
			// Log the error for debugging with full context
			console.error("[CreateProject] Error creating project:", {
				error,
				errorMessage:
					error instanceof Error ? error.message : String(error),
				errorStack: error instanceof Error ? error.stack : undefined,
				userId: context.user.id,
				organizationId: input.organizationId,
				projectName: input.name,
			});

			// If it's already an ORPCError, re-throw it
			if (error instanceof ORPCError) {
				throw error;
			}

			// Otherwise, avoid leaking internal error details to clients.
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to create project",
			});
		}
	});
