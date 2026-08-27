import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, Prisma } from "../prisma/client";
import {
	checkFrameAccess,
	createMultipleSharingGrants,
	createSharingGrant,
	getFrameShareScope,
	hasSharingGrant,
	listSharingGrants,
	revokeSharingGrant,
	updateFrameShareScope,
	updateGrantAccessStats,
} from "../prisma/queries/frame-sharing";
import { createFrame, type FrameDocument } from "../prisma/queries/frames";

const USER_ID = "test-sharing-user";
const ORG_ID = "test-sharing-org";
const INVITED_EMAIL = "invited@example.com";

const sampleFrameContent: FrameDocument = {
	version: 1,
	title: "Test Frame",
	description: "A test frame",
	kind: "frame",
	blocks: [{ id: "b1", type: "markdown", content: "# Test" }],
};

let testFrameId: string;

beforeAll(async () => {
	const now = new Date();
	await db.$executeRaw(Prisma.sql`
		INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
		VALUES (${USER_ID}, ${"Test Sharing"}, ${"sharing@example.com"}, true, false, ${now}, ${now})
		ON CONFLICT (id) DO NOTHING
	`);
	await db.$executeRaw(Prisma.sql`
		INSERT INTO "organization" (id, name, slug, "createdAt")
		VALUES (${ORG_ID}, ${"Test Sharing Org"}, ${ORG_ID}, ${now})
		ON CONFLICT (id) DO NOTHING
	`);
});

beforeEach(async () => {
	// Clean up grants and frames
	await db.frameSharingGrant.deleteMany({
		where: { frame: { userId: USER_ID } },
	});
	await db.agentWorkspaceFile.deleteMany({
		where: { userId: USER_ID, fileType: { in: ["FRAME", "SLIDESHOW"] } },
	});

	// Create a test frame
	const frame = await createFrame({
		userId: USER_ID,
		title: "Shareable Frame",
		blocks: sampleFrameContent.blocks,
	});
	testFrameId = frame.id;
});

afterAll(async () => {
	await db.frameSharingGrant.deleteMany({
		where: { frame: { userId: USER_ID } },
	});
	await db.agentWorkspaceFile.deleteMany({
		where: { userId: USER_ID, fileType: { in: ["FRAME", "SLIDESHOW"] } },
	});
});

