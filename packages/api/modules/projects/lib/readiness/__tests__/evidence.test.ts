/**
 * How the evidence bundle is DERIVED from the database (Fizzy #2165).
 *
 * These exist because the level tests could not catch the bug they were written
 * for. Those assert what happens *given* `repositoryConnected: true`; the defect
 * was in deciding that flag in the first place — `Project.repositoryUrl` is the
 * legacy column and is null on any project attached through
 * `ProjectRepositoryIntegration`, so a project with an obvious codebase reported
 * "not connected", and Atlas, security and release notes silently vanished with
 * it because all three depend on that item.
 *
 * Verified by reverting the fix and watching these fail — which the level tests
 * did not.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDb, mockIsFeatureEnabled } = vi.hoisted(() => ({
	mockIsFeatureEnabled: vi.fn(),
	mockDb: {
		project: { findUnique: vi.fn() },
		projectContext: { groupBy: vi.fn(), count: vi.fn(), findMany: vi.fn() },
		projectDocument: { groupBy: vi.fn(), findMany: vi.fn() },
		projectMember: { count: vi.fn() },
		userStory: { count: vi.fn() },
		projectScan: { findFirst: vi.fn() },
		newsletterSettings: { findUnique: vi.fn() },
		atlasAnalysis: { findFirst: vi.fn() },
		projectRepositoryIntegration: { count: vi.fn() },
		projectCodeIndex: { findFirst: vi.fn() },
		projectLinkedSlackChannel: { count: vi.fn() },
		projectLinkedTeamsChannel: { count: vi.fn() },
		projectLinkedTeamsChat: { count: vi.fn() },
		// The three tables the CLI-connection fact reads (Fizzy #2457, R2):
		// the reach records, which anchor the question, and the two key tables
		// asked for each reached credential's continued life.
		//
		// FIXTURE: the reach records used to ride in on the project row as a
		// nested select and are now a lookup of their own, so tests drive them
		// through this mock rather than through `project.findUnique`. That is
		// the point of the change — a gated-off organization must not touch
		// this table at all, which a nested select made impossible.
		organizationCliReach: { findMany: vi.fn() },
		userApiKey: { findFirst: vi.fn() },
		organizationApiKey: { findFirst: vi.fn() },
	},
}));

vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	db: mockDb,
	// The CLI-connection rollout gate, which the gather resolves for itself
	// (Fizzy #2457, R16). Mocked rather than left real because the real one
	// reads a table this mock db does not carry and degrades to the flag's
	// registry default — which is OFF, and would silently skip every one of the
	// three reads the CLI cases below are about.
	isFeatureEnabled: (...args: unknown[]) => mockIsFeatureEnabled(...args),
}));

import { gatherReadinessEvidence } from "../evidence";

/** A project row with nothing configured, including no legacy repository. */
function projectRow(overrides: Record<string, unknown> = {}) {
	return {
		userId: "u1",
		organizationId: null,
		// FIXTURE: the gather now reads the project's name and status off this
		// same row rather than leaving the read path to fetch it again.
		name: "Example project",
		status: "ACTIVE",
		projectPhase: null,
		expectedDevelopmentStartDate: null,
		features: [],
		techStack: [],
		projectManagementMcpServerId: null,
		autoPushPmSync: false,
		readOnlyMode: false,
		pmAutoCloseEnabled: false,
		pmTerminalStatuses: [],
		teamsChannelMonitorEnabled: false,
		teamsChatMonitorEnabled: false,
		slackChannelMonitorEnabled: false,
		meetingTranscriptAutoAnalyzeEnabled: false,
		repositoryUrl: null,
		codeAnalysisStatus: null,
		...overrides,
	};
}

/**
 * Put a project in an organization that holds the given CLI reach records.
 *
 * FIXTURE: the records are no longer part of the project row — they are their
 * own read now — so this stubs both mocks together. `organizationId: null` on
 * the bare row is the unresolved-tenant case, where there is no organization
 * to ask about.
 */
function organizationRow(
	cliReaches: { credentialKind: string; credentialId: string }[],
	organizationId = "org1",
) {
	mockDb.organizationCliReach.findMany.mockResolvedValue(cliReaches);
	return projectRow({ organizationId });
}

