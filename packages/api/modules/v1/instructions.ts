/**
 * v1 Coding-instructions routes
 *
 *   GET  /projects/:projectId/instructions/published            manifest + delta
 *   POST /projects/:projectId/instructions/published/download   signed zip URL
 *   POST /projects/:projectId/instructions/changes              propose a change, for review
 *   POST /projects/:projectId/instructions/versions             publish a change directly
 *   GET  /projects/:projectId/instructions/proposals/:snapshotId/pull-request
 *                                                               a repository proposal's pull request
 *
 * These exist so `@fabricorg/cli` can keep a working tree current
 * (`fabric instructions check | sync | init | push`). The oRPC twins under
 * `modules/projects/procedures/instructions/` are `tenantProtectedProcedure`
 * — Better Auth session cookie only — so no API key can reach them, and the
 * MCP gateway's `fabric_get_project_instruction_bundle` needs an MCP client
 * the CLI does not have. The SEMANTICS here mirror that gateway tool
 * (`apps/web/modules/saas/mcp/lib/gateway/platform-tools.ts`): same
 * `sinceDigest` bound, same delta query, same short-circuit on an equal
 * digest, same shared zip builder — two surfaces must not be able to answer
 * differently about the same snapshot.
 */
import {
	db,
	getInstructionManifestDiff,
	getPublishedInstructionSnapshot,
	listInstructionFiles,
	resolveCurrentInstructionSource,
	resolveInstructionSnapshotSource,
} from "@repo/database";
import { hasPermission, Permissions } from "@repo/permissions";
import type { Context, Hono, Next } from "hono";
import { resolveEffectiveProjectPermissions } from "../../lib/effective-project-permissions";
import { requireScope } from "../external-api/middleware/api-key-auth";
import type {
	ExternalApiContext,
	ExternalApiVariables,
} from "../external-api/types";
import { buildInstructionSnapshotZip } from "../projects/procedures/instructions/build-zip";
// Type-only: the implementation is imported lazily in the handler below, so
// registering these routes does not pull the Temporal client and the storage
// provider into the module graph of every request that never writes.
import type {
	InlineInstructionChange,
	InstructionChangeMode,
} from "../projects/procedures/instructions/submit-change";
import { badRequest, forbidden, notFound, ok } from "./helpers";

/** The longest `sinceDigest` accepted, mirroring the MCP tools' input schemas. */
const INSTRUCTION_DIGEST_MAX_LENGTH = 128;

/** How long the signed archive URL stays valid — `buildInstructionSnapshotZip`'s own `expiresIn`. */
const DOWNLOAD_URL_EXPIRES_IN_SECONDS = 600;

type ResolvedProject =
	| { error: { message: string }; status: 400 | 403 | 404 }
	| { userId: string; organizationId: string };

