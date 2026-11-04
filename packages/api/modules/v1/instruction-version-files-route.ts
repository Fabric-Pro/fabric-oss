import { config } from "@repo/config";
import { getInstructionSnapshot, listInstructionFiles } from "@repo/database";
import { getStorageProvider } from "@repo/storage";
import type { Context, Hono } from "hono";
import { requireScope } from "../external-api/middleware/api-key-auth";
import type { ExternalApiVariables } from "../external-api/types";
import { badRequest, notFound, ok } from "./helpers";
import { resolveInstructionProject } from "./instruction-project-gate";

type V1Context = Context<{ Variables: ExternalApiVariables }>;

/** How long each signed file URL stays valid, as `published/files` signs them. */
const URL_EXPIRES_IN_SECONDS = 600;

/** The most paths one request may name, as `published/files` allows. */
const MAX_PATHS = 200;

const MAX_PATH_LENGTH = 4096;

const SNAPSHOT_ID_MAX_LENGTH = 128;

function readPathsBody(raw: unknown): { paths: string[] } | { error: string } {
	const paths =
		typeof raw === "object" && raw !== null
			? (raw as { paths?: unknown }).paths
			: undefined;
	if (
		!Array.isArray(paths) ||
		paths.length === 0 ||
		paths.length > MAX_PATHS ||
		!paths.every(
			(p): p is string =>
				typeof p === "string" &&
				p.length > 0 &&
				p.length <= MAX_PATH_LENGTH,
		)
	) {
		return {
			error: `paths must be 1 to ${MAX_PATHS} non-empty strings.`,
		};
	}
	if (new Set(paths).size !== paths.length) {
		return { error: "paths must be unique." };
	}
	return { paths };
}

/**
 * POST /projects/:projectId/instructions/versions/:snapshotId/files
 *
 * Short-lived signed URLs for files of a version that WAS published, named by
 * its snapshot id: `fabric instructions push --rebase` reads the version its
 * lock names, which the published version has since replaced, to merge the
 * checkout's edits onto the one published now.
 *
 * The same two gates as `published/files`: the key's `instructions:read`
 * scope and the creator's live read permission, through
 * `resolveInstructionProject`. Only a snapshot of this project and its
 * hosting organization that has been published at least once is served, the
 * versions the tab's History already shows the same reader; a proposal that
 * was never published, or another project's id, answers 404 as a missing one
 * does. Paths the version does not hold come back in `missing`, since a
 * rebase asks for files the checkout added as well.
 */
export function registerInstructionVersionFileRoutes(
	app: Hono<{ Variables: ExternalApiVariables }>,
	refuseDirectRepositoryExport: (
		c: V1Context,
		projectId: string,
		organizationId: string,
	) => Promise<Response | null>,
) {
	app.post(
		"/projects/:projectId/instructions/versions/:snapshotId/files",
		requireScope("instructions:read"),
		async (c) => {
			const snapshotId = c.req.param("snapshotId")!;
			if (snapshotId.length > SNAPSHOT_ID_MAX_LENGTH) {
				return c.json(
					badRequest(
						`snapshotId must be at most ${SNAPSHOT_ID_MAX_LENGTH} characters.`,
					),
					400,
				);
			}
			let rawBody: unknown;
			try {
				rawBody = await c.req.json();
			} catch {
				return c.json(badRequest("Invalid JSON body"), 400);
			}
			const body = readPathsBody(rawBody);
			if ("error" in body) {
				return c.json(badRequest(body.error), 400);
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
			const refusal = await refuseDirectRepositoryExport(
				c,
				projectId,
				resolved.organizationId,
			);
			if (refusal) return refusal;

			const snapshot = await getInstructionSnapshot(
				snapshotId,
				projectId,
				resolved.organizationId,
			);
			if (
				!snapshot ||
				snapshot.contentKind !== "FULL_SNAPSHOT" ||
				snapshot.status !== "READY" ||
				snapshot.publishedAt === null ||
				snapshot.digest === null
			) {
				return c.json(notFound("Version"), 404);
			}

			const byPath = new Map(
				(
					await listInstructionFiles(
						snapshot.id,
						resolved.organizationId,
					)
				).map((f) => [f.path, f]),
			);
			const storage = getStorageProvider();
			const files = await Promise.all(
				body.paths.flatMap((path) => {
					const f = byPath.get(path);
					return f
						? [
								storage
									.getSignedUrl(f.storageKey, {
										bucket: config.storage.bucketNames
											.skills,
										expiresIn: URL_EXPIRES_IN_SECONDS,
									})
									.then((url) => ({
										path: f.path,
										sha256: f.sha256,
										size: f.size,
										mode: f.mode,
										url,
									})),
							]
						: [];
				}),
			);
			return c.json(
				ok({
					snapshotId: snapshot.id,
					version: snapshot.version,
					digest: snapshot.digest,
					files,
					missing: body.paths.filter((path) => !byPath.has(path)),
					expiresInSeconds: URL_EXPIRES_IN_SECONDS,
				}),
			);
		},
	);
}