describe("frame sharing queries", () => {
	it("creates a sharing grant", async () => {
		const grant = await createSharingGrant({
			frameId: testFrameId,
			email: INVITED_EMAIL,
			invitedBy: USER_ID,
		});

		expect(grant.frameId).toBe(testFrameId);
		expect(grant.email).toBe(INVITED_EMAIL.toLowerCase());
		expect(grant.invitedBy).toBe(USER_ID);
		expect(grant.accessCount).toBe(0);
	});

	it("creates multiple sharing grants", async () => {
		const emails = [
			"user1@example.com",
			"user2@example.com",
			"user3@example.com",
		];

		const grants = await createMultipleSharingGrants(
			testFrameId,
			emails,
			USER_ID,
		);

		expect(grants).toHaveLength(3);
		expect(grants.map((g) => g.email)).toContain("user1@example.com");
		expect(grants.map((g) => g.email)).toContain("user2@example.com");
		expect(grants.map((g) => g.email)).toContain("user3@example.com");
	});

	it("lists sharing grants for a frame", async () => {
		await createSharingGrant({
			frameId: testFrameId,
			email: "first@example.com",
			invitedBy: USER_ID,
		});
		await createSharingGrant({
			frameId: testFrameId,
			email: "second@example.com",
			invitedBy: USER_ID,
		});

		const grants = await listSharingGrants(testFrameId);

		expect(grants).toHaveLength(2);
	});

	it("revokes a sharing grant", async () => {
		await createSharingGrant({
			frameId: testFrameId,
			email: INVITED_EMAIL,
			invitedBy: USER_ID,
		});

		const revoked = await revokeSharingGrant(testFrameId, INVITED_EMAIL);
		expect(revoked).toBe(true);

		const grants = await listSharingGrants(testFrameId);
		expect(grants).toHaveLength(0);
	});

	it("checks if a sharing grant exists", async () => {
		await createSharingGrant({
			frameId: testFrameId,
			email: INVITED_EMAIL,
			invitedBy: USER_ID,
		});

		const hasGrant = await hasSharingGrant(testFrameId, INVITED_EMAIL);
		expect(hasGrant).toBe(true);

		const noGrant = await hasSharingGrant(testFrameId, "other@example.com");
		expect(noGrant).toBe(false);
	});

	it("updates grant access stats", async () => {
		const grant = await createSharingGrant({
			frameId: testFrameId,
			email: INVITED_EMAIL,
			invitedBy: USER_ID,
		});

		await updateGrantAccessStats(grant.id);

		const grants = await listSharingGrants(testFrameId);
		const updated = grants.find((g) => g.id === grant.id);

		expect(updated?.accessCount).toBe(1);
		expect(updated?.lastAccessedAt).not.toBeNull();
	});

	it("updates frame share scope to PUBLIC", async () => {
		const result = await updateFrameShareScope({
			frameId: testFrameId,
			userId: USER_ID,
			shareScope: "PUBLIC",
		});

		expect(result.success).toBe(true);
		expect(result.shareToken).toBeDefined();

		const scope = await getFrameShareScope(testFrameId);
		expect(scope).toBe("PUBLIC");
	});

	it("updates frame share scope to PRIVATE", async () => {
		// First make it public
		await updateFrameShareScope({
			frameId: testFrameId,
			userId: USER_ID,
			shareScope: "PUBLIC",
		});

		// Then make it private
		const result = await updateFrameShareScope({
			frameId: testFrameId,
			userId: USER_ID,
			shareScope: "PRIVATE",
		});

		expect(result.success).toBe(true);
		expect(result.shareToken).toBeUndefined();

		const scope = await getFrameShareScope(testFrameId);
		expect(scope).toBe("PRIVATE");
	});

	it("fails to update share scope for non-existent frame", async () => {
		const result = await updateFrameShareScope({
			frameId: "non-existent-id",
			userId: USER_ID,
			shareScope: "PUBLIC",
		});

		expect(result.success).toBe(false);
		expect(result.error).toBe("Frame not found");
	});

	it("allows owner access regardless of scope", async () => {
		await updateFrameShareScope({
			frameId: testFrameId,
			userId: USER_ID,
			shareScope: "PRIVATE",
		});

		const access = await checkFrameAccess({
			frameId: testFrameId,
			userId: USER_ID,
		});

		expect(access.hasAccess).toBe(true);
		expect(access.scope).toBe("PRIVATE");
	});

	it("allows PUBLIC access without user", async () => {
		await updateFrameShareScope({
			frameId: testFrameId,
			userId: USER_ID,
			shareScope: "PUBLIC",
		});

		const access = await checkFrameAccess({
			frameId: testFrameId,
		});

		expect(access.hasAccess).toBe(true);
		expect(access.scope).toBe("PUBLIC");
	});

	it("allows EMAILS_ONLY access with valid grant", async () => {
		await updateFrameShareScope({
			frameId: testFrameId,
			userId: USER_ID,
			shareScope: "EMAILS_ONLY",
		});

		await createSharingGrant({
			frameId: testFrameId,
			email: INVITED_EMAIL,
			invitedBy: USER_ID,
		});

		const access = await checkFrameAccess({
			frameId: testFrameId,
			userEmail: INVITED_EMAIL,
		});

		expect(access.hasAccess).toBe(true);
		expect(access.scope).toBe("EMAILS_ONLY");
		expect(access.grant).toBeDefined();
	});

	it("denies EMAILS_ONLY access without grant", async () => {
		await updateFrameShareScope({
			frameId: testFrameId,
			userId: USER_ID,
			shareScope: "EMAILS_ONLY",
		});

		const access = await checkFrameAccess({
			frameId: testFrameId,
			userEmail: "unauthorized@example.com",
		});

		expect(access.hasAccess).toBe(false);
	});

	it("denies PRIVATE access to non-owner", async () => {
		await updateFrameShareScope({
			frameId: testFrameId,
			userId: USER_ID,
			shareScope: "PRIVATE",
		});

		const access = await checkFrameAccess({
			frameId: testFrameId,
			userId: "other-user-id",
			userEmail: INVITED_EMAIL,
		});

		expect(access.hasAccess).toBe(false);
		expect(access.scope).toBe("PRIVATE");
	});
});