/**
 * The object-level gate, run after `requireScope("instructions:read")` and
 * never instead of it (AGENTS.md: every API-key surface checks the key's
 * declared scope AND the creator's live permission, wildcard keys included).
 *
 * ## The project supplies the tenant, not the request
 *
 * This route does NOT go through `resolveV1Context`, and that is the whole
 * point rather than an omission. Every coding-instructions surface is
 * project-scoped, so the only organization any of them may act in is the
 * project's own — the oRPC twin resolves exactly that with
 * `requireHostingOrganizationId`, and the MCP gateway's
 * `resolvePublishedInstructionSnapshot` compares against the project's
 * hosting organization and says so in as many words: "so invited guests keep
 * access and cross-org IDs fail as 404".
 *
 * `resolveV1Context` answers a different question — which organization does
 * THIS CALLER belong to — and it refuses a caller who belongs to none of
 * them. An invited project guest holds an accepted `ProjectMember` row and
 * no membership in the host organization, so they pass the browser and the
 * MCP gateway and were refused here, for a project they can open in the app.
 *
 * ## What each key type still has to prove
 *
 * - ANY key: `resolveEffectiveProjectPermissions` — the SAME resolver
 *   `requireProjectPermission(Permissions.INSTRUCTION_READ)` runs for the
 *   oRPC twin (`orpc/middleware/require-permission.ts` →
 *   `assertProjectPermission`) — must grant `INSTRUCTION_READ`. That is what
 *   keeps this API neither broader nor narrower than the tab, and it is
 *   deliberately not `getProjectAccessById`, which matches only the owner or
 *   a `ProjectMember` row and would refuse an organization admin the browser
 *   admits.
 * - An ORGANIZATION key stays bound to its own organization: the project's
 *   hosting organization must equal the key's. An org key is minted for one
 *   tenant and must never read another's project, guest grant or not.
 * - A PERSONAL key is bound by the project access above and nothing else,
 *   which is precisely the browser's rule for the same person.
 *
 * A project whose hosting organization does not match an organization key is
 * NOT FOUND, never forbidden: a caller must not learn from this that a
 * project id exists in someone else's tenant. A personal project resolves
 * `organizationId: null`, which no organization id can equal — the
 * fail-closed arm, and the only answer an organization-only surface may give
 * it.
 *
 * ## An explicit context still binds
 *
 * `?org=<slug>` and `?personal=1` are the request's own statement of which
 * tenant it means. Taking the project's word for the organization is what
 * keeps an invited guest working; ignoring an explicit context that
 * CONTRADICTS it would make this route answer a question nobody asked. So a
 * named organization is resolved and must equal the project's — 404
 * otherwise, the same answer an organization key gets for someone else's
 * project — and `?personal=1` is refused outright, because this surface has
 * no personal arm to select.
 *
 * The slug is resolved WITHOUT a membership check on purpose. Membership is
 * what `resolveV1Context` requires and exactly what shuts an invited guest
 * out; here the slug is only ever used to compare against an organization the
 * caller has already proven project access to — which is why that lookup
 * happens only after the permission check, and why an unknown slug and a
 * mismatched one get the same generic 404.
 *
 * Unlike `resolveV1Context`, `?personal=1` is a refusal rather than an
 * accepted no-op. That no-op exists to keep clients already in the field
 * working through a tenancy change; this surface shipped after it, so there
 * are none, and a coding-instructions request naming a personal context is a
 * mistake worth reporting.
 */
async function resolveInstructionProject(
	projectId: string,
	apiCtx: ExternalApiContext,
	requested: { org?: string; personal: boolean },
): Promise<ResolvedProject> {
	if (requested.personal) {
		return {
			error: {
				message:
					"Coding instructions are an organization surface; ?personal=1 is not supported",
			},
			status: 403,
		};
	}

	const access = await resolveEffectiveProjectPermissions(
		projectId,
		apiCtx.userId,
	);
	// A caller with no tie to the project at all — not its owner, no active
	// ProjectMember row, not a member of its host organization — is answered
	// as a missing project is, in the same words. An organization key already
	// got that from the hosting-organization comparison below; a PERSONAL key
	// skips that comparison, and without this it reached the permission check
	// and heard 403, which told it the project exists (Fizzy #2639). Same
	// rule as `assertProjectPermission` on the oRPC twin.
	if (!access || access.source === "none") {
		return { error: notFound("Project").error, status: 404 };
	}

	const hostingOrganizationId = access.organizationId;
	if (!hostingOrganizationId) {
		return {
			error: {
				message: "Coding instructions require an organization project",
			},
			status: 403,
		};
	}

	if (
		apiCtx.keyType === "organization" &&
		apiCtx.organizationId !== hostingOrganizationId
	) {
		return { error: notFound("Project").error, status: 404 };
	}

	// A personal-project owner passes `assertProjectPermission`
	// unconditionally; that arm is unreachable here because the null host org
	// above has already refused every personal project.
	//
	// This runs BEFORE the explicit-context lookup below, and the order is the
	// point: an unscoped organization lookup reachable by a caller with no
	// permission on the project turns `?org=` into an oracle — vary the slug
	// and the different refusals distinguish a slug that does not exist, one
	// that does, and the project's own. Nothing answers an arbitrary slug
	// until the caller has proven they may read this project.
	if (!hasPermission(access.permissions, Permissions.INSTRUCTION_READ)) {
		return {
			error: forbidden(
				"No coding-instructions read permission for this project",
			).error,
			status: 403,
		};
	}

	if (requested.org) {
		const named = await db.organization.findFirst({
			where: { slug: requested.org },
			select: { id: true },
		});
		// One answer for "no such slug" and "not this project's slug" alike.
		// Telling them apart would say whether an organization exists to a
		// caller who has no standing to ask. Covers an organization key naming
		// someone else's slug too: its own organization is already the
		// project's by the check above, so any other slug resolves to an id
		// this cannot equal.
		if (!named || named.id !== hostingOrganizationId) {
			return { error: notFound("Project").error, status: 404 };
		}
	}

	return { userId: apiCtx.userId, organizationId: hostingOrganizationId };
}

