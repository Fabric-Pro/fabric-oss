/**
 * Connect Repository Integration
 *
 * Creates a new project-level repository integration.
 * PROJECT_ADMIN+ (via PROJECT_SETTINGS_EDIT). Two auth methods:
 *  - OAUTH (GitHub / GitLab): this endpoint routes callers to the provider's
 *    OAuth start endpoint; credentials are stored on the callback.
 *  - PAT (Azure DevOps, GitHub, GitLab): accepts a token, validates it via the
 *    matching `@repo/connectors` request-path helper, then stores it encrypted.
 *    A scoped PAT is the reliable way to pull CI pipeline results from GitHub,
 *    since the GitHub App's OAuth token is Contents-scoped and can't read Actions.
 *
 * Saving a pasted GitHub token (credential manager on, ADR-026): with
 * `saveCredential`, the validated token is saved as the caller's private
 * `PAT` credential and the repository is bound to it by `credentialId`;
 * `encryptedPat` is not written. When the caller already saved a token for
 * the same GitHub account, nothing is written and the answer is
 * `{ existingCredential }`. The form then asks, and sends ONE more request:
 *  - "Use it": the same input with `credentialId` set to that credential (and
 *    no `pat`); the credential is resolved as the caller, probed against the
 *    repository and bound. `setCredential` cannot do this step because there
 *    is no integration to choose a credential for yet.
 *  - "Save as new": the same input with `saveCredential.saveAsNew: true`.
 * With the credential manager off, `saveCredential` is ignored and the token
 * is stored as before; `credentialId` is refused. GitHub only: GitLab's
 * `/user` needs a permission a least-privilege repository token lacks.
 *
 * Note: PAT validation uses the synchronous connectors helpers (request path) —
 * NOT the Temporal health-check activities. This keeps the handler thin per
 * `backend/api.md` ("no business logic in procedures").
 */

import { ORPCError } from "@orpc/client";
import {
	resolveDefaultBranch,
	validateAzureDevOpsPat,
	validateGitHubPat,
	validateGitLabPat,
} from "@repo/connectors";
import {
	createProjectRepoIntegration,
	db,
	isFeatureEnabled,
	logRepoIntegrationActivity,
	parseRepoUrl,
	syncLegacyProjectRepoOnConnect,
} from "@repo/database";
import { getGitHubWorkflowCredential } from "@repo/integrations/github";
import { decryptApiKey, encryptApiKey } from "@repo/utils";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { resolveCredentialActor } from "../../../credential-manager/lib/context";
import {
	saveCredentialInputSchema,
	savePastedGitHubToken,
	toPastedTokenCredential,
} from "../../../credential-manager/lib/pasted-token";
import { startCodeIndexingForProject } from "../../lib/code-indexing-trigger";
import {
	gitHubPatValidationMessage,
	gitLabPatValidationMessage,
	PAT_INVALID_REASON,
} from "./lib/pat-validation-errors";
import { resolveSavedCredentialForRepository } from "./lib/saved-credential";

/**
 * Maximum number of stored PAT candidates to evaluate sequentially
 * before failing, bounding interactive latency on the connect path.
 */
const MAX_CANDIDATE_CREDENTIALS = 5;

/**
 * The organization a credential-manager step runs in: the project's own,
 * which the permission middleware authorized, never the caller's input.
 */
async function projectOrganizationId(projectId: string): Promise<string> {
	const project = await db.project.findUnique({
		where: { id: projectId },
		select: { organizationId: true },
	});
	if (!project?.organizationId) {
		throw new ORPCError("NOT_FOUND", { message: "Project not found" });
	}
	return project.organizationId;
}