const userReach = (credentialId: string) => ({
	credentialKind: "USER_API_KEY",
	credentialId,
});
const organizationReach = (credentialId: string) => ({
	credentialKind: "ORGANIZATION_API_KEY",
	credentialId,
});

beforeEach(() => {
	vi.clearAllMocks();
	// The rollout gate is ON unless a test says otherwise: with it off the CLI
	// evidence is deliberately never read at all.
	mockIsFeatureEnabled.mockResolvedValue(true);
	mockDb.project.findUnique.mockResolvedValue(projectRow());
	mockDb.projectContext.groupBy.mockResolvedValue([]);
	mockDb.projectContext.count.mockResolvedValue(0);
	mockDb.projectContext.findMany.mockResolvedValue([]);
	mockDb.projectDocument.groupBy.mockResolvedValue([]);
	// Nothing generating, indexing or scanning unless a test says so.
	mockDb.projectDocument.findMany.mockResolvedValue([]);
	mockDb.projectMember.count.mockResolvedValue(0);
	mockDb.userStory.count.mockResolvedValue(0);
	mockDb.projectScan.findFirst.mockResolvedValue(null);
	mockDb.newsletterSettings.findUnique.mockResolvedValue(null);
	mockDb.atlasAnalysis.findFirst.mockResolvedValue(null);
	mockDb.projectRepositoryIntegration.count.mockResolvedValue(0);
	mockDb.projectCodeIndex.findFirst.mockResolvedValue(null);
	mockDb.projectLinkedSlackChannel.count.mockResolvedValue(0);
	mockDb.projectLinkedTeamsChannel.count.mockResolvedValue(0);
	mockDb.projectLinkedTeamsChat.count.mockResolvedValue(0);
	// No credential has ever reached, and none survives, unless a test says so.
	mockDb.organizationCliReach.findMany.mockResolvedValue([]);
	mockDb.userApiKey.findFirst.mockResolvedValue(null);
	mockDb.organizationApiKey.findFirst.mockResolvedValue(null);
});

describe("gatherReadinessEvidence — documents in flight", () => {
	/**
	 * A generation that is waiting on its dependencies is QUEUED, not
	 * GENERATING, and the wait can last an hour. Reading only GENERATING left a
	 * queued document reading as neither ready nor in progress — the checklist
	 * offering to create a document that is already on its way.
	 */
	it("counts a QUEUED document as in flight", async () => {
		mockDb.projectDocument.findMany.mockResolvedValue([{ type: "prd" }]);

		const result = await gatherReadinessEvidence("p1");

		expect(result?.evidence.inFlight.documentTypes.has("prd")).toBe(true);
		expect(mockDb.projectDocument.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					status: { in: ["QUEUED", "GENERATING"] },
				}),
			}),
		);
	});

	/**
	 * The other half: a queued RE-run must not drop the document the project
	 * already has, for the same reason a GENERATING one must not.
	 */
	it("keeps a queued re-run that still holds content in the completed set", async () => {
		await gatherReadinessEvidence("p1");

		const [{ where }] = mockDb.projectDocument.groupBy.mock.calls[0];
		expect(where.OR).toContainEqual({
			status: { in: ["QUEUED", "GENERATING", "FAILED"] },
			content: { not: "" },
		});
	});
});

describe("gatherReadinessEvidence — codebase connection", () => {
	it("counts an ACTIVE repository integration as a connected codebase", async () => {
		mockDb.projectRepositoryIntegration.count.mockResolvedValue(1);

		const result = await gatherReadinessEvidence("p1");

		expect(result?.evidence.code.repositoryConnected).toBe(true);
	});

	it("only counts ACTIVE integrations", async () => {
		// A token-expired or disconnected integration is a codebase Fabric cannot
		// currently read, which is what the checklist item is really asking.
		await gatherReadinessEvidence("p1");

		expect(mockDb.projectRepositoryIntegration.count).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ status: "ACTIVE" }),
			}),
		);
	});

	it("still honours the legacy column so older projects do not regress", async () => {
		mockDb.project.findUnique.mockResolvedValue(
			projectRow({ repositoryUrl: "https://github.com/example/repo" }),
		);

		const result = await gatherReadinessEvidence("p1");

		expect(result?.evidence.code.repositoryConnected).toBe(true);
	});

	it("reports no codebase when neither path has one", async () => {
		const result = await gatherReadinessEvidence("p1");

		expect(result?.evidence.code.repositoryConnected).toBe(false);
	});
});

