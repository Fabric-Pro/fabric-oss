/**
 * `organizations.companyContext.noticeState` (Fizzy #2719).
 *
 * The answer must be no oracle: a caller who cannot read the project, a
 * project guest, the gate off, and an organization with a ready source all
 * read `hidden`, byte for byte. Only an organization member who can read the
 * project hears `empty` or `notReady`, and "ready" is the retrieval predicate
 * under the organization's CURRENT embedding model.
 *
 * Project access runs through the real `assertProjectPermission`, against
 * mocked project, project-member and organization-member rows.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () =>
	(await import("./support/harness")).databaseModule(),
);
vi.mock("@repo/temporal", async () =>
	(await import("./support/harness")).temporalModule(),
);
vi.mock("@repo/rag", async () =>
	(await import("./support/harness")).ragModule(),
);
vi.mock("@repo/ai", async () => (await import("./support/harness")).aiModule());
vi.mock("@repo/storage", async () =>
	(await import("./support/harness")).storageModule(),
);
vi.mock("@repo/utils", async (importOriginal) =>
	(await import("./support/harness")).utilsModule(importOriginal),
);
vi.mock("@repo/logs", async () =>
	(await import("./support/harness")).logsModule(),
);
vi.mock("@repo/config", async () =>
	(await import("./support/harness")).configModule(),
);
vi.mock("../../../../../lib/audit", async () =>
	(await import("./support/harness")).auditModule(),
);
vi.mock("../../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: <T>(options: T) => options,
}));
vi.mock("../../../../../orpc/procedures", async () =>
	(await import("./support/harness")).proceduresModule(),
);

import { getCompanyContextNoticeStateProcedure } from "../notice-state";
import {
	CURRENT_MODEL,
	call,
	FakeAIProviderNotConfiguredError,
	mocks,
	ORG,
	OTHER_PROJECT,
	PROJECT,
	resetDefaults,
} from "./support/harness";

function noticeState(userId: string, projectId = PROJECT) {
	return call(getCompanyContextNoticeStateProcedure, { projectId }, userId);
}

const HIDDEN = { state: "hidden" };

beforeEach(() => {
	resetDefaults();
});

describe("the answers a member can get", () => {
	it("is empty when the organization has no company source", async () => {
		mocks.getCompanyContextReadiness.mockResolvedValue({
			total: 0,
			ready: 0,
		});

		expect(await noticeState("u_member")).toEqual({ state: "empty" });
		expect(mocks.getCompanyContextReadiness).toHaveBeenCalledWith(
			ORG,
			CURRENT_MODEL.identity,
		);
	});

	it("is notReady when sources exist but none is ready", async () => {
		mocks.getCompanyContextReadiness.mockResolvedValue({
			total: 3,
			ready: 0,
		});

		expect(await noticeState("u_member")).toEqual({ state: "notReady" });
	});

	it("is hidden once one source is ready", async () => {
		mocks.getCompanyContextReadiness.mockResolvedValue({
			total: 3,
			ready: 1,
		});

		expect(await noticeState("u_member")).toEqual(HIDDEN);
	});

	it("reads the project's organization, not the caller's active one", async () => {
		// u_member's session is organization A's; organization B's project is
		// answered for B only if they are a member of B.
		mocks.getCompanyContextReadiness.mockResolvedValue({
			total: 0,
			ready: 0,
		});
		expect(await noticeState("u_b_admin", OTHER_PROJECT)).toEqual({
			state: "empty",
		});
		expect(mocks.isFeatureEnabled).toHaveBeenCalledWith(
			"COMPANY_CONTEXT",
			"org_b",
		);
	});

	it("with no embedding provider, sources exist but none is ready", async () => {
		mocks.resolveCompanyEmbeddingModel.mockRejectedValue(
			new FakeAIProviderNotConfiguredError(),
		);
		mocks.sourceCount.mockResolvedValue(2);

		expect(await noticeState("u_member")).toEqual({ state: "notReady" });
		expect(mocks.getCompanyContextReadiness).not.toHaveBeenCalled();
	});

	it("after the embedding model changes, sources embedded with the old one no longer count", async () => {
		// The readiness predicate is keyed on the model identity: under the old
		// model the source was ready, under the new one it is not.
		mocks.getCompanyContextReadiness.mockImplementation(
			async (_organizationId: string, model: string) =>
				model === "openai:text-embedding-ada-002"
					? { total: 1, ready: 1 }
					: { total: 1, ready: 0 },
		);
		mocks.resolveCompanyEmbeddingModel.mockResolvedValue({
			identity: "openai:text-embedding-ada-002",
			dimensions: 1536,
			supported: true,
		});
		expect(await noticeState("u_member")).toEqual(HIDDEN);

		mocks.resolveCompanyEmbeddingModel.mockResolvedValue(CURRENT_MODEL);
		expect(await noticeState("u_member")).toEqual({ state: "notReady" });
	});
});

describe("hidden is one answer for every case that must not be told apart", () => {
	beforeEach(() => {
		// Empty company context: the state a guest must not be able to detect.
		mocks.getCompanyContextReadiness.mockResolvedValue({
			total: 0,
			ready: 0,
		});
		mocks.sourceCount.mockResolvedValue(0);
	});

	it("answers a project guest exactly as the gate being off", async () => {
		const guest = await noticeState("u_guest");
		// The guest CAN read the project; it is the missing member row in its
		// organization that hides the answer.
		expect(mocks.resolveProjectTenant).toHaveBeenCalledWith(PROJECT);
		expect(mocks.getOrganizationMembership).toHaveBeenCalledWith(
			ORG,
			"u_guest",
		);

		mocks.isFeatureEnabled.mockResolvedValue(false);
		const gateOff = await noticeState("u_member");

		expect(guest).toEqual(HIDDEN);
		expect(gateOff).toEqual(HIDDEN);
		expect(JSON.stringify(guest)).toBe(JSON.stringify(gateOff));
		// The guest never reached the organization's company context at all.
		expect(mocks.getCompanyContextReadiness).not.toHaveBeenCalled();
		expect(mocks.sourceCount).not.toHaveBeenCalled();
	});

	it("answers a caller with no tie to the project the same way", async () => {
		expect(await noticeState("u_platform")).toEqual(HIDDEN);
		expect(await noticeState("u_b_admin")).toEqual(HIDDEN);
		expect(await noticeState("u_member", "proj_missing")).toEqual(HIDDEN);
		expect(mocks.isFeatureEnabled).not.toHaveBeenCalled();
		expect(mocks.getCompanyContextReadiness).not.toHaveBeenCalled();
	});

	it("answers a guest in X who administers Y the same way, for X's project", async () => {
		mocks.getOrganizationMembership.mockImplementation(
			async (organizationId: string, userId: string) =>
				organizationId === "org_b" && userId === "u_guest"
					? { role: "admin", organization: { id: "org_b" } }
					: null,
		);

		expect(await noticeState("u_guest")).toEqual(HIDDEN);
		expect(mocks.getCompanyContextReadiness).not.toHaveBeenCalled();
	});

	it("with the gate off, never reads company context", async () => {
		mocks.isFeatureEnabled.mockResolvedValue(false);

		expect(await noticeState("u_admin")).toEqual(HIDDEN);
		expect(mocks.isFeatureEnabled).toHaveBeenCalledWith(
			"COMPANY_CONTEXT",
			ORG,
		);
		expect(mocks.resolveCompanyEmbeddingModel).not.toHaveBeenCalled();
		expect(mocks.getCompanyContextReadiness).not.toHaveBeenCalled();
	});
});
