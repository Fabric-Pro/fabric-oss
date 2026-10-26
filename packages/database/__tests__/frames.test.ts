import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { editFirstClassFrameBlock } from "../../temporal/src/activities/shared/frame-service";
import { db, Prisma } from "../prisma/client";
import {
	createFrame,
	FABRIC_FRAME_CONTENT_TYPE,
	getFrameById,
	getFrameByShareToken,
	listFrames,
	publishFrame,
	updateFrame,
} from "../prisma/queries/frames";

const USER_ID = "test-frame-user";
const ORG_ID = "test-frame-org";
const PROJECT_ID = "test-frame-parlume-project";

beforeAll(async () => {
	const now = new Date();
	await db.$executeRaw(Prisma.sql`
		INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
		VALUES (${USER_ID}, ${"Test Frames"}, ${"frames@example.com"}, true, false, ${now}, ${now})
		ON CONFLICT (id) DO NOTHING
	`);
	await db.$executeRaw(Prisma.sql`
		INSERT INTO "organization" (id, name, slug, "createdAt")
		VALUES (${ORG_ID}, ${"Test Frames Org"}, ${ORG_ID}, ${now})
		ON CONFLICT (id) DO NOTHING
	`);
	await db.member.upsert({
		where: { id: "example-frame-editor" },
		create: {
			id: "example-frame-editor",
			userId: USER_ID,
			organizationId: ORG_ID,
			role: "admin",
			createdAt: now,
		},
		update: { role: "admin" },
	});

	await db.project.upsert({
		where: { id: PROJECT_ID },
		create: {
			id: PROJECT_ID,
			name: "Frame project",
			userId: USER_ID,
			organizationId: ORG_ID,
			techStack: [],
			features: [],
			tags: [],
		},
		update: {},
	});
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
	await db.member.deleteMany({
		where: {
			id: "example-frame-editor",
			userId: USER_ID,
			organizationId: ORG_ID,
		},
	});
	await db.project.deleteMany({ where: { id: PROJECT_ID, userId: USER_ID } });
});

describe("first-class frames queries", () => {
	it("restricts voice-scoped frame updates and publishing to the meeting project", async () => {
		const frame = await createFrame({
			userId: USER_ID,
			organizationId: ORG_ID,
			projectId: PROJECT_ID,
			title: "Project frame",
			blocks: [{ id: "block", type: "markdown", content: "Review" }],
		});
		expect(
			await updateFrame({
				id: frame.id,
				userId: USER_ID,
				organizationId: ORG_ID,
				projectId: "other-project",
				title: "Wrong project",
			}),
		).toBeNull();
		expect(
			await publishFrame({
				id: frame.id,
				userId: USER_ID,
				organizationId: ORG_ID,
				projectId: "other-project",
			}),
		).toBeNull();
		expect(
			await updateFrame({
				id: frame.id,
				userId: USER_ID,
				organizationId: ORG_ID,
				projectId: PROJECT_ID,
				title: "Approved",
			}),
		).toMatchObject({ title: "Approved" });
		expect(
			await publishFrame({
				id: frame.id,
				userId: USER_ID,
				organizationId: ORG_ID,
				projectId: PROJECT_ID,
			}),
		).toMatchObject({ isPublic: true });
	});
	it("writes exactly one history row for one changed update, and none for an update that changes nothing", async () => {
		const frame = await createFrame({
			userId: USER_ID,
			organizationId: ORG_ID,
			title: "Versioned frame",
			blocks: [{ id: "block-1", type: "markdown", content: "# v1" }],
		});
		const edit = {
			id: frame.id,
			userId: USER_ID,
			organizationId: ORG_ID,
			blocks: [
				{ id: "block-1", type: "markdown" as const, content: "# v2" },
			],
		};

		await updateFrame(edit);
		await updateFrame(edit);

		expect(
			await db.frameEditHistory.count({ where: { frameId: frame.id } }),
		).toBe(1);
	});

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

	it("creates a frame with an oversized, non-alphanumeric title without hanging (bounded slug regex — js/polynomial-redos)", async () => {
		// `title` has no zod max() bound upstream; a pathologically long,
		// mostly-punctuation title must still resolve to a valid, bounded
		// path rather than scanning the whole title through the slug regex
		// chain.
		const longTitle = "!".repeat(5000);
		const frame = await createFrame({
			userId: USER_ID,
			title: longTitle,
			blocks: [{ id: "block-1", type: "markdown", content: "# Hello" }],
		});
		// No alphanumeric chars survive within the bounded prefix, so the
		// slug falls back to the frame kind.
		expect(frame.path).toMatch(/^\/frames\/frame-\d+\.frame\.json$/);
	});
});