describe("gatherReadinessEvidence — codebase analysis", () => {
	it("counts a completed full index as analysis done", async () => {
		mockDb.projectCodeIndex.findFirst.mockResolvedValue({ id: "idx1" });

		const result = await gatherReadinessEvidence("p1");

		expect(result?.evidence.code.analysisCompleted).toBe(true);
	});

	it("keys on a completed full index, not on current status", async () => {
		// Status flips to INDEXING on every refresh. Keying on it would make a
		// long-satisfied item blink back to incomplete each time the repository
		// re-indexes, which is how Fabric- Main looked when this was wrong.
		await gatherReadinessEvidence("p1");

		expect(mockDb.projectCodeIndex.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					lastFullIndexAt: { not: null },
				}),
			}),
		);
	});

	it("still honours the legacy codeAnalysisStatus column", async () => {
		mockDb.project.findUnique.mockResolvedValue(
			projectRow({ codeAnalysisStatus: "COMPLETED" }),
		);

		const result = await gatherReadinessEvidence("p1");

		expect(result?.evidence.code.analysisCompleted).toBe(true);
	});

	it("reports analysis incomplete when neither signal is present", async () => {
		const result = await gatherReadinessEvidence("p1");

		expect(result?.evidence.code.analysisCompleted).toBe(false);
	});
});

/**
 * A document a re-run is working on (Fizzy #2165).
 *
 * Regeneration mutates the same row — GENERATING while it runs, FAILED if it
 * dies — so a status-only read dropped a PRD the project plainly had the moment
 * its owner hit Refresh, and left it dropped when the run failed at the model's
 * output-token limit. Reported from staging with the checklist offering "Create
 * PRD" beside a Documents tab showing one.
 *
 * These assert which rows the read SELECTS rather than restating its shape: the
 * `where` the code actually passed is applied to plain rows below.
 */
interface DocumentRow {
	status: string;
	content: string;
	isActive: boolean;
}

type WhereClause = Record<string, unknown>;

/** Understands only the operators this read uses: `in`, `not`, and `OR`. */
function clauseMatches(clause: WhereClause, row: DocumentRow): boolean {
	return Object.entries(clause).every(([field, condition]) => {
		if (field === "OR") {
			return (condition as WhereClause[]).some((branch) =>
				clauseMatches(branch, row),
			);
		}
		if (!(field in row)) {
			// Scoping fields a document row of this fixture does not model.
			return true;
		}
		const value = row[field as keyof DocumentRow];
		if (condition !== null && typeof condition === "object") {
			const operator = condition as { in?: unknown[]; not?: unknown };
			if (operator.in) {
				return operator.in.includes(value);
			}
			if ("not" in operator) {
				return value !== operator.not;
			}
		}
		return value === condition;
	});
}

async function documentReadSelects(row: DocumentRow): Promise<boolean> {
	await gatherReadinessEvidence("p1");
	const call = mockDb.projectDocument.groupBy.mock.calls.at(0)?.[0] as
		| { where: WhereClause }
		| undefined;
	if (!call) {
		throw new Error("the document read was never issued");
	}
	return clauseMatches(call.where, row);
}

