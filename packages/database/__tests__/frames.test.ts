import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, Prisma } from "../prisma/client";
import {
	createFrame,
	FABRIC_FRAME_CONTENT_TYPE,
	getFrameById,
	getFrameByShareToken,
	listFrames,
	publishFrame,
} from "../prisma/queries/frames";

const USER_ID = "test-frame-user";
const ORG_ID = "test-frame-org";

beforeAll(async () => {
	const now = new Date();
	await db.$executeRaw(Prisma.sql`
		INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
		VALUES (${USER_ID}, ${"Test Frames"}, ${"frames@test.com"}, true, false, ${now}, ${now})
		ON CONFLICT (id) DO NOTHING
	`);
	await db.$executeRaw(Prisma.sql`
		INSERT INTO "organization" (id, name, slug, "createdAt")
		VALUES (${ORG_ID}, ${"Test Frames Org"}, ${ORG_ID}, ${now})
		ON CONFLICT (id) DO NOTHING
	`);
});

beforeEach(async () => {
	await db.agentWorkspaceFile.deleteMany({
		where: {
			userId: USER_ID,
			fileType: { in: ["FRAME", "SLIDESHOW"] },
		},
	});
});

afterAll(async () => {
	await db.agentWorkspaceFile.deleteMany({
		where: {
			userId: USER_ID,
			fileType: { in: ["FRAME", "SLIDESHOW"] },
		},
	});
});

describe("first-class frames queries", () => {
	it("creates and retrieves a frame in personal context", async () => {
		const frame = await createFrame({
			userId: USER_ID,
			title: "Personal Frame",
			blocks: [
				{
					id: "block-1",
					type: "markdown",
					content: "# Hello",
				},
			],
		});

		expect(frame.contentType).toBe(FABRIC_FRAME_CONTENT_TYPE);
		expect(frame.kind).toBe("frame");

		const fetched = await getFrameById({ id: frame.id, userId: USER_ID });
		expect(fetched?.title).toBe("Personal Frame");
		expect(fetched?.document.blocks).toHaveLength(1);
	});

	it("isolates frames by organization context", async () => {
		await createFrame({
			userId: USER_ID,
			organizationId: ORG_ID,
			title: "Org Frame",
			blocks: [{ id: "block-1", type: "json", content: '{"ok":true}' }],
		});

		const orgFrames = await listFrames({
			userId: USER_ID,
			organizationId: ORG_ID,
		});
		const personalFrames = await listFrames({ userId: USER_ID });

		expect(orgFrames).toHaveLength(1);
		expect(personalFrames).toHaveLength(0);
	});

	it("publishes a frame and resolves it via share token", async () => {
		const frame = await createFrame({
			userId: USER_ID,
			title: "Shareable Frame",
			blocks: [
				{ id: "block-1", type: "html", content: "<h1>Shared</h1>" },
			],
		});

		const published = await publishFrame({ id: frame.id, userId: USER_ID });
		expect(published?.isPublic).toBe(true);
		expect(published?.shareToken).toBeTruthy();

		const shared = await getFrameByShareToken(published?.shareToken || "");
		expect(shared?.id).toBe(frame.id);
		expect(shared?.document.title).toBe("Shareable Frame");
	});
});
