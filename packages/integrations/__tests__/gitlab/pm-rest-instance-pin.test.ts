/**
 * A PM call checks the caller's GitLab connection against the container's
 * instance once (`resolveGitLabPMSource`), and the REST half of the call
 * then reads the connection again (`executeGitLabTool` refreshes a token
 * GitLab refused). If the person reconnected to another instance in
 * between, that second read must not carry the container id and the
 * payload there: the REST call is pinned to the instance the source was
 * validated for (`expectedOrigin`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createGitLabFakeDb,
	encryptedCredential,
} from "./helpers/gitlab-fake-db";

const state = vi.hoisted(() => ({
	fake: null as unknown as ReturnType<
		typeof import("./helpers/gitlab-fake-db").createGitLabFakeDb
	>,
}));

vi.mock("@repo/database", () => ({
	get db() {
		return state.fake.db;
	},
	isPmServerIdKeySentinel: (id: string) => id.startsWith("key:"),
	readPmServerIdKeySentinel: (id: string) => id.slice("key:".length),
}));

vi.mock("@repo/database/prisma/queries/lib/refresh-lock", () => ({
	withRefreshLock: (
		keys: string | readonly string[],
		fn: (
			tx: unknown,
			assertBudget: (ms: number) => void,
		) => Promise<unknown>,
	) => state.fake.withLock(keys, fn as never),
}));

vi.mock("@repo/utils", async (importOriginal) => {
	const helpers = await import("./helpers/gitlab-fake-db");
	return {
		...(await importOriginal<object>()),
		decryptApiKey: helpers.fakeDecrypt,
		encryptApiKey: helpers.fakeEncrypt,
	};
});

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { resetGitLabConnectionDepsForTests } from "../../src/gitlab/index";
import {
	createGitLabIssueFromStory,
	GitLabPmOriginMismatchError,
	listGitLabIssuesForPM,
	resolveGitLabPMSource,
	updateGitLabIssueFromStory,
} from "../../src/gitlab/pm-adapter";

const USER = "user-1";
const ORG = "org-1";

function patRow(credential: Record<string, unknown>) {
	return {
		id: "wi-1",
		userId: USER,
		organizationId: ORG,
		provider: "GITLAB",
		name: "GitLab: dev",
		workflowId: null,
		credentials: encryptedCredential(credential),
		settings: {},
		isActive: true,
		createdAt: new Date("2026-01-01T00:00:00Z"),
		updatedAt: new Date("2026-01-01T00:00:00Z"),
	};
}

const ok = (body: unknown) => ({
	ok: true,
	status: 200,
	headers: new Headers({ "content-type": "application/json" }),
	json: async () => body,
});

/** The person reconnects GitLab with a token for a self-hosted instance. */
function reconnectToSelfHosted() {
	state.fake.tables.workflowIntegration[0] = patRow({
		apiToken: "self-hosted-token",
		GITLAB_URL: "https://gitlab.example.com",
	});
}

const CALLS = {
	create: (source: never) =>
		createGitLabIssueFromStory({
			source,
			gitlabProjectId: "42",
			payload: { title: "Checkout flow", description: "Story body" },
			userId: USER,
			organizationId: ORG,
		}),
	update: (source: never) =>
		updateGitLabIssueFromStory({
			source,
			gitlabProjectId: "42",
			externalId: "7",
			payload: { title: "Checkout flow" },
			userId: USER,
			organizationId: ORG,
		}),
	list: (source: never) =>
		listGitLabIssuesForPM({
			source,
			gitlabProjectId: "42",
			userId: USER,
			organizationId: ORG,
			page: 1,
			pageSize: 20,
		}),
};