/**
 * A published snapshot that has passed every integrity check below. The
 * `digest` is non-null by construction: READY is the transition that writes
 * it, and a READY row without one is refused here rather than served.
 */
type ReadyPublishedSnapshot = Omit<
	NonNullable<Awaited<ReturnType<typeof getPublishedInstructionSnapshot>>>,
	"digest"
> & { digest: string };

/**
 * The published snapshot, or `null` when there is nothing a caller may be
 * shown. Mirrors `resolvePublishedInstructionSnapshot` in the gateway: the
 * published pointer lives on the `Project` row and the query behind it is
 * UNSCOPED, so every integrity condition is checked here, and a failure is
 * reported identically to "nothing published".
 */
async function resolvePublishedSnapshot(
	projectId: string,
	organizationId: string,
): Promise<ReadyPublishedSnapshot | null> {
	const snapshot = await getPublishedInstructionSnapshot(projectId);
	if (
		!snapshot ||
		snapshot.status !== "READY" ||
		snapshot.digest === null ||
		snapshot.projectId !== projectId ||
		snapshot.organizationId !== organizationId
	) {
		return null;
	}
	return snapshot as ReadyPublishedSnapshot;
}

/**
 * `buildInstructionSnapshotZip` is shared with the oRPC surface and signals
 * through `ORPCError`. Exactly one of its refusals is reachable from here —
 * the snapshot was deleted while the archive was being built — and it is a
 * 404 on this surface, not a 500. Everything else propagates.
 */
function isOrpcNotFound(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "NOT_FOUND"
	);
}

/**
 * The HTTP status and the machine-readable reason code for one of
 * `submitInstructionChange`'s refusals.
 *
 * The shared function signals with `ORPCError`, because its other two callers
 * are an oRPC-shaped surface and the MCP gateway. Translating here keeps this
 * file's existing error style — `{ error: { message, code } }` plus a status —
 * and gives the CLI something to branch on without parsing prose:
 * `PULL_FIRST` means sync and try again, `REPOSITORY_SOURCE_OF_TRUTH` means the
 * project's instructions live in git, and the two proposal-cap codes mean wait
 * for a decision.
 *
 * The field is `code` and not `reason` because that is the one the SDK already
 * reads off an error body and hands back as `FabricError.code`
 * (`packages/sdk/src/client.ts`). A second name would be a field every client
 * has to be taught about separately.
 *
 * `BASE_NOT_PUBLISHED` is re-labelled `PULL_FIRST` on the way out: that is the
 * spec's name for it (§6.12) and the one a command-line client reads, while
 * the tab's copy speaks about reloading a page there is none of here.
 */
function submitChangeFailure(error: unknown): {
	status: 400 | 403 | 404 | 409 | 412 | 422;
	message: string;
	code?: string;
	field?: string;
} | null {
	if (typeof error !== "object" || error === null || !("code" in error)) {
		return null;
	}
	const orpc = error as {
		code?: unknown;
		message?: unknown;
		data?: { reason?: unknown; field?: unknown };
	};
	const message =
		typeof orpc.message === "string" ? orpc.message : "Request refused";
	const rawReason =
		typeof orpc.data?.reason === "string" ? orpc.data.reason : undefined;
	const code = rawReason === "BASE_NOT_PUBLISHED" ? "PULL_FIRST" : rawReason;
	switch (orpc.code) {
		// A note the admission refuses (Fizzy #2563 spec §5.3): `field` names
		// which of title or body, never its content. It travels as
		// `error.data.field`, the structured half the SDK already hands back
		// as `FabricError.data`.
		case "UNPROCESSABLE_CONTENT":
			return {
				status: 422,
				message,
				code,
				...(typeof orpc.data?.field === "string"
					? { field: orpc.data.field }
					: {}),
			};
		case "BAD_REQUEST":
			return { status: 400, message, code };
		case "FORBIDDEN":
			return { status: 403, message, code };
		case "NOT_FOUND":
			return { status: 404, message, code };
		case "CONFLICT":
			return { status: 409, message, code };
		case "PRECONDITION_FAILED":
			return { status: 412, message, code };
		default:
			return null;
	}
}