describe("gatherReadinessEvidence — documents under a re-run", () => {
	it("counts a document being regenerated, whose previous content is still there", async () => {
		expect(
			await documentReadSelects({
				status: "GENERATING",
				content: "# Product Requirements\n...",
				isActive: true,
			}),
		).toBe(true);
	});

	it("counts a document whose re-run failed", async () => {
		// The failure wrote a status and an error. It did not take away the
		// version already on the row, which retrieval still reads.
		expect(
			await documentReadSelects({
				status: "FAILED",
				content: "# Product Requirements\n...",
				isActive: true,
			}),
		).toBe(true);
	});

	it("does not count a first generation that has produced nothing yet", async () => {
		// The create route writes the row empty for the run to fill. This is
		// precisely when the item should read In Progress, not done.
		expect(
			await documentReadSelects({
				status: "GENERATING",
				content: "",
				isActive: true,
			}),
		).toBe(false);
	});

	it("does not count a first generation that failed", async () => {
		expect(
			await documentReadSelects({
				status: "FAILED",
				content: "",
				isActive: true,
			}),
		).toBe(false);
	});

	it("still counts a finished document", async () => {
		expect(
			await documentReadSelects({
				status: "COMPLETE",
				content: "# Product Requirements\n...",
				isActive: true,
			}),
		).toBe(true);
	});

	it("still ignores a draft that no run has ever completed", async () => {
		// Widening the status list instead of adding the branch would have
		// started counting these, which no rule asks for.
		expect(
			await documentReadSelects({
				status: "DRAFT",
				content: "# Notes\n...",
				isActive: true,
			}),
		).toBe(false);
	});

	it("keys the re-run branch on content, the column that survives a failure", async () => {
		await gatherReadinessEvidence("p1");

		// Named explicitly: the matcher above skips fields a row does not model,
		// so a mistyped column here would otherwise select nothing and still
		// satisfy every assertion in this block.
		const branches = (
			mockDb.projectDocument.groupBy.mock.calls.at(0)?.[0] as {
				where: { OR: WhereClause[] };
			}
		).where.OR;

		expect(branches).toContainEqual(
			expect.objectContaining({ content: { not: "" } }),
		);
	});

	it("still ignores a document that has been stood down", async () => {
		expect(
			await documentReadSelects({
				status: "COMPLETE",
				content: "# Product Requirements\n...",
				isActive: false,
			}),
		).toBe(false);
	});
});

describe("gatherReadinessEvidence — a linked chat channel is a connected chat app", () => {
	it("counts Slack, Teams channels and Teams chats together", async () => {
		mockDb.projectLinkedSlackChannel.count.mockResolvedValue(1);
		mockDb.projectLinkedTeamsChannel.count.mockResolvedValue(2);
		mockDb.projectLinkedTeamsChat.count.mockResolvedValue(3);

		const result = await gatherReadinessEvidence("p1");

		expect(result?.evidence.chat.linkedChannelCount).toBe(6);
	});

	it("counts a linked channel whose monitor is switched off", async () => {
		// The regression this rule was changed for: a channel is linked, the
		// auto-monitor toggle is off, and the checklist reported no chat app.
		mockDb.project.findUnique.mockResolvedValue(
			projectRow({ slackChannelMonitorEnabled: false }),
		);
		mockDb.projectLinkedSlackChannel.count.mockResolvedValue(1);

		const result = await gatherReadinessEvidence("p1");

		expect(result?.evidence.chat.linkedChannelCount).toBe(1);
		expect(result?.evidence.chat.slackChannelMonitorEnabled).toBe(false);
	});

	it("does not invent a channel from an enabled monitor", async () => {
		mockDb.project.findUnique.mockResolvedValue(
			projectRow({ slackChannelMonitorEnabled: true }),
		);

		const result = await gatherReadinessEvidence("p1");

		expect(result?.evidence.chat.linkedChannelCount).toBe(0);
	});

	it("scopes every count to this project", async () => {
		await gatherReadinessEvidence("p1");

		for (const model of [
			mockDb.projectLinkedSlackChannel,
			mockDb.projectLinkedTeamsChannel,
			mockDb.projectLinkedTeamsChat,
		]) {
			expect(model.count).toHaveBeenCalledWith({
				where: { projectId: "p1" },
			});
		}
	});
});

/**
 * Is a CLI reaching this organization right now (Fizzy #2457, R2)?
 *
 * The whole point of the split these assert: reach is REMEMBERED, connectivity
 * is CHECKED. A record proves a credential once reached the organization and
 * never stops being true, so the boolean can only come from asking whether any
 * of those credentials is still alive. Anything that re-derived it from the key
 * tables alone answered a different question — "does a key exist" — which is
 * true of every organization that ever visited the settings page.
 */