export const connectRepoIntegrationInputSchema = z.object({
	projectId: z.string(),
	organizationId: z.string().nullable().optional(),
	provider: z.enum(["GITHUB", "GITLAB", "AZURE_DEVOPS"]),
	authMethod: z.enum(["OAUTH", "PAT"]),
	// Bounded span: js/polynomial-redos — this value is stored and later
	// re-parsed by parseAdoRepositoryUrl's legacy-URL regex (update-branch);
	// no real repository URL is anywhere near this length.
	repositoryUrl: z.string().url().max(2048),
	repositoryOwner: z.string(),
	repositoryName: z.string(),
	defaultBranch: z.string().optional(),
	roleTag: z
		.string()
		.trim()
		.max(50)
		.regex(/^(?!.*---)[a-zA-Z0-9_\-./ ]+$/, {
			message:
				"Role tag can only contain letters, numbers, spaces, hyphens, underscores, dots, and slashes (and cannot contain '---')",
		})
		.nullable()
		.optional(),
	// For PAT-based auth. Azure DevOps also needs `azureOrganization`;
	// GitHub / GitLab need only `pat`.
	pat: z.string().optional(),
	azureOrganization: z.string().optional(),
	sourceIntegrationId: z.string().optional(),
	/**
	 * Save the pasted GitHub token in the credential manager and bind it
	 * (see the procedure doc). Ignored while the credential manager is off.
	 */
	saveCredential: saveCredentialInputSchema.optional(),
	/** Connect with this saved credential instead of a pasted token. */
	credentialId: z.string().min(1).optional(),
});