/** The longest `baseSnapshotId` this route will carry into a query. */
const SNAPSHOT_ID_MAX_LENGTH = 128;

/**
 * The request body, shaped, or the refusal for one that is not.
 *
 * Validated here rather than left to the shared function because this is the
 * boundary where untyped JSON arrives: `submitInstructionChange` takes a typed
 * change list and enforces the SEMANTIC bounds (path rules, per-file and total
 * size, the 50-change cap), and neither should be duplicated. What this adds is
 * only the shape.
 */
function readChangeBody(body: unknown):
	| {
			baseSnapshotId: string;
			changes: InlineInstructionChange[];
			note?: { title?: string; body?: string };
	  }
	| { error: string } {
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		return { error: "Body must be a JSON object." };
	}
	const raw = body as Record<string, unknown>;

	// REQUIRED, and the message says where to get it. Defaulting it to the
	// currently published snapshot — which is what this used to do when it
	// was absent — turns the stale-base check off for anyone who leaves it
	// out, and leaves them no way to find out they are overwriting a version
	// they never read.
	if (
		typeof raw.baseSnapshotId !== "string" ||
		raw.baseSnapshotId.length === 0 ||
		raw.baseSnapshotId.length > SNAPSHOT_ID_MAX_LENGTH
	) {
		return {
			error: `baseSnapshotId is required: the id of the published snapshot this change is based on, as GET /projects/{projectId}/instructions/published returns it. It must be a string of 1 to ${SNAPSHOT_ID_MAX_LENGTH} characters.`,
		};
	}
	const baseSnapshotId = raw.baseSnapshotId;

	if (!Array.isArray(raw.changes)) {
		return { error: "changes must be an array." };
	}
	const changes: InlineInstructionChange[] = [];
	for (const entry of raw.changes) {
		if (typeof entry !== "object" || entry === null) {
			return { error: "Each change must be an object." };
		}
		const change = entry as Record<string, unknown>;
		if (typeof change.path !== "string" || change.path.length === 0) {
			return { error: "Each change needs a non-empty path." };
		}
		if (change.op === "delete") {
			changes.push({ op: "delete", path: change.path });
			continue;
		}
		if (change.op !== "put") {
			return { error: 'Each change needs op "put" or "delete".' };
		}
		if (typeof change.content !== "string") {
			return {
				error: `A put needs a string content: ${change.path}`,
			};
		}
		const encoding = change.encoding ?? "utf8";
		if (encoding !== "utf8" && encoding !== "base64") {
			return {
				error: `encoding must be "utf8" or "base64": ${change.path}`,
			};
		}
		changes.push({
			op: "put",
			path: change.path,
			content: change.content,
			encoding,
		});
	}

	// Optional (Fizzy #2563 spec §12): the proposal's title and description,
	// for both destinations. Only the SHAPE is checked here; the length,
	// line and credential rules are the admission's, which answer 422
	// NOTE_REJECTED naming the field. `null` means none, as absent does.
	if (raw.note === undefined || raw.note === null) {
		return { baseSnapshotId, changes };
	}
	if (typeof raw.note !== "object" || Array.isArray(raw.note)) {
		return {
			error: "note must be an object with an optional string title and body.",
		};
	}
	const note = raw.note as Record<string, unknown>;
	for (const field of ["title", "body"] as const) {
		if (note[field] !== undefined && typeof note[field] !== "string") {
			return { error: `note.${field} must be a string.` };
		}
	}
	return {
		baseSnapshotId,
		changes,
		note: {
			...(typeof note.title === "string" ? { title: note.title } : {}),
			...(typeof note.body === "string" ? { body: note.body } : {}),
		},
	};
}