describe("gatherReadinessEvidence — the organization's CLI connection", () => {
	/** The reach lookups' `where`, per key kind, from the last gather. */
	const userKeyWhere = () =>
		mockDb.userApiKey.findFirst.mock.calls[0][0].where;
	const organizationKeyWhere = () =>
		mockDb.organizationApiKey.findFirst.mock.calls[0][0].where;

	describe("a live credential is what connects an organization", () => {
		it("reads connected when a reached personal key is still alive", async () => {
			mockDb.project.findUnique.mockResolvedValue(
				organizationRow([userReach("k1")]),
			);
			mockDb.userApiKey.findFirst.mockResolvedValue({ id: "k1" });

			const result = await gatherReadinessEvidence("p1");

			expect(result?.evidence.organizationCliConnected).toBe(true);
		});

		it("reads connected when a reached organization key is still alive", async () => {
			mockDb.project.findUnique.mockResolvedValue(
				organizationRow([organizationReach("ok1")]),
			);
			mockDb.organizationApiKey.findFirst.mockResolvedValue({
				id: "ok1",
			});

			const result = await gatherReadinessEvidence("p1");

			expect(result?.evidence.organizationCliConnected).toBe(true);
		});

		/**
		 * AE17. A key that exists has not necessarily connected — this is the
		 * distinction the whole record table exists to keep. With no record
		 * there is nothing to ask about, so neither key table is consulted at
		 * all and a shelf full of unused keys still reads disconnected.
		 */
		it("reads disconnected for an organization no credential has reached", async () => {
			mockDb.project.findUnique.mockResolvedValue(organizationRow([]));

			const result = await gatherReadinessEvidence("p1");

			expect(result?.evidence.organizationCliConnected).toBe(false);
			expect(mockDb.userApiKey.findFirst).not.toHaveBeenCalled();
			expect(mockDb.organizationApiKey.findFirst).not.toHaveBeenCalled();
		});

		/**
		 * AE25. Nothing in the read looks at when the credential last called.
		 * A team that connected once and then went quiet is still connected —
		 * the record decays only with the credential's own death, never with
		 * time.
		 */
		it("does not decay a reach record with time", async () => {
			mockDb.project.findUnique.mockResolvedValue(
				organizationRow([userReach("k1")]),
			);
			mockDb.userApiKey.findFirst.mockResolvedValue({ id: "k1" });

			const result = await gatherReadinessEvidence("p1");

			expect(result?.evidence.organizationCliConnected).toBe(true);
			const where = JSON.stringify(userKeyWhere());
			expect(where).not.toContain("lastReachedAt");
			expect(where).not.toContain("firstReachedAt");
			expect(where).not.toContain("lastUsedAt");
		});
	});

	describe("the four ways a credential dies", () => {
		/**
		 * AE14, and the reason `credentialId` carries no foreign key: an
		 * organization key is HARD-deleted by the revoke path, so the record
		 * outlives it. The absent row is the revocation, and an id-list lookup
		 * reports it by simply not matching.
		 */
		it("treats a hard-deleted key row as dead, for both kinds", async () => {
			mockDb.project.findUnique.mockResolvedValue(
				organizationRow([
					userReach("gone"),
					organizationReach("gone2"),
				]),
			);
			// Both rows have been deleted out from under their records.
			mockDb.userApiKey.findFirst.mockResolvedValue(null);
			mockDb.organizationApiKey.findFirst.mockResolvedValue(null);

			const result = await gatherReadinessEvidence("p1");

			expect(result?.evidence.organizationCliConnected).toBe(false);
			expect(userKeyWhere().id).toEqual({ in: ["gone"] });
			expect(organizationKeyWhere().id).toEqual({ in: ["gone2"] });
		});

		it("asks only for an active key", async () => {
			mockDb.project.findUnique.mockResolvedValue(
				organizationRow([userReach("k1"), organizationReach("ok1")]),
			);

			await gatherReadinessEvidence("p1");

			expect(userKeyWhere().isActive).toBe(true);
			expect(organizationKeyWhere().isActive).toBe(true);
		});

		it("asks only for an unexpired key, counting a null expiry as never expiring", async () => {
			mockDb.project.findUnique.mockResolvedValue(
				organizationRow([userReach("k1"), organizationReach("ok1")]),
			);

			await gatherReadinessEvidence("p1");

			for (const where of [userKeyWhere(), organizationKeyWhere()]) {
				expect(where.OR).toContainEqual({ expiresAt: null });
				const future = where.OR.find(
					(clause: { expiresAt?: { gt?: Date } }) =>
						clause.expiresAt?.gt instanceof Date,
				);
				expect(future).toBeDefined();
			}
		});

		/**
		 * AE14's third death. Both MCP hosts re-read membership on every
		 * request and answer 401 without it, so a key whose owner has left is a
		 * key that can no longer reach anything — the personal key through its
		 * holder, the organization key through the person who created it.
		 */
		it("asks that the key's owner still holds membership of this organization", async () => {
			mockDb.project.findUnique.mockResolvedValue(
				organizationRow([userReach("k1"), organizationReach("ok1")]),
			);

			await gatherReadinessEvidence("p1");

			const membership = {
				members: { some: { organizationId: "org1" } },
			};
			expect(userKeyWhere().user).toEqual(membership);
			expect(organizationKeyWhere().createdBy).toEqual(membership);
		});

		/** One survivor is enough — a dead credential beside it changes nothing. */
		it("stays connected when one of two credentials survives", async () => {
			mockDb.project.findUnique.mockResolvedValue(
				organizationRow([
					userReach("dead"),
					organizationReach("alive"),
				]),
			);
			mockDb.userApiKey.findFirst.mockResolvedValue(null);
			mockDb.organizationApiKey.findFirst.mockResolvedValue({
				id: "alive",
			});

			const result = await gatherReadinessEvidence("p1");

			expect(result?.evidence.organizationCliConnected).toBe(true);
		});
	});

	describe("the question is scoped to this organization", () => {
		/**
		 * AE10. An organization key issued for a DIFFERENT organization writes
		 * its record against that other one, so this organization never sees
		 * the credential: its ids are the only ones asked about, and the
		 * membership clause names this organization rather than any other.
		 */
		it("never asks about a credential that reached a different organization", async () => {
			mockDb.project.findUnique.mockResolvedValue(
				organizationRow([userReach("ours")], "org-here"),
			);
			mockDb.userApiKey.findFirst.mockResolvedValue(null);

			const result = await gatherReadinessEvidence("p1");

			expect(result?.evidence.organizationCliConnected).toBe(false);
			expect(userKeyWhere().id).toEqual({ in: ["ours"] });
			expect(userKeyWhere().user).toEqual({
				members: { some: { organizationId: "org-here" } },
			});
		});

		/**
		 * R24. A project with no organization is a fail-closed default reached
		 * only when something failed to resolve a tenant — a defect to log, not
		 * a context to support. It answers false without asking anything.
		 */
		it("reads disconnected and issues no lookup for a project with no organization", async () => {
			mockDb.project.findUnique.mockResolvedValue(projectRow());

			const result = await gatherReadinessEvidence("p1");

			expect(result?.evidence.organizationCliConnected).toBe(false);
			// The reach records included: there is no organization to ask
			// about, so the question is not put to any of the three tables.
			expect(mockDb.organizationCliReach.findMany).not.toHaveBeenCalled();
			expect(mockDb.userApiKey.findFirst).not.toHaveBeenCalled();
			expect(mockDb.organizationApiKey.findFirst).not.toHaveBeenCalled();
		});
	});

	describe("the read is bounded", () => {
		/**
		 * The cost the plan holds the gather to: one lookup per key kind, each
		 * carrying an id list bounded by how many credentials have ever reached
		 * this organization. Nothing fans out per record, and nothing here
		 * grows with the member count — membership is a predicate on the key
		 * row, not a list to enumerate.
		 */
		it("adds exactly two queries however many records the organization holds", async () => {
			const many = [
				...Array.from({ length: 40 }, (_, i) => userReach(`k${i}`)),
				...Array.from({ length: 40 }, (_, i) =>
					organizationReach(`o${i}`),
				),
			];
			mockDb.project.findUnique.mockResolvedValue(organizationRow(many));

			await gatherReadinessEvidence("p1");

			expect(mockDb.userApiKey.findFirst).toHaveBeenCalledTimes(1);
			expect(mockDb.organizationApiKey.findFirst).toHaveBeenCalledTimes(
				1,
			);
			expect(userKeyWhere().id.in).toHaveLength(40);
			expect(organizationKeyWhere().id.in).toHaveLength(40);
		});

		/** Each id goes to the table its kind names — the id alone identifies nothing. */
		it("splits the credential ids by the table they live in", async () => {
			mockDb.project.findUnique.mockResolvedValue(
				organizationRow([
					userReach("personal"),
					organizationReach("shared"),
				]),
			);

			await gatherReadinessEvidence("p1");

			expect(userKeyWhere().id).toEqual({ in: ["personal"] });
			expect(organizationKeyWhere().id).toEqual({ in: ["shared"] });
		});

		it("does not ask a key table no record points at", async () => {
			mockDb.project.findUnique.mockResolvedValue(
				organizationRow([userReach("personal")]),
			);

			await gatherReadinessEvidence("p1");

			expect(mockDb.userApiKey.findFirst).toHaveBeenCalledTimes(1);
			expect(mockDb.organizationApiKey.findFirst).not.toHaveBeenCalled();
		});

		/**
		 * ...and so is the record read itself.
		 *
		 * The table only grows: every distinct credential that ever reaches
		 * MCP leaves a permanent row, nothing prunes them, and key creation
		 * carries no cap. Unbounded, one member could mint-call-abandon in a
		 * loop and make every readiness read for every project in the
		 * organization materialise a list they control.
		 */
		it("bounds the record read and takes the most recently active first", async () => {
			mockDb.project.findUnique.mockResolvedValue(
				organizationRow([userReach("k1")]),
			);

			await gatherReadinessEvidence("p1");

			// Pinned rather than compared loosely: the bound is a judgement
			// call with a stated cost (see CLI_REACH_READ_LIMIT), so moving it
			// should make someone read that reasoning again.
			expect(
				mockDb.organizationCliReach.findMany.mock.calls[0][0],
			).toMatchObject({
				where: { organizationId: "org1" },
				orderBy: { lastReachedAt: "desc" },
				take: 100,
			});
		});

		/**
		 * The bound, as the database would actually apply it.
		 *
		 * The honest cost of this, written down where it is visible: an
		 * organization holding more dead-but-newer credentials than the bound,
		 * plus one live credential older than all of them, reads as
		 * disconnected. Acceptable because this answer drives a NUDGE and not
		 * an authorization decision — nothing is granted or refused by it.
		 */
		it("considers at most the bound, newest-first, however many records exist", async () => {
			// Newest first, as the read's own `orderBy` asks for.
			const newestFirst = Array.from({ length: 250 }, (_, i) =>
				userReach(`k${i}`),
			);
			mockDb.project.findUnique.mockResolvedValue(
				projectRow({
					organizationId: "org1",
				}),
			);
			// Stands in for the database honouring the bound and the order the
			// read asked for, which a plain `mockResolvedValue` cannot.
			mockDb.organizationCliReach.findMany.mockImplementation(
				async (args: { take?: number }) =>
					newestFirst.slice(0, args.take),
			);

			await gatherReadinessEvidence("p1");

			const ids: string[] = userKeyWhere().id.in;
			expect(ids).toHaveLength(100);
			// The newest survived the cut; the oldest did not.
			expect(ids).toContain("k0");
			expect(ids).not.toContain("k249");
		});
	});
});