describe("conditional frame updates", () => {
	it("refuses a stale expected timestamp without saving history", async () => {
		const frame = await createFrame({
			userId: USER_ID,
			organizationId: ORG_ID,
			title: "Example",
			blocks: [{ id: "example-block", type: "html", content: "hello" }],
		});
		const before = await db.frameEditHistory.count({
			where: { frameId: frame.id },
		});
		await expect(
			updateFrame({
				id: frame.id,
				userId: USER_ID,
				organizationId: ORG_ID,
				expectedUpdatedAt: frame.updatedAt,
				requestedUpdatedAt: new Date(frame.updatedAt.getTime() - 1000),
				blocks: [
					{ id: "example-block", type: "html", content: "changed" },
				],
			}),
		).rejects.toThrow("Re-read");
		expect(
			await db.frameEditHistory.count({ where: { frameId: frame.id } }),
		).toBe(before);
	});
	it("preserves a concurrent writer between the read and save and rolls back history", async () => {
		const frame = await createFrame({
			userId: USER_ID,
			organizationId: ORG_ID,
			title: "Example",
			blocks: [{ id: "example-block", type: "html", content: "hello" }],
		});
		const original = db.agentWorkspaceFile.findFirst.bind(
			db.agentWorkspaceFile,
		);
		const concurrentContent = JSON.stringify({
			...frame.document,
			blocks: [
				{ id: "example-block", type: "html", content: "concurrent" },
			],
		});
		const before = await db.frameEditHistory.count({
			where: { frameId: frame.id },
		});
		const read = vi
			.spyOn(db.agentWorkspaceFile, "findFirst")
			.mockImplementationOnce(
				(...args) =>
					(async () => {
						const snapshot = await original(...args);
						await db.agentWorkspaceFile.update({
							where: { id: frame.id },
							data: {
								content: concurrentContent,
								updatedAt: new Date(
									frame.updatedAt.getTime() + 1000,
								),
							},
						});
						return snapshot;
					})() as ReturnType<typeof db.agentWorkspaceFile.findFirst>,
			);
		try {
			await expect(
				updateFrame({
					id: frame.id,
					userId: USER_ID,
					organizationId: ORG_ID,
					expectedUpdatedAt: frame.updatedAt,
					blocks: [
						{
							id: "example-block",
							type: "html",
							content: "lost update",
						},
					],
				}),
			).rejects.toThrow("Re-read");
		} finally {
			read.mockRestore();
		}
		expect(
			(
				await getFrameById({
					id: frame.id,
					userId: USER_ID,
					organizationId: ORG_ID,
				})
			)?.document.blocks[0].content,
		).toBe("concurrent");
		expect(
			await db.frameEditHistory.count({ where: { frameId: frame.id } }),
		).toBe(before);
	});
	it("saves edit history without returning its unusable identifier", async () => {
		const frame = await createFrame({
			userId: USER_ID,
			organizationId: ORG_ID,
			title: "Example",
			blocks: [{ id: "example-block", type: "html", content: "hello" }],
		});
		const before = await db.frameEditHistory.count({
			where: { frameId: frame.id },
		});
		const updated = await updateFrame({
			id: frame.id,
			userId: USER_ID,
			organizationId: ORG_ID,
			expectedUpdatedAt: frame.updatedAt,
			blocks: [{ id: "example-block", type: "html", content: "changed" }],
		});
		expect(updated).not.toHaveProperty("editVersionId");
		expect(
			await db.frameEditHistory.count({ where: { frameId: frame.id } }),
		).toBe(before + 1);
		expect(
			await db.frameEditHistory.findFirst({
				where: { frameId: frame.id },
			}),
		).toMatchObject({ contentSnapshot: expect.stringContaining("hello") });
	});
	it("forwards a stale caller timestamp through editFirstClassFrameBlock without saving", async () => {
		const frame = await createFrame({
			userId: USER_ID,
			organizationId: ORG_ID,
			title: "Example",
			blocks: [{ id: "example-block", type: "html", content: "hello" }],
		});
		const before = await db.frameEditHistory.count({
			where: { frameId: frame.id },
		});
		const result = await editFirstClassFrameBlock({
			userId: USER_ID,
			organizationId: ORG_ID,
			args: {
				frameId: frame.id,
				blockId: "example-block",
				expectedUpdatedAt: new Date(
					frame.updatedAt.getTime() - 1000,
				).toISOString(),
				edits: [{ oldText: "hello", newText: "changed" }],
			},
		});
		expect(result).toEqual({
			error: "Frame conflict: the page changed. Re-read the frame before editing again.",
		});
		expect(
			await db.frameEditHistory.count({ where: { frameId: frame.id } }),
		).toBe(before);
		const stored = await getFrameById({
			id: frame.id,
			userId: USER_ID,
			organizationId: ORG_ID,
		});
		expect(stored?.updatedAt).toEqual(frame.updatedAt);
		expect(stored?.document.blocks[0].content).toBe("hello");
	});
	it.each([false, true])(
		"a no-op edit preserves version count and updatedAt (caller timestamp: %s)",
		async (withTimestamp) => {
			const frame = await createFrame({
				userId: USER_ID,
				organizationId: ORG_ID,
				title: "Example",
				blocks: [
					{ id: "example-block", type: "html", content: "hello" },
				],
			});
			const before = await db.frameEditHistory.count({
				where: { frameId: frame.id },
			});
			const result = await editFirstClassFrameBlock({
				userId: USER_ID,
				organizationId: ORG_ID,
				args: {
					frameId: frame.id,
					blockId: "example-block",
					...(withTimestamp
						? { expectedUpdatedAt: frame.updatedAt.toISOString() }
						: {}),
					edits: [{ oldText: "hello", newText: "hello" }],
				},
			});
			expect(result).toMatchObject({
				unchanged: true,
				updatedAt: frame.updatedAt.toISOString(),
			});
			expect(result).not.toHaveProperty("versionId");
			expect(
				await db.frameEditHistory.count({
					where: { frameId: frame.id },
				}),
			).toBe(before);
			expect(
				(
					await getFrameById({
						id: frame.id,
						userId: USER_ID,
						organizationId: ORG_ID,
					})
				)?.updatedAt,
			).toEqual(frame.updatedAt);
		},
	);
	it("a stale no-op edit returns a conflict without changing the frame", async () => {
		const frame = await createFrame({
			userId: USER_ID,
			organizationId: ORG_ID,
			title: "Example",
			blocks: [{ id: "example-block", type: "html", content: "hello" }],
		});
		const before = await db.frameEditHistory.count({
			where: { frameId: frame.id },
		});
		const result = await editFirstClassFrameBlock({
			userId: USER_ID,
			organizationId: ORG_ID,
			args: {
				frameId: frame.id,
				blockId: "example-block",
				expectedUpdatedAt: new Date(
					frame.updatedAt.getTime() - 1000,
				).toISOString(),
				edits: [{ oldText: "hello", newText: "hello" }],
			},
		});
		expect(result).toMatchObject({
			error: expect.stringContaining("Re-read"),
		});
		expect(
			await db.frameEditHistory.count({ where: { frameId: frame.id } }),
		).toBe(before);
		expect(
			(
				await getFrameById({
					id: frame.id,
					userId: USER_ID,
					organizationId: ORG_ID,
				})
			)?.updatedAt,
		).toEqual(frame.updatedAt);
	});
});
