import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../prisma/client";
import { getWorkspaceDocumentCatalog } from "../prisma/queries/workspaces/document-content";
import { listWorkspaceDocuments } from "../prisma/queries/workspaces/documents";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const enabled =
	process.env.RUN_DB_INTEGRATION === "1" && hasReachableDatabaseUrl();
const prefix = `example-catalog-${randomUUID()}`;
const ids = {
	user: `${prefix}-user`,
	org: `${prefix}-org`,
	workspace: `${prefix}-workspace`,
};
const actor = { userId: ids.user, organizationId: ids.org };
let safeDatabase = false;
const createdAt = new Date("2026-01-01T00:00:00Z");
function document(suffix: string, date = createdAt) {
	return {
		id: `${prefix}-${suffix}`,
		workspaceId: ids.workspace,
		filename: `${suffix}.txt`,
		originalFilename: `${suffix}.txt`,
		mimeType: "text/plain",
		size: 1,
		s3Bucket: "example-bucket",
		s3Path: `example/${suffix}.txt`,
		status: "READY" as const,
		extractedText: suffix,
		qdrantPointIds: [],
		uploadedBy: ids.user,
		createdAt: date,
	};
}

describe.skipIf(!enabled)("Workspace catalog pagination on PostgreSQL", () => {
	beforeAll(async () => {
		if (
			!["localhost", "127.0.0.1", "[::1]"].includes(
				new URL(process.env.DATABASE_URL ?? "").hostname,
			)
		)
			throw new Error(
				"Workspace catalog integration tests require an explicit loopback database.",
			);
		safeDatabase = true;
		await db.user.create({
			data: {
				id: ids.user,
				name: "Example catalog actor",
				email: `${prefix}@example.com`,
				emailVerified: true,
				createdAt,
				updatedAt: createdAt,
			},
		});
		await db.organization.create({
			data: {
				id: ids.org,
				name: "Example catalog",
				slug: ids.org,
				createdAt,
			},
		});
		await db.member.create({
			data: {
				id: `${prefix}-member`,
				userId: ids.user,
				organizationId: ids.org,
				role: "member",
				createdAt,
			},
		});
		await db.workspace.create({
			data: {
				id: ids.workspace,
				userId: ids.user,
				organizationId: ids.org,
				name: "Example catalog",
			},
		});
		// Insert ascending IDs with exactly tied timestamps. createdAt alone must
		// not determine the page split through physical insertion/query-plan order.
		await db.workspaceDocument.createMany({
			data: [document("a"), document("b"), document("c")],
		});
	});
	afterAll(async () => {
		if (!safeDatabase) return;
		await db.workspace.deleteMany({ where: { id: ids.workspace } });
		await db.organization.deleteMany({ where: { id: ids.org } });
		await db.user.deleteMany({ where: { id: ids.user } });
	});
	it("uses the unique id tie-breaker and returns disjoint complete pages when data is unchanged", async () => {
		const first = await listWorkspaceDocuments({
			workspaceId: ids.workspace,
			limit: 2,
			offset: 0,
		});
		const next = await listWorkspaceDocuments({
			workspaceId: ids.workspace,
			limit: 2,
			offset: first.nextOffset,
		});
		expect(first.documents.map((row) => row.id)).toEqual([
			`${prefix}-c`,
			`${prefix}-b`,
		]);
		expect(next.documents.map((row) => row.id)).toEqual([`${prefix}-a`]);
		expect(
			new Set(
				[...first.documents, ...next.documents].map((row) => row.id),
			).size,
		).toBe(3);
	});
	it("truthfully labels live offsets: a later insertion may shift the next page", async () => {
		const first = await getWorkspaceDocumentCatalog(actor, {
			workspaceId: ids.workspace,
			limit: 2,
		});
		expect(first).toMatchObject({
			paginationMode: "live_offset",
			snapshotConsistent: false,
			nextOffset: 2,
		});
		await db.workspaceDocument.create({
			data: document("d", new Date("2026-02-01T00:00:00Z")),
		});
		const next = await getWorkspaceDocumentCatalog(actor, {
			workspaceId: ids.workspace,
			limit: 2,
			offset: first.nextOffset,
		});
		expect(next.documents.map((row) => row.id)).toEqual([
			`${prefix}-b`,
			`${prefix}-a`,
		]);
		expect(next.snapshotConsistent).toBe(false);
	});
});