beforeEach(() => {
	fetchMock.mockReset();
	resetGitLabConnectionDepsForTests();
	state.fake = createGitLabFakeDb({
		workflowIntegration: [patRow({ apiToken: "com-token" })],
	});
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("GitLab PM REST calls stay on the validated instance", () => {
	it.each(Object.entries(CALLS))(
		"%s: a reconnect to another instance after the check sends nothing there",
		async (_name, call) => {
			// Validated for a container chosen on gitlab.com.
			const source = await resolveGitLabPMSource({
				userId: USER,
				organizationId: ORG,
				pmAdditionalContext: null,
			});
			expect(source?.credential.apiBase).toBe(
				"https://gitlab.com/api/v4",
			);

			reconnectToSelfHosted();

			await expect(call(source as never)).rejects.toBeInstanceOf(
				GitLabPmOriginMismatchError,
			);
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it("sends the call to the validated instance when the connection is unchanged", async () => {
		const source = await resolveGitLabPMSource({
			userId: USER,
			organizationId: ORG,
			pmAdditionalContext: null,
		});
		fetchMock.mockResolvedValueOnce(
			ok({ iid: 7, web_url: "https://gitlab.com/g/p/-/issues/7" }),
		);

		await CALLS.create(source as never);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0][0])).toBe(
			"https://gitlab.com/api/v4/projects/42/issues",
		);
	});

	it("a create carries the caller's abort signal to the GitLab request (the PM create's send ceiling)", async () => {
		const source = await resolveGitLabPMSource({
			userId: USER,
			organizationId: ORG,
			pmAdditionalContext: null,
		});
		fetchMock.mockResolvedValueOnce(
			ok({ iid: 7, web_url: "https://gitlab.com/g/p/-/issues/7" }),
		);
		const controller = new AbortController();

		await createGitLabIssueFromStory({
			source: source as never,
			gitlabProjectId: "42",
			payload: { title: "Checkout flow", description: "Story body" },
			userId: USER,
			organizationId: ORG,
			signal: controller.signal,
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0][1]).toMatchObject({
			method: "POST",
			signal: controller.signal,
		});
	});

	it("a create whose signal has already fired sends nothing", async () => {
		const source = await resolveGitLabPMSource({
			userId: USER,
			organizationId: ORG,
			pmAdditionalContext: null,
		});
		// The fetch an aborted signal reaches rejects without sending.
		fetchMock.mockImplementation(
			async (_url: unknown, init?: RequestInit) => {
				init?.signal?.throwIfAborted();
				return ok({ iid: 7 });
			},
		);

		await expect(
			createGitLabIssueFromStory({
				source: source as never,
				gitlabProjectId: "42",
				payload: { title: "Checkout flow" },
				userId: USER,
				organizationId: ORG,
				signal: AbortSignal.abort(
					new DOMException("timed out", "TimeoutError"),
				),
			}),
		).rejects.toMatchObject({ name: "TimeoutError" });
	});

	describe("past the send deadline of the code sending it (a PM create's)", () => {
		const NOW = 1_000_000;
		beforeEach(() => {
			vi.spyOn(performance, "now").mockReturnValue(NOW);
		});
		afterEach(() => {
			vi.mocked(performance.now).mockRestore();
		});
		const createIn = async (deadline: number) => {
			const { runWithDispatchDeadline } = await import(
				"@repo/utils/dispatch-deadline"
			);
			const source = await resolveGitLabPMSource({
				userId: USER,
				organizationId: ORG,
				pmAdditionalContext: null,
			});
			return runWithDispatchDeadline(deadline, () =>
				createGitLabIssueFromStory({
					source: source as never,
					gitlabProjectId: "42",
					payload: { title: "Checkout flow" },
					userId: USER,
					organizationId: ORG,
				}),
			);
		};

		it("the create POST is not sent, and fails as not sent", async () => {
			const { isDispatchDeadlinePassedError } = await import(
				"@repo/utils/dispatch-deadline"
			);
			fetchMock.mockResolvedValue(ok({ iid: 7 }));

			const outcome = await createIn(NOW).then(
				() => null,
				(error: unknown) => error,
			);

			expect(isDispatchDeadlinePassedError(outcome)).toBe(true);
			expect(
				fetchMock.mock.calls.filter(
					([, init]) =>
						(init as RequestInit | undefined)?.method === "POST",
				),
			).toHaveLength(0);
		});

		it("the create POST is sent while the deadline is ahead", async () => {
			fetchMock.mockResolvedValue(
				ok({ iid: 7, web_url: "https://gitlab.com/g/p/-/issues/7" }),
			);

			await createIn(NOW + 50_000);

			expect(
				fetchMock.mock.calls.filter(
					([, init]) =>
						(init as RequestInit | undefined)?.method === "POST",
				),
			).toHaveLength(1);
		});
	});
});