export const connectRepoIntegrationProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.route({
		method: "POST",
		path: "/projects/:projectId/repository-integrations",
		tags: ["Projects", "Repository Integrations"],
		summary: "Connect a repository integration to the project",
	})
	.input(connectRepoIntegrationInputSchema)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// A query string or fragment is refused outright, with a message
		// that says why, rather than falling through to the generic
		// "Cannot parse repository URL" below (which also refuses it, just
		// without naming the reason). Zod's `.url()` on the input schema
		// already guarantees this parses.
		const rawUrl = new URL(input.repositoryUrl);
		if (rawUrl.search !== "" || rawUrl.hash !== "") {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Repository URL must not include a query string or fragment",
			});
		}

		// Validate repo URL
		const parsed = parseRepoUrl(input.repositoryUrl);
		if (!parsed) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Cannot parse repository URL",
			});
		}

		// Use parsed values from the URL (not user-provided input) for consistency
		const provider = parsed.provider;
		const repositoryOwner = parsed.owner;
		const repositoryName = parsed.name;

		// For PAT-based auth, validate the PAT before storing (or reuse stored PAT for GITHUB)
		if (input.authMethod === "PAT") {
			let patToUse = input.pat;
			let encryptedPat = input.pat ? encryptApiKey(input.pat) : null;
			let validatedAgainstRepo = false;
			let boundCredentialId: string | undefined;

			if (input.credentialId) {
				if (provider !== "GITHUB") {
					throw new ORPCError("BAD_REQUEST", {
						message:
							"Only GitHub repositories can be connected with a saved token here.",
					});
				}
				// Refuses while the credential manager is off.
				const actor = await resolveCredentialActor(
					await projectOrganizationId(input.projectId),
					user.id,
				);
				const resolved = await resolveSavedCredentialForRepository({
					credentialId: input.credentialId,
					actor,
					provider,
					repositoryUrl: parsed.url,
					owner: repositoryOwner,
					repo: repositoryName,
				});
				patToUse = resolved.token;
				encryptedPat = null;
				validatedAgainstRepo = true;
				boundCredentialId = input.credentialId;
			} else if (!patToUse || !patToUse.trim()) {
				// If pat is empty or whitespace-only:
				// - If explicitly provided (e.g. "" or "   ") or provider is not GITHUB, reject immediately.
				// - If pat was omitted (undefined) and provider is GITHUB, resolve and reuse stored active project PATs.
				if (provider !== "GITHUB" || input.pat !== undefined) {
					throw new ORPCError("BAD_REQUEST", {
						message: "PAT is required for PAT authentication",
					});
				}

				const candidates =
					await db.projectRepositoryIntegration.findMany({
						where: {
							projectId: input.projectId,
							provider: "GITHUB",
							authMethod: "PAT",
							status: "ACTIVE",
							encryptedPat: { not: null },
						},
						select: {
							id: true,
							encryptedPat: true,
						},
						orderBy: { createdAt: "desc" },
					});

				// If sourceIntegrationId is provided, check that candidate first.
				const fullCandidates = input.sourceIntegrationId
					? [
							...candidates.filter(
								(c) => c.id === input.sourceIntegrationId,
							),
							...candidates.filter(
								(c) => c.id !== input.sourceIntegrationId,
							),
						]
					: candidates;

				if (fullCandidates.length > MAX_CANDIDATE_CREDENTIALS) {
					console.warn(
						`[connect] Project ${input.projectId} has ${fullCandidates.length} candidate PAT credentials; capping evaluation at ${MAX_CANDIDATE_CREDENTIALS}.`,
					);
				}
				const sortedCandidates = fullCandidates.slice(
					0,
					MAX_CANDIDATE_CREDENTIALS,
				);

				// Find a stored candidate PAT that can access this specific repository
				let lastStatus: number | undefined;
				for (const candidate of sortedCandidates) {
					if (!candidate.encryptedPat) {
						continue;
					}

					let decrypted: string;
					try {
						decrypted = decryptApiKey(candidate.encryptedPat);
					} catch {
						// Corrupt ciphertext or invalid key version — try next candidate
						continue;
					}

					try {
						const validation = await validateGitHubPat({
							pat: decrypted,
							owner: repositoryOwner,
							repo: repositoryName,
						});
						if (validation.ok) {
							patToUse = decrypted;
							encryptedPat = candidate.encryptedPat;
							validatedAgainstRepo = true;
							break;
						}
						// Record failure status, preserving server outage status (>= 500) if encountered
						if (
							validation.status &&
							(validation.status >= 500 || !lastStatus)
						) {
							lastStatus = validation.status;
						}
					} catch (err) {
						// Rethrow network/transient fetch errors so they aren't masked as credential rejections
						if (
							err instanceof TypeError ||
							(err as { name?: string })?.name === "FetchError"
						) {
							throw err;
						}
					}
				}

				// Fall back to the caller's own stored workflow credential. When the
				// picker listed this repository from a personal PAT, that token is the
				// one proven to see it; sending the caller through an App
				// authorization flow instead stores a credential that cannot read what
				// was just browsed, and asking them to paste the token again is the
				// friction this whole path exists to remove.
				let personalPatAvailable = false;
				if (!patToUse || !encryptedPat) {
					const workflowCredential =
						await getGitHubWorkflowCredential(
							user.id,
							organizationId ?? undefined,
						);
					if (workflowCredential?.kind === "pat") {
						personalPatAvailable = true;
						try {
							const validation = await validateGitHubPat({
								pat: workflowCredential.token,
								owner: repositoryOwner,
								repo: repositoryName,
							});
							if (validation.ok) {
								patToUse = workflowCredential.token;
								encryptedPat = encryptApiKey(
									workflowCredential.token,
								);
								validatedAgainstRepo = true;
							} else if (
								validation.status &&
								(validation.status >= 500 || !lastStatus)
							) {
								lastStatus = validation.status;
							}
						} catch (err) {
							// Same rule as the stored-candidate loop: a transport
							// failure is not a credential rejection.
							if (
								err instanceof TypeError ||
								(err as { name?: string })?.name ===
									"FetchError"
							) {
								throw err;
							}
						}
					}
				}

				if (!patToUse || !encryptedPat) {
					if (lastStatus && lastStatus >= 500) {
						// Deliberately NOT tagged with PAT_INVALID_REASON. The picker
						// treats that tag as "this credential is unusable, go sign in",
						// and a sign-in popup is the wrong remedy for a provider
						// outage — it would store an App credential that cannot read
						// the repository. Surface the outage instead.
						throw new ORPCError("BAD_REQUEST", {
							message: `GitHub returned status ${lastStatus}`,
						});
					}
					throw new ORPCError("BAD_REQUEST", {
						message:
							candidates.length > 0 || personalPatAvailable
								? "Invalid PAT or insufficient permissions"
								: "No stored GitHub token found for this project",
						data: { reason: PAT_INVALID_REASON },
					});
				}
			}

			// Validate the PAT against the provider before storing. Each check is
			// delegated to a `@repo/connectors` request-path helper. Error mapping:
			// 401/403 (plus 404 for GitHub, which returns 404 for repos the token
			// cannot access) → invalid-PAT/insufficient permissions, other non-OK →
			// `{provider} returned status N`. Azure DevOps additionally needs the org;
			// GitHub and GitLab validate repository read permissions for the specific
			// target repo (the GitHub App's OAuth token is Contents-scoped and can't
			// read Actions, so a scoped PAT is the reliable way to pull CI pipeline
			// results).
			if (provider === "AZURE_DEVOPS") {
				if (!input.azureOrganization) {
					throw new ORPCError("BAD_REQUEST", {
						message:
							"Azure organization is required for Azure DevOps PAT",
					});
				}
				const validation = await validateAzureDevOpsPat({
					organization: input.azureOrganization,
					pat: patToUse,
				});
				if (!validation.ok) {
					throw new ORPCError("BAD_REQUEST", {
						message:
							validation.status === 401 ||
							validation.status === 403
								? "Invalid PAT or insufficient permissions"
								: `Azure DevOps returned status ${validation.status}`,
					});
				}
			} else if (provider === "GITHUB") {
				if (!validatedAgainstRepo) {
					const validation = await validateGitHubPat({
						pat: patToUse,
						owner: repositoryOwner,
						repo: repositoryName,
					});
					if (!validation.ok) {
						// Shared with the attach-PAT path so both tell one story per
						// status: 401 is the credential itself, 403 authenticated but
						// lacks the grant, and GitHub also answers 404 for a private
						// repo the token cannot see.
						throw new ORPCError("BAD_REQUEST", {
							message: gitHubPatValidationMessage(
								validation.status,
							),
							data: { reason: PAT_INVALID_REASON },
						});
					}
				}
			} else {
				// GITLAB — gitlab.com only. `parseRepoUrl` recognises GitLab by a
				// `gitlab.com` SUBSTRING, so a crafted URL like
				// `https://<internal-host>/gitlab.com/a/b` would classify as GitLab
				// while its real host is attacker-controlled. Pin the API host to
				// gitlab.com and REJECT any other host, so neither this validation
				// fetch nor the later branch/pipeline fetches (which read the stored
				// repositoryUrl) can be pointed at an internal host (SSRF).
				let hostname: string;
				try {
					hostname = new URL(parsed.url).hostname.toLowerCase();
				} catch {
					throw new ORPCError("BAD_REQUEST", {
						message: "Invalid GitLab repository URL",
					});
				}
				if (hostname !== "gitlab.com") {
					throw new ORPCError("BAD_REQUEST", {
						message:
							"Only gitlab.com repositories are supported for GitLab connections",
					});
				}
				const validation = await validateGitLabPat({
					pat: patToUse,
					host: "https://gitlab.com",
					projectPath: `${repositoryOwner}/${repositoryName}`,
				});
				if (!validation.ok) {
					throw new ORPCError("BAD_REQUEST", {
						message: gitLabPatValidationMessage(validation.status),
					});
				}
			}

			const resolvedBranch = await resolveDefaultBranch({
				providedBranch: input.defaultBranch,
				provider,
				token: patToUse,
				repositoryUrl: parsed.url,
				owner: repositoryOwner,
				repo: repositoryName,
				azureOrganization: input.azureOrganization,
				// GitLab PATs authenticate with PRIVATE-TOKEN, not Bearer.
				...(provider === "GITLAB"
					? { gitlabAuth: "private-token" as const }
					: {}),
			});

			const normalizedRoleTag = input.roleTag?.trim() || null;
			if (normalizedRoleTag) {
				const duplicate =
					await db.projectRepositoryIntegration.findFirst({
						where: {
							projectId: input.projectId,
							roleTag: {
								equals: normalizedRoleTag,
								mode: "insensitive",
							},
						},
						select: {
							id: true,
							repositoryOwner: true,
							repositoryName: true,
						},
					});
				if (duplicate) {
					throw new ORPCError("CONFLICT", {
						message: `The role tag "${normalizedRoleTag}" is already assigned to ${duplicate.repositoryOwner}/${duplicate.repositoryName}`,
					});
				}
			}

			// A pasted GitHub token, to be saved in the credential manager.
			let savedCredential:
				| ReturnType<typeof toPastedTokenCredential>
				| undefined;
			if (
				!boundCredentialId &&
				input.saveCredential &&
				provider === "GITHUB" &&
				input.pat?.trim()
			) {
				const credentialOrganizationId = await projectOrganizationId(
					input.projectId,
				);
				if (
					await isFeatureEnabled(
						"CREDENTIAL_MANAGER",
						credentialOrganizationId,
					)
				) {
					const actor = await resolveCredentialActor(
						credentialOrganizationId,
						user.id,
					);
					// Refuse a repository already connected before saving
					// anything, so a refused connect leaves no credential.
					const alreadyConnected =
						await db.projectRepositoryIntegration.findFirst({
							where: {
								projectId: input.projectId,
								provider,
								repositoryOwner,
								repositoryName,
							},
							select: { id: true },
						});
					if (alreadyConnected) {
						throw new ORPCError("CONFLICT", {
							message:
								"Repository is already connected to this project",
						});
					}
					const saved = await savePastedGitHubToken({
						actor,
						user,
						token: patToUse,
						label: input.saveCredential.label,
						saveAsNew: input.saveCredential.saveAsNew,
						confirmFineGrainedPermissions:
							input.saveCredential.confirmFineGrainedPermissions,
					});
					if (saved.outcome === "existing") {
						// Nothing written: the form asks whether to use it.
						return {
							existingCredential: toPastedTokenCredential(
								saved.credential,
							),
						};
					}
					boundCredentialId = saved.credential.id;
					savedCredential = toPastedTokenCredential(saved.credential);
					encryptedPat = null;
				}
			}

			let integration: Awaited<
				ReturnType<typeof createProjectRepoIntegration>
			>;
			try {
				integration = await createProjectRepoIntegration({
					projectId: input.projectId,
					provider,
					authMethod: input.authMethod,
					repositoryUrl: parsed.url,
					repositoryOwner,
					repositoryName,
					defaultBranch: resolvedBranch,
					roleTag: normalizedRoleTag,
					encryptedPat: encryptedPat ?? undefined,
					credentialId: boundCredentialId,
					azureOrganization: input.azureOrganization,
					configuredByUserId: user.id,
				});
			} catch (err: any) {
				if (err?.code === "P2002") {
					throw new ORPCError("CONFLICT", {
						message:
							"Repository is already connected to this project",
					});
				}
				throw err;
			}

			await syncLegacyProjectRepoOnConnect(
				input.projectId,
				parsed.url,
				repositoryOwner,
				repositoryName,
				resolvedBranch,
			);

			// Best-effort: kick off code indexing for the newly connected repo
			// (no-op unless the project's code search mode is RAG).
			await startCodeIndexingForProject({
				projectId: input.projectId,
				userId: user.id,
				organizationId,
				repositoryIntegrationId: integration.id,
			}).catch((error) => {
				console.error(
					"[connect] Failed to auto-start code indexing:",
					error,
				);
			});

			await logRepoIntegrationActivity({
				projectId: input.projectId,
				userId: user.id,
				userName: user.name || "Unknown",
				organizationId,
				activityType: "repo_integration_configured",
				integrationId: integration.id,
				repositoryName: `${repositoryOwner}/${repositoryName}`,
				metadata: {
					provider,
					authMethod: input.authMethod,
					...(boundCredentialId ? { source: "saved" } : {}),
				},
			});

			// Audit-log emission. Org-level integration event —
			// the resource is the repo integration, not the project. We tag
			// `projectId` so the project viewer still surfaces it.
			recordAuditFromRequest(context, {
				action: "org.integration.connected",
				category: "org",
				organizationId,
				projectId: input.projectId,
				resource: {
					type: "repository_integration",
					id: integration.id,
					name: `${repositoryOwner}/${repositoryName}`,
				},
				metadata: {
					provider,
					authMethod: input.authMethod,
					...(boundCredentialId ? { source: "saved" } : {}),
				},
			});

			return {
				integration: { id: integration.id },
				success: true,
				...(savedCredential ? { savedCredential } : {}),
			};
		}

		// authMethod === "OAUTH": OAuth credentials are stored during the
		// provider-specific OAuth callback, not via this procedure. Route callers
		// to the correct OAuth start endpoint. (PAT for any provider is handled above.)
		throw new ORPCError("BAD_REQUEST", {
			message:
				"For GitLab or GitHub OAuth, call integrations.gitlab.start (or integrations.github.start) with targetType: 'project' and projectId. This endpoint handles PAT-based integrations.",
		});
	});