/**
 * The rollout gate, resolved by the gather itself (Fizzy #2457, R16).
 *
 * It lives here rather than in the read path for one reason: it decides whether
 * the CLI evidence is worth reading at all. `CLI_CONNECTION_NUDGE` is off by
 * default and rolls out one organization at a time, so "off" is the state of
 * essentially the whole platform — and everything the feature reads was being
 * issued and then discarded there.
 */
describe("gatherReadinessEvidence — the CLI rollout gate", () => {
	it("resolves the gate against the project's organization, not globally", async () => {
		// The mistake this catches is copying the readiness gate's own call,
		// which passes no organization: the resolver only consults an
		// organization override when it is given one, so that copy would turn a
		// per-organization rollout into a deployment-wide switch.
		mockDb.project.findUnique.mockResolvedValue(
			organizationRow([userReach("k1")]),
		);

		await gatherReadinessEvidence("p1");

		expect(mockIsFeatureEnabled).toHaveBeenCalledWith(
			"CLI_CONNECTION_NUDGE",
			"org1",
		);
	});

	it("asks neither key table when the gate is off for the organization", async () => {
		// A live credential is sitting right there; the point is that nobody
		// looks. The row is withheld from the checklist when the gate is off,
		// so the answer could only ever have been thrown away.
		mockIsFeatureEnabled.mockResolvedValue(false);
		mockDb.project.findUnique.mockResolvedValue(
			organizationRow([userReach("k1"), organizationReach("ok1")]),
		);
		mockDb.userApiKey.findFirst.mockResolvedValue({ id: "k1" });

		const result = await gatherReadinessEvidence("p1");

		expect(mockDb.userApiKey.findFirst).not.toHaveBeenCalled();
		expect(mockDb.organizationApiKey.findFirst).not.toHaveBeenCalled();
		// Reported as "no connection is being claimed", which is what the
		// withheld row means — never as "this organization has no credential".
		expect(result?.evidence.organizationCliConnected).toBe(false);
	});

	/**
	 * What "off" has to mean for the rollout to be worth anything (R16).
	 *
	 * Not "the answer is discarded" — "the work does not happen". The reach
	 * records used to ride in on the project's own row as a nested select,
	 * which made every readiness read and every mutation that gathers evidence
	 * require `organization_cli_reach` to exist, for every organization, gate
	 * or no gate. Ship the application ahead of its migration, or sit in any
	 * mixed-version window, and the ENTIRE readiness surface fails rather than
	 * one row going missing.
	 *
	 * So these assert on the query mocks and not on the returned value. The
	 * value was already correct; the queries were the defect.
	 */
	it("reads the reach records by no route when the gate is off", async () => {
		mockIsFeatureEnabled.mockResolvedValue(false);
		mockDb.project.findUnique.mockResolvedValue(
			organizationRow([userReach("k1"), organizationReach("ok1")]),
		);

		await gatherReadinessEvidence("p1");

		// Not as a lookup of their own...
		expect(mockDb.organizationCliReach.findMany).not.toHaveBeenCalled();
		// ...and not smuggled in on the project's row either, which is the
		// specific regression: a nested select there is still a read of the new
		// table, and it is issued BEFORE the gate has even been resolved.
		const { select } = mockDb.project.findUnique.mock.calls[0][0];
		expect(select).not.toHaveProperty("organization");
		expect(JSON.stringify(select)).not.toContain("cliReaches");
	});

	it("reports the gate, so the read path does not resolve it a second time", async () => {
		mockDb.project.findUnique.mockResolvedValue(organizationRow([]));

		expect((await gatherReadinessEvidence("p1"))?.cliNudgeEnabled).toBe(
			true,
		);

		mockIsFeatureEnabled.mockResolvedValue(false);
		expect((await gatherReadinessEvidence("p1"))?.cliNudgeEnabled).toBe(
			false,
		);
	});
});