export function registerInstructionRoutes(
	app: Hono<{ Variables: ExternalApiVariables }>,
) {
	/**
	 * GET /projects/:projectId/instructions/published
	 *
	 * `?sinceDigest=<hex>` turns this into a delta: an equal digest answers
	 * `unchanged` BEFORE any file row is read, which is the whole point — a
	 * session-start hook asking "did anything move?" costs one query and no
	 * manifest. A base digest this project never published (or one the
	 * retention sweep has pruned) answers `changes: null`, meaning "take a
	 * full copy"; the manifest is still there.
	 */
	app.get(
		"/projects/:projectId/instructions/published",
		requireScope("instructions:read"),
		async (c) => {
			// Query validation FIRST: it costs nothing and needs nothing, so
			// an overlong digest must not be able to spend a project lookup
			// and a permission resolution before being refused.
			const sinceDigest = c.req.query("sinceDigest");
			if (
				sinceDigest !== undefined &&
				(sinceDigest.length === 0 ||
					sinceDigest.length > INSTRUCTION_DIGEST_MAX_LENGTH)
			) {
				return c.json(
					badRequest(
						`sinceDigest must be a string of 1 to ${INSTRUCTION_DIGEST_MAX_LENGTH} characters.`,
					),
					400,
				);
			}

			const apiCtx = c.get("externalApiContext");
			const projectId = c.req.param("projectId")!;
			const resolved = await resolveInstructionProject(
				projectId,
				apiCtx,
				{
					org: c.req.query("org"),
					personal: c.req.query("personal") === "1",
				},
			);
			if ("error" in resolved) {
				return c.json({ error: resolved.error }, resolved.status);
			}

			// `sourceOfTruth` and `repository` come from ONE read of the
			// project's settings, in both branches (Fizzy #2708 review): read
			// separately, a switch landing between the two reads answered
			// `UPLOAD` beside a repository block, and a CLI that classifies a
			// checkout against that block would act on a contradiction.
			// (The settings column stores nothing until someone sets it; absent
			// reads as UPLOAD, as the tab reads it.)
			const snapshot = await resolvePublishedSnapshot(
				projectId,
				resolved.organizationId,
			);
			if (!snapshot) {
				const { sourceOfTruth, repository } =
					await resolveCurrentInstructionSource(
						projectId,
						resolved.organizationId,
					);
				return c.json(
					ok({ published: false, sourceOfTruth, repository }),
				);
			}

			const { sourceOfTruth, source, repository } =
				await resolveInstructionSnapshotSource(
					projectId,
					resolved.organizationId,
					snapshot,
				);
			const summary = {
				id: snapshot.id,
				version: snapshot.version,
				digest: snapshot.digest,
				fileCount: snapshot.fileCount,
				publishedAt: snapshot.publishedAt?.toISOString() ?? null,
				source,
			};

			if (sinceDigest !== undefined && sinceDigest === snapshot.digest) {
				return c.json(
					ok({
						published: true,
						sourceOfTruth,
						repository,
						snapshot: summary,
						unchanged: true,
						changes: { added: [], removed: [], changed: [] },
					}),
				);
			}

			// Scoped by project AND by the hosting organization already
			// compared against this caller's access, so a digest belonging to
			// another project — or a row mis-tagged with another tenant — is
			// simply an unknown base rather than a window into it.
			const changes =
				sinceDigest === undefined
					? undefined
					: await getInstructionManifestDiff({
							projectId,
							organizationId: resolved.organizationId,
							baseDigest: sinceDigest,
							headSnapshotId: snapshot.id,
						}).then((diff) =>
							diff
								? {
										added: diff.added,
										removed: diff.removed,
										changed: diff.changed,
									}
								: null,
						);

			const files = await listInstructionFiles(
				snapshot.id,
				resolved.organizationId,
			);

			return c.json(
				ok({
					published: true,
					sourceOfTruth,
					repository,
					snapshot: summary,
					...(sinceDigest === undefined
						? {}
						: { unchanged: false, changes }),
					manifest: files.map((f) => ({
						path: f.path,
						sha256: f.sha256,
						size: f.size,
						mode: f.mode,
						kind: f.kind,
					})),
				}),
			);
		},
	);

	/**
	 * POST /projects/:projectId/instructions/published/download
	 *
	 * POST because it materialises an export object. Idempotent by digest:
	 * `buildInstructionSnapshotZip` keys the archive on the snapshot's digest
	 * and reuses an object that is already there, so the SDK's automatic
	 * `Idempotency-Key` retry costs nothing and creates nothing twice.
	 */
	app.post(
		"/projects/:projectId/instructions/published/download",
		requireScope("instructions:read"),
		async (c) => {
			const apiCtx = c.get("externalApiContext");
			const projectId = c.req.param("projectId")!;
			const resolved = await resolveInstructionProject(
				projectId,
				apiCtx,
				{
					org: c.req.query("org"),
					personal: c.req.query("personal") === "1",
				},
			);
			if ("error" in resolved) {
				return c.json({ error: resolved.error }, resolved.status);
			}

			const snapshot = await resolvePublishedSnapshot(
				projectId,
				resolved.organizationId,
			);
			if (!snapshot) {
				return c.json(notFound("Published snapshot"), 404);
			}

			const files = await listInstructionFiles(
				snapshot.id,
				resolved.organizationId,
			);
			let url: string;
			try {
				({ url } = await buildInstructionSnapshotZip({
					projectId,
					organizationId: resolved.organizationId,
					snapshot,
					files,
				}));
			} catch (error) {
				if (isOrpcNotFound(error)) {
					return c.json(notFound("Published snapshot"), 404);
				}
				throw error;
			}

			return c.json(
				ok({
					snapshotId: snapshot.id,
					digest: snapshot.digest,
					url,
					expiresInSeconds: DOWNLOAD_URL_EXPIRES_IN_SECONDS,
				}),
			);
		},
	);

	/**
	 * The body of both write routes, which differ ONLY in the mode they ask
	 * for and the scope that let the request in.
	 *
	 * Shared rather than copied because every line below is a boundary rule —
	 * the shape check, the tenant resolution, the audit actor, the refusal
	 * mapping — and two copies of a boundary drift into two boundaries. What
	 * must NOT be shared is the authority: `mode` is a parameter of this
	 * function and a constant at each registration, never read from the
	 * request, so no body can turn a proposal into a publish.
	 *
	 * TWO gates, as every key-backed surface here owes (AGENTS.md): the key's
	 * declared scope, checked by `requireScope` at the route, and the
	 * creator's live permission on the project, checked inside
	 * `submitInstructionChange` — `INSTRUCTION_READ` to propose,
	 * `INSTRUCTION_CREATE` to publish, exactly what the tab requires of the
	 * same person for the same action. The two refusals stay distinguishable:
	 * a missing scope is `{ error: "Missing required scope: …" }` from the
	 * middleware, a missing permission is `{ error: { message } }` from here.
	 *
	 * `baseSnapshotId` is required in both modes, because it is the whole of
	 * the stale-base protection: see `readChangeBody`. A base that is no
	 * longer the published version is `PULL_FIRST` before anything is written,
	 * for a publish as much as for a proposal — a publish is a fast-forward
	 * claim on the published pointer, not a merge.
	 *
	 * The tenant comes from `resolveInstructionProject`, the same resolution
	 * the two read routes use and for the same reason: the PROJECT decides
	 * which organization this acts in, which keeps an invited guest — who is a
	 * member of no organization here — able to reach a project they can open
	 * in the app. No `organizationId` is read from the request on any path.
	 */
	const handleChangeSubmission =
		(mode: InstructionChangeMode) =>
		async (c: Context<{ Variables: ExternalApiVariables }>) => {
			const apiCtx = c.get("externalApiContext");
			const projectId = c.req.param("projectId")!;

			let rawBody: unknown;
			try {
				rawBody = await c.req.json();
			} catch {
				return c.json(badRequest("Invalid JSON body"), 400);
			}
			const body = readChangeBody(rawBody);
			if ("error" in body) {
				return c.json(badRequest(body.error), 400);
			}

			const resolved = await resolveInstructionProject(
				projectId,
				apiCtx,
				{
					org: c.req.query("org"),
					personal: c.req.query("personal") === "1",
				},
			);
			if ("error" in resolved) {
				return c.json({ error: resolved.error }, resolved.status);
			}

			// The audit row snapshots the actor's email and name, and this
			// surface has no session to read them from. One indexed point
			// lookup, on a write path that is already doing far more than one
			// query, beats an audit row whose actor is an id and nothing else.
			const actor = await db.user.findUnique({
				where: { id: resolved.userId },
				select: { email: true, name: true },
			});

			const { submitInstructionChange } = await import(
				"../projects/procedures/instructions/submit-change"
			);
			try {
				const result = await submitInstructionChange({
					userId: resolved.userId,
					projectId,
					baseSnapshotId: body.baseSnapshotId,
					changes: body.changes,
					...(body.note ? { note: body.note } : {}),
					// The route's own constant, closed over above. Nothing
					// from the request reaches this field.
					mode,
					// No HTTP request headers are threaded through this
					// surface, so ip / user-agent / request-id resolve to null
					// rather than being invented. The actor is the key's
					// resolved user, which is who the permission checks ran
					// for.
					audit: {
						user: {
							id: resolved.userId,
							email: actor?.email ?? "",
							name: actor?.name ?? null,
						},
					},
					via: `v1:${apiCtx.keyType}-key`,
				});
				return c.json(ok(result));
			} catch (error) {
				const failure = submitChangeFailure(error);
				if (!failure) {
					throw error;
				}
				return c.json(
					{
						error: {
							message: failure.message,
							...(failure.code ? { code: failure.code } : {}),
							...(failure.field
								? { data: { field: failure.field } }
								: {}),
						},
					},
					failure.status,
				);
			}
		};

	/**
	 * POST /projects/:projectId/instructions/changes
	 *
	 * The reviewed write, and the reason `instructions:write` exists: `fabric
	 * instructions push` sends the diff between a checkout and the snapshot
	 * its lock names, with the changed files' bytes inline, and gets back a
	 * proposal an editor reviews in the tab.
	 *
	 * Proposal-only, and the body has no say in it. A key holding
	 * `instructions:write` cannot publish here whatever its creator's
	 * permissions are, which is what lets that scope be offered to read-only
	 * roles and described as review-gated without the description being a
	 * half-truth. Publishing is the sibling route below, behind a scope this
	 * key does not carry.
	 */
	app.post(
		"/projects/:projectId/instructions/changes",
		requireScope("instructions:write"),
		handleChangeSubmission("proposal"),
	);

	/**
	 * The publish route's own third gate, run after
	 * `requireScope("instructions:publish")` and before the body is even
	 * parsed.
	 *
	 * The scope check alone is not enough here, and it is the one write route
	 * where that is true. `hasScope` (`external-api/middleware/api-key-auth.ts`)
	 * accepts a wildcard `*` scope on ANY key type, so a legacy personal
	 * `fab_*` key that predates this feature — and was never granted
	 * `instructions:publish` by name — satisfies `requireScope` purely by
	 * holding `*`. Past that gate it would resolve like every other personal
	 * key: bound only by its owner's own project access, with no organization
	 * boundary to cross, because `resolveInstructionProject` only enforces the
	 * hosting-organization match when `keyType === "organization"`. The design
	 * for this route is that publishing needs a key an ORGANIZATION
	 * deliberately minted with this scope (`ORG_API_KEY_SCOPES`, off the
	 * viewer ceiling); a personal key can never be that key, whatever it
	 * carries.
	 *
	 * Run before `resolveInstructionProject` or `readChangeBody` so a personal
	 * key never reaches tenant resolution or `submitInstructionChange` for
	 * this route at all — the same before-any-lookup posture
	 * `?personal=1` gets on every route here.
	 *
	 * The refusal is `forbidden()`'s `{ error: { message } }` shape, the same
	 * nested envelope `submitInstructionChange`'s live-permission refusal
	 * produces — there being no third JSON shape among this file's helpers to
	 * reach for — but the MESSAGE cannot be mistaken for that one: this says
	 * outright that the key's TYPE is wrong, never that its creator lacks a
	 * permission on the project. It also reads differently from the
	 * middleware's flat `{ error: "Missing required scope: …" }` a scope
	 * refusal gives, which a wildcard key never triggers in the first place —
	 * that is exactly the gap this closes.
	 */
	async function requireOrganizationKeyForPublish(
		c: Context<{ Variables: ExternalApiVariables }>,
		next: Next,
	) {
		const apiCtx = c.get("externalApiContext");
		if (apiCtx.keyType !== "organization") {
			return c.json(
				forbidden(
					"Publishing coding instructions directly requires an organization API key granted the instructions:publish scope. This key is a personal key, which cannot publish here even when it carries a wildcard * scope.",
				),
				403,
			);
		}
		return next();
	}

	/**
	 * POST /projects/:projectId/instructions/versions
	 *
	 * The unreviewed write: the same change set, published as a new version
	 * with nobody in between. `fabric instructions push --publish`.
	 *
	 * A SIBLING route rather than a mode on the one above, because the two
	 * authorities are two scopes and a scope is checked per route. A key
	 * holding only `instructions:write` is refused here; a key holding only
	 * `instructions:publish` is refused there. Neither can be talked into the
	 * other by its body, and a key's scope list alone says which of the two it
	 * can do — which is the property the settings picker's disclosure and the
	 * Connect dialog's promise both rest on.
	 *
	 * "versions" because that is what it creates and what the product calls
	 * it: the tab's history is a list of versions, the response names one, and
	 * `POST` to the collection is how one is made. `/changes` stays what it
	 * has always been — a suggestion about a version, not a version.
	 *
	 * Nothing here is a shortcut past a check. `submitInstructionChange` makes
	 * the same derived snapshot the tab's direct save makes and starts the
	 * same verify → scan → publish workflow; the version becomes the published
	 * one only when that workflow passes, so the response usually reports a
	 * snapshot still VALIDATING rather than a finished publish.
	 */
	app.post(
		"/projects/:projectId/instructions/versions",
		requireScope("instructions:publish"),
		requireOrganizationKeyForPublish,
		handleChangeSubmission("publish"),
	);

	/**
	 * GET /projects/:projectId/instructions/proposals/:snapshotId/pull-request
	 *
	 * A REPOSITORY proposal's pull request as Fabric last recorded it (Fizzy
	 * #2563 spec §12): what `fabric instructions push` polls after a
	 * suggestion is accepted. Never asks the provider; the row is the answer.
	 * `pullRequest: null` for a proposal Fabric reviews itself.
	 *
	 * THREE gates, in order, each with its own refusal (AGENTS.md: an API key
	 * never grants more than the UI):
	 * 1. the key's declared scope, `instructions:read` — the flat
	 *    `{ error: "Missing required scope: …" }` from the middleware;
	 * 2. the creator's live `INSTRUCTION_READ` and the organization binding,
	 *    `resolveInstructionProject`, as every route here — a wildcard `*` key
	 *    passes gate 1 and still meets this one;
	 * 3. the live proposer-or-reviewer check inside
	 *    `getProposalPullRequestStatus`, the same function the tab's procedure
	 *    calls: it looks the proposal up through the caller's visibility, so
	 *    an invited guest who can read the project but neither suggested this
	 *    change nor may review suggestions gets the 404 a missing id gets,
	 *    here as there, and cannot tell another member's id from none.
	 *    Gate 2 answers `{ error: { message } }` with 403.
	 *
	 * The implementation is imported lazily, as the write routes do, so the
	 * read routes never pull the Temporal client into their module graph.
	 */
	app.get(
		"/projects/:projectId/instructions/proposals/:snapshotId/pull-request",
		requireScope("instructions:read"),
		async (c) => {
			const apiCtx = c.get("externalApiContext");
			const projectId = c.req.param("projectId")!;
			const snapshotId = c.req.param("snapshotId")!;
			if (snapshotId.length > SNAPSHOT_ID_MAX_LENGTH) {
				return c.json(
					badRequest(
						`snapshotId must be at most ${SNAPSHOT_ID_MAX_LENGTH} characters.`,
					),
					400,
				);
			}

			const resolved = await resolveInstructionProject(
				projectId,
				apiCtx,
				{
					org: c.req.query("org"),
					personal: c.req.query("personal") === "1",
				},
			);
			if ("error" in resolved) {
				return c.json({ error: resolved.error }, resolved.status);
			}

			const { getProposalPullRequestStatus } = await import(
				"../projects/procedures/instructions/proposal-pull-request"
			);
			try {
				const pullRequest = await getProposalPullRequestStatus({
					snapshotId,
					projectId,
					organizationId: resolved.organizationId,
					userId: resolved.userId,
				});
				return c.json(ok({ pullRequest }));
			} catch (error) {
				const failure = submitChangeFailure(error);
				if (!failure) {
					throw error;
				}
				return c.json(
					{
						error: {
							message: failure.message,
							...(failure.code ? { code: failure.code } : {}),
						},
					},
					failure.status,
				);
			}
		},
	);
}
