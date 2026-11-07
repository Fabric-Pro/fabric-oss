/**
 * An edit to a frame and the history row that keeps what it replaced stand or
 * fall together.
 *
 * "Version N" of a frame is "the page before the Nth change", so a row written
 * for an edit that did not land is a version nobody saw, and every version
 * after it is numbered one too high. The store here stages what a transaction
 * writes and keeps it only if the transaction finishes, so the cases can say
 * what is left behind when an update fails, which a mock of single calls
 * cannot. Postgres itself is not exercised.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const store = vi.hoisted(() => ({
	frames: [] as Row[],
	history: [] as Row[],
	failFrameUpdate: false,
	failAudit: false,
	transactions: 0,
	directHistoryWrites: 0,
	beforeTransaction: undefined as (() => void) | undefined,
}));

vi.mock("../prisma/client", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../prisma/client")>();

	function frameTable(frames: Row[]) {
		return {
			findFirst: async ({ where }: { where: Row }) => {
				const found = frames.find((row) =>
					Object.entries(where).every(([key, condition]) =>
						key === "fileType" || key === "projectId"
							? condition === undefined ||
								(condition as { in?: unknown[] }).in?.includes(
									row.fileType,
								) ||
								row[key] === condition
							: (row[key] ?? null) === (condition ?? null),
					),
				);
				return found ? { ...found } : null;
			},
			update: async ({
				where,
				data,
			}: {
				where: { id: string; updatedAt?: Date };
				data: Row;
			}) => {
				if (store.failFrameUpdate) {
					throw new Error("the update failed");
				}
				const row = frames.find(
					(candidate) =>
						candidate.id === where.id &&
						(!where.updatedAt ||
							(candidate.updatedAt as Date).getTime() ===
								where.updatedAt.getTime()),
				);
				if (!row) {
					throw Object.assign(new Error("no such frame"), {
						code: "P2025",
					});
				}
				Object.assign(row, data, { updatedAt: new Date() });
				return row;
			},
		};
	}

	return {
		...actual,
		db: {
			templateInstanceExecution: { findFirst: async () => null },
			agentWorkspaceFile: frameTable(store.frames),
			frameEditHistory: {
				create: async ({ data }: { data: Row }) => {
					store.directHistoryWrites += 1;
					const entry = {
						id: `edit-${store.history.length + 1}`,
						editedAt: new Date(),
						...data,
					};
					store.history.push(entry);
					return entry;
				},
			},
			$transaction: async <T>(
				body: (tx: Record<string, unknown>) => Promise<T>,
			): Promise<T> => {
				store.transactions += 1;
				store.beforeTransaction?.();
				const stagedHistory: Row[] = [];
				const stagedFrames = store.frames.map((row) => ({ ...row }));
				const tx = {
					auditLog: {
						create: async ({ data }: { data: Row }) => {
							if (store.failAudit) {
								throw Error("Audit unavailable");
							}
							return { id: "example-audit", ...data };
						},
					},
					$queryRaw: async () => [],
					frameEditHistory: {
						create: async ({ data }: { data: Row }) => {
							const entry = {
								id: `edit-${store.history.length + stagedHistory.length + 1}`,
								editedAt: new Date(),
								...data,
							};
							stagedHistory.push(entry);
							return entry;
						},
					},
					agentWorkspaceFile: frameTable(stagedFrames),
				};
				const result = await body(tx);
				store.history.push(...stagedHistory);
				for (const staged of stagedFrames) {
					const row = store.frames.find((r) => r.id === staged.id);
					if (row) {
						Object.assign(row, staged);
					}
				}
				return result;
			},
		},
	};
});

const { updateFrame } = await import("../prisma/queries/frames");

const USER = "user-1";
const ORG = "org-1";

function documentWith(title: string, content: string) {
	return JSON.stringify(
		{
			version: 1,
			kind: "frame",
			title,
			blocks: [{ id: "page", type: "html", content }],
			metadata: {},
		},
		null,
		2,
	);
}

function frameRow(): Row {
	return {
		id: "frame-1",
		conversationId: null,
		userId: USER,
		organizationId: ORG,
		projectId: null,
		storyId: null,
		path: "/frames/frame-1.frame.json",
		name: "Weekly report.frame.json",
		mimeType: "application/vnd.fabric.frame",
		fileType: "FRAME",
		status: "COMPLETE",
		version: 1,
		isPublic: false,
		shareToken: null,
		shareScope: "PRIVATE",
		sourceRunType: null,
		sourceRunId: null,
		authoritySessionId: null,
		providerKeys: [],
		metadata: { frameVersion: 1 },
		content: documentWith("Weekly report", "<p>v1</p>"),
		description: null,
		createdAt: new Date(2026, 0, 1),
		updatedAt: new Date(2026, 0, 1),
	};
}

const edit = (blocks: Array<{ id: string; type: "html"; content: string }>) =>
	updateFrame({
		id: "frame-1",
		userId: USER,
		organizationId: ORG,
		blocks,
	});

beforeEach(() => {
	store.frames.length = 0;
	store.history.length = 0;
	store.frames.push(frameRow());
	store.failFrameUpdate = false;
	store.failAudit = false;
	store.transactions = 0;
	store.directHistoryWrites = 0;
	store.beforeTransaction = undefined;
});

describe("updateFrame and the history of the page", () => {
	it("does not resurrect a binding revoked between the initial read and surface write", async () => {
		store.frames[0].metadata = {
			surface: "workspace",
			workflowBindings: {
				version: 1,
				workflows: [{ workflowId: "workflow-1" }],
			},
		};
		store.beforeTransaction = () => {
			store.frames[0].metadata = {
				surface: "workspace",
				workflowBindings: { version: 1, workflows: [] },
				concurrent: true,
			};
		};
		await updateFrame({
			id: "frame-1",
			userId: USER,
			organizationId: ORG,
			surface: "workspace",
		});
		expect(store.frames[0].metadata).toEqual({
			surface: "workspace",
			workflowBindings: { version: 1, workflows: [] },
			concurrent: true,
		});
	});

	it("drops bindings when a Workspace leaves its surface", async () => {
		store.frames[0].metadata = {
			surface: "workspace",
			workflowBindings: {
				version: 1,
				workflows: [{ workflowId: "workflow-1" }],
			},
			retained: true,
		};
		await updateFrame({
			id: "frame-1",
			userId: USER,
			organizationId: ORG,
			surface: "artifact",
		});
		expect(store.frames[0].metadata).toEqual({
			surface: "artifact",
			retained: true,
		});
	});
	it("writes exactly one history row for one changed update, holding the page it replaced", async () => {
		const before = store.frames[0].content;

		await edit([{ id: "page", type: "html", content: "<p>v2</p>" }]);

		expect(store.history).toHaveLength(1);
		expect(store.history[0]).toMatchObject({
			frameId: "frame-1",
			editType: "full_update",
			contentSnapshot: before,
			editedBy: USER,
		});
		expect(store.frames[0].content).toContain("<p>v2</p>");
	});

	it("writes the row and the update in one transaction, never on its own", async () => {
		await edit([{ id: "page", type: "html", content: "<p>v2</p>" }]);

		expect(store.transactions).toBe(1);
		expect(store.directHistoryWrites).toBe(0);
	});

	it("keeps no row for an edit that did not land", async () => {
		store.failFrameUpdate = true;

		await expect(
			edit([{ id: "page", type: "html", content: "<p>v2</p>" }]),
		).rejects.toThrow("the update failed");

		expect(store.history).toEqual([]);
		expect(store.frames[0].content).toContain("<p>v1</p>");
	});

	it("writes no row when nothing about the page changed", async () => {
		await edit([{ id: "page", type: "html", content: "<p>v1</p>" }]);

		expect(store.history).toEqual([]);
	});

	it("writes one row for each changed update, each holding the page before it", async () => {
		await edit([{ id: "page", type: "html", content: "<p>v2</p>" }]);
		await edit([{ id: "page", type: "html", content: "<p>v3</p>" }]);

		expect(store.history).toHaveLength(2);
		expect(String(store.history[0].contentSnapshot)).toContain("<p>v1</p>");
		expect(String(store.history[1].contentSnapshot)).toContain("<p>v2</p>");
	});

	it("opens no transaction and writes nothing for a frame the caller does not own", async () => {
		const result = await updateFrame({
			id: "frame-1",
			userId: "someone-else",
			organizationId: ORG,
			blocks: [{ id: "page", type: "html", content: "<p>v2</p>" }],
		});

		expect(result).toBeNull();
		expect(store.transactions).toBe(0);
		expect(store.history).toEqual([]);
	});
});

it("refuses a concurrent content write and rolls its staged history back", async () => {
	const newer = JSON.stringify({
		version: 1,
		kind: "frame",
		title: "Newer",
		blocks: [{ id: "page", type: "html", content: "<p>newer</p>" }],
	});
	store.beforeTransaction = () => {
		Object.assign(store.frames[0], {
			content: newer,
			updatedAt: new Date(Date.now() + 10000),
		});
	};
	await expect(
		updateFrame({
			id: "frame-1",
			userId: USER,
			organizationId: ORG,
			title: "Stale",
		}),
	).rejects.toMatchObject({ name: "FrameUpdateConflictError" });
	expect(store.history).toHaveLength(0);
	expect(store.frames[0].content).toBe(newer);
});

it("rolls content and history back when the audit insert fails", async () => {
	const before = store.frames[0].content;
	store.failAudit = true;
	await expect(
		updateFrame({
			id: "frame-1",
			userId: USER,
			organizationId: ORG,
			title: "Unsaved",
		}),
	).rejects.toThrow("Audit unavailable");
	expect(store.frames[0].content).toBe(before);
	expect(store.history).toHaveLength(0);
});

it("refuses a legacy string edit that changes only the reviewed brand", async () => {
	const { editFrameString } = await import(
		"../prisma/queries/frame-edit-history"
	);
	const doc = JSON.parse(String(store.frames[0].content));
	doc.theme = {
		branding: {
			version: 1,
			source: "CLIENT",
			companyName: "Example Studio",
			clientName: "Example Client",
			primaryColor: "#123456",
			accentColors: [],
			displayFontFamily: "Poppins",
			bodyFontFamily: "Inter",
			coverStyle: "DARK",
			companyBrandVersion: 1,
			clientBrandVersion: 2,
		},
	};
	const original = JSON.stringify(doc, null, 2);
	store.frames[0].content = original;
	store.frames[0].isPublic = true;
	const result = await editFrameString({
		frameId: "frame-1",
		userId: USER,
		organizationId: ORG,
		oldString: '"coverStyle": "DARK"',
		newString: '"coverStyle": "LIGHT"',
	});
	expect(result.success).toBe(false);
	expect(result.error).toContain("branding");
	expect(store.frames[0].content).toBe(original);
	expect(store.history).toHaveLength(0);
});

it("refuses string edits after a generated report becomes inaccessible", async () => {
	const { editFrameString } = await import(
		"../prisma/queries/frame-edit-history"
	);
	store.frames[0].sourceRunType = "REPORT_EXECUTION";
	store.frames[0].sourceRunId = "example-inaccessible-execution";
	const before = store.frames[0].content;
	const result = await editFrameString({
		frameId: "frame-1",
		userId: USER,
		organizationId: ORG,
		oldString: "v1",
		newString: "v2",
	});
	expect(result).toMatchObject({ success: false, error: "Frame not found" });
	expect(store.frames[0].content).toBe(before);
	expect(store.history).toHaveLength(0);
});

it("retains interface presentation when an older writer omits it and records explicit switches in history", async () => {
	const before = JSON.parse(String(store.frames[0].content));
	before.presentation = "INTERFACE";
	before.metadata.runtime = { tools: ["fabric_list_projects"] };
	store.frames[0].content = JSON.stringify(before, null, 2);
	await updateFrame({
		id: "frame-1",
		userId: USER,
		organizationId: ORG,
		title: "Renamed",
	});
	expect(JSON.parse(String(store.frames[0].content))).toMatchObject({
		presentation: "INTERFACE",
		metadata: before.metadata,
	});
	await updateFrame({
		id: "frame-1",
		userId: USER,
		organizationId: ORG,
		presentation: "DOCUMENT",
	});
	expect(JSON.parse(String(store.frames[0].content)).presentation).toBe(
		"DOCUMENT",
	);
	expect(
		JSON.parse(String(store.history[1].contentSnapshot)).presentation,
	).toBe("INTERFACE");
});
it("keeps presentation omitted on legacy content edits", async () => {
	await updateFrame({
		id: "frame-1",
		userId: USER,
		organizationId: ORG,
		title: "Legacy renamed",
	});
	expect(JSON.parse(String(store.frames[0].content))).not.toHaveProperty(
		"presentation",
	);
});