/**
 * The project's own non-rule facts.
 *
 * They ride back on the tenancy side channel rather than on the evidence
 * bundle, and they ride on the row the gather has already read: asking for them
 * separately cost a second `findUnique` by the same primary key on every
 * readiness read, and readiness is polled.
 */
describe("gatherReadinessEvidence — the project's own facts", () => {
	it("carries the name and status back beside the evidence", async () => {
		mockDb.project.findUnique.mockResolvedValue(
			projectRow({ name: "Example project", status: "ARCHIVED" }),
		);

		const result = await gatherReadinessEvidence("p1");

		expect(result?.project).toEqual({
			name: "Example project",
			status: "ARCHIVED",
		});
	});

	it("selects them on the one read, and reads the project row only once", async () => {
		await gatherReadinessEvidence("p1");

		expect(mockDb.project.findUnique).toHaveBeenCalledTimes(1);
		expect(mockDb.project.findUnique.mock.calls[0][0]).toMatchObject({
			where: { id: "p1" },
			select: expect.objectContaining({ name: true, status: true }),
		});
	});

	it("keeps them out of the evidence the rules receive", async () => {
		// No rule grades a project on being active or on what it is called, and
		// a field on the evidence bundle is an invitation for one to start.
		const result = await gatherReadinessEvidence("p1");

		expect(result?.evidence).not.toHaveProperty("status");
		expect(result?.evidence).not.toHaveProperty("name");
	});
});
