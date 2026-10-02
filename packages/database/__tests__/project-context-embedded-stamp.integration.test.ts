/**
 * Real-Postgres test for `stampContextsEmbedded`, the stamp that ends a bulk
 * embed of project contexts.
 *
 * The embed copies each row's content into its workflow input and stamps the
 * row minutes later. A row edited in between must NOT be stamped: its vector
 * holds the old content, and a stamped row is never picked up again. A row
 * deleted in between must not fail the stamp of every other row. The
 * interleaving is the point, so the edit and the delete here happen for real,
 * between the "copy" and the "stamp".
 *
 * Self-skips when DATABASE_URL is unset or is the CI placeholder.
 *
 * Run with:
 *   pnpm --filter @repo/database exec dotenv -c -e ../../.env.local -- vitest run __tests__/project-context-embedded-stamp.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, stampContextsEmbedded } from "../index";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const RUN_ID = `${Date.now()}-${process.pid}`;
const ORGANIZATION_ID = `embed-stamp-org-${RUN_ID}`;
const USER_ID = `embed-stamp-user-${RUN_ID}`;
let projectId = "";
let otherProjectId = "";

async function newContext(
	overrides: { contentHash?: string; content?: string } = {},
	forProject = projectId,
) {
	const row = await db.projectContext.create({
		data: {
			projectId: forProject,
			organizationId: ORGANIZATION_ID,
			userId: USER_ID,
			type: "TEXT",
			content: overrides.content ?? "original content",
			contentHash: overrides.contentHash ?? null,
		},
		select: { id: true, updatedAt: true, contentHash: true },
	});
	return row;
}

function readRow(id: string) {
	return db.projectContext.findUniqueOrThrow({
		where: { id },
		select: { embeddedAt: true, qdrantId: true },
	});
}

/** The version the embed copied out with the row. */
const versionOf = (row: { updatedAt: Date; contentHash: string | null }) => ({
	contentHash: row.contentHash,
	updatedAt: row.updatedAt,
});

describe.skipIf(!hasReachableDatabaseUrl())(
	"stamping contexts after a bulk embed (real Postgres)",
	() => {
		beforeAll(async () => {
			const now = new Date();
			await db.user.create({
				data: {
					id: USER_ID,
					name: "Embed Stamp",
					email: `${USER_ID}@example.com`,
					emailVerified: true,
					createdAt: now,
					updatedAt: now,
				},
			});
			await db.organization.create({
				data: {
					id: ORGANIZATION_ID,
					name: "Embed Stamp",
					slug: ORGANIZATION_ID,
					createdAt: now,
				},
			});
			for (const name of ["Embed Stamp", "Other"]) {
				const project = await db.project.create({
					data: {
						name,
						userId: USER_ID,
						organizationId: ORGANIZATION_ID,
						techStack: [],
						features: [],
						tags: [],
					},
				});
				if (name === "Other") {
					otherProjectId = project.id;
				} else {
					projectId = project.id;
				}
			}
		});

		afterAll(async () => {
			for (const id of [projectId, otherProjectId]) {
				if (id) {
					await db.projectContext.deleteMany({
						where: { projectId: id },
					});
					await db.project.deleteMany({ where: { id } });
				}
			}
			await db.organization.deleteMany({
				where: { id: ORGANIZATION_ID },
			});
			await db.user.deleteMany({ where: { id: USER_ID } });
			await db.$disconnect();
		});

		it("stamps a row whose content is still what was embedded", async () => {
			const row = await newContext();

			const result = await stampContextsEmbedded({
				projectId,
				contexts: [
					{ id: row.id, qdrantId: "q-1", version: versionOf(row) },
				],
			});

			expect(result).toEqual({ stamped: 1, skipped: 0 });
			expect(await readRow(row.id)).toMatchObject({
				qdrantId: "q-1",
				embeddedAt: expect.any(Date),
			});
		});

		it("leaves a row unstamped when its content changed between the copy and the stamp, so the next pass embeds it again", async () => {
			const row = await newContext();
			const copied = versionOf(row);
			await db.projectContext.update({
				where: { id: row.id },
				data: { content: "edited after the copy" },
			});

			const result = await stampContextsEmbedded({
				projectId,
				contexts: [{ id: row.id, qdrantId: "q-2", version: copied }],
			});

			expect(result).toEqual({ stamped: 0, skipped: 1 });
			expect(await readRow(row.id)).toEqual({
				qdrantId: null,
				embeddedAt: null,
			});
			const stillPending = await db.projectContext.count({
				where: { id: row.id, embeddedAt: null },
			});
			expect(stillPending).toBe(1);
		});

		it("judges a row that has a content hash by the hash, not by updatedAt", async () => {
			const row = await newContext({ contentHash: "a".repeat(64) });
			const copied = versionOf(row);
			// Moves updatedAt without changing the content.
			await db.projectContext.update({
				where: { id: row.id },
				data: { sourceTitle: "renamed" },
			});
			const changed = await newContext({ contentHash: "b".repeat(64) });
			const copiedChanged = versionOf(changed);
			await db.projectContext.update({
				where: { id: changed.id },
				data: { contentHash: "c".repeat(64), content: "new" },
			});

			const result = await stampContextsEmbedded({
				projectId,
				contexts: [
					{ id: row.id, qdrantId: "q-3", version: copied },
					{
						id: changed.id,
						qdrantId: "q-4",
						version: copiedChanged,
					},
				],
			});

			expect(result).toEqual({ stamped: 1, skipped: 1 });
			expect((await readRow(row.id)).embeddedAt).not.toBeNull();
			expect((await readRow(changed.id)).embeddedAt).toBeNull();
		});

		it("skips a row deleted in between and still stamps the others in the same batch", async () => {
			const kept = await newContext();
			const gone = await newContext();
			const keptVersion = versionOf(kept);
			const goneVersion = versionOf(gone);
			await db.projectContext.delete({ where: { id: gone.id } });

			const result = await stampContextsEmbedded({
				projectId,
				contexts: [
					{ id: gone.id, qdrantId: "q-5", version: goneVersion },
					{ id: kept.id, qdrantId: "q-6", version: keptVersion },
				],
			});

			expect(result).toEqual({ stamped: 1, skipped: 1 });
			expect(await readRow(kept.id)).toMatchObject({ qdrantId: "q-6" });
		});

		it("never stamps a row of another project", async () => {
			const foreign = await newContext({}, otherProjectId);

			const result = await stampContextsEmbedded({
				projectId,
				contexts: [{ id: foreign.id, qdrantId: "q-7" }],
			});

			expect(result).toEqual({ stamped: 0, skipped: 1 });
			expect((await readRow(foreign.id)).embeddedAt).toBeNull();
		});

		it("stamps by id alone for a caller that sent no version", async () => {
			const row = await newContext();

			const result = await stampContextsEmbedded({
				projectId,
				contexts: [{ id: row.id, qdrantId: "q-8" }],
			});

			expect(result).toEqual({ stamped: 1, skipped: 0 });
		});
	},
);
