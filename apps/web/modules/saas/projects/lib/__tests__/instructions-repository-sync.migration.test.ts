/**
 * What the sync state means for the tab while a move of uploaded instructions
 * into a repository is open (Fizzy #2878 §9): the sync it created is paused,
 * so "Sync now" is refused until the project is switching over, and the tab
 * keeps reading the state so it notices when the move ends.
 */
import { describe, expect, it } from "vitest";
import {
	offersMoveIntoRepository,
	offersSyncFromRepository,
	offersSyncNow,
	REPOSITORY_SYNC_IDLE_POLL_MS,
	REPOSITORY_SYNC_POLL_MS,
	type RepositorySyncState,
	repositorySyncPollInterval,
} from "../instructions-repository-sync";

function state(
	overrides: Partial<RepositorySyncState> = {},
): RepositorySyncState {
	return {
		sourceOfTruth: "UPLOAD",
		canConfigure: true,
		running: false,
		configured: {
			syncId: "sync_1",
			repositoryIntegrationId: "int_1",
			provider: "GITHUB",
			repositoryOwner: "example-org",
			repositoryName: "instructions",
			repositoryUrl: "https://github.com/example-org/instructions.git",
			integrationStatus: "ACTIVE",
			ref: "main",
			rootPath: "docs/instructions",
			automatic: true,
			automaticPausedReason: "MIGRATING",
			automaticPausedAt: null,
			delegateName: null,
		},
		latestRun: null,
		availableIntegrations: [
			{
				id: "int_1",
				provider: "GITHUB",
				repositoryOwner: "example-org",
				repositoryName: "instructions",
				defaultBranch: "main",
			},
		],
		...overrides,
	};
}

describe("Sync now while a move into a repository is open", () => {
	it("is not offered while the pull request is being prepared, open or merged and settling", () => {
		expect(
			offersSyncNow(state({ migration: { state: "PROPOSING" } })),
		).toBe(false);
	});

	it("is offered once the project is switching, to hurry the first sync", () => {
		expect(
			offersSyncNow(
				state({
					sourceOfTruth: "REPOSITORY",
					migration: { state: "SWITCHING" },
				}),
			),
		).toBe(true);
	});

	it("is offered as before when nothing is moving", () => {
		expect(offersSyncNow(state({ migration: null }))).toBe(true);
		expect(offersSyncNow(state())).toBe(true);
	});

	it("is not offered to someone who cannot configure the sync", () => {
		expect(
			offersSyncNow(
				state({
					canConfigure: false,
					migration: { state: "SWITCHING" },
				}),
			),
		).toBe(false);
	});
});

describe("moving uploaded instructions into a repository", () => {
	const UPLOADS = {
		sourceOfTruth: "UPLOAD",
		configured: null,
		migration: null,
	} as const;

	it("is offered for an upload project that has a connected repository and no sync", () => {
		expect(offersMoveIntoRepository(state(UPLOADS))).toBe(true);
	});

	it("is not offered to someone who cannot configure the sync", () => {
		expect(
			offersMoveIntoRepository(
				state({ ...UPLOADS, canConfigure: false }),
			),
		).toBe(false);
	});

	it("is not offered when no repository is connected to move into", () => {
		expect(
			offersMoveIntoRepository(
				state({ ...UPLOADS, availableIntegrations: [] }),
			),
		).toBe(false);
	});

	it("is not offered once a sync is configured, the source is a repository, or a move is open", () => {
		expect(
			offersMoveIntoRepository(
				state({ ...UPLOADS, configured: state().configured }),
			),
		).toBe(false);
		expect(
			offersMoveIntoRepository(
				state({ ...UPLOADS, sourceOfTruth: "REPOSITORY" }),
			),
		).toBe(false);
		expect(
			offersMoveIntoRepository(
				state({ ...UPLOADS, migration: { state: "PROPOSING" } }),
			),
		).toBe(false);
	});
});

describe("syncing from a repository while a move is open", () => {
	it("is not offered, because the move's own sync is already configured", () => {
		expect(
			offersSyncFromRepository(
				state({ migration: { state: "PROPOSING" } }),
			),
		).toBe(false);
	});
});

describe("how often the sync state is read during a move", () => {
	it("reads quickly once the project is switching, for the first sync is about to land", () => {
		expect(
			repositorySyncPollInterval(
				state({
					sourceOfTruth: "REPOSITORY",
					migration: { state: "SWITCHING" },
				}),
			),
		).toBe(REPOSITORY_SYNC_POLL_MS);
	});

	it("reads at the idle pace while the pull request waits, so the end of the move is found", () => {
		expect(
			repositorySyncPollInterval(
				state({ migration: { state: "PROPOSING" } }),
			),
		).toBe(REPOSITORY_SYNC_IDLE_POLL_MS);
	});

	it("does not read a paused sync that no move holds", () => {
		expect(
			repositorySyncPollInterval(
				state({
					migration: null,
					configured: {
						...(state().configured as NonNullable<
							RepositorySyncState["configured"]
						>),
						automaticPausedReason: "REF_MISSING",
					},
				}),
			),
		).toBe(false);
	});
});
