/**
 * The tab speaks state, not commands (Fizzy #2878): under the summary, the
 * status block says what is published, whether Fabric's copy is what the last
 * sync took and if not why, whether automatic sync is on, and that the
 * developer's own checkout is not tracked here.
 *
 * It is built on the shape the server reports for a repository project
 * (`repository.sync`: automatic, pausedReason, lastRun with trigger, status,
 * error, commit and finish time), mocked into the state `repositorySync.get`
 * returns. `lastRun.error === "TREE_REFUSED"` is the refused state. Real
 * `en.json` copy is resolved, so what is asserted is what ships.
 */
import en from "@repo/i18n/translations/en.json";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type {
	RepositorySyncState,
	SyncRunView,
} from "../../../lib/instructions-repository-sync";

function resolve(path: string): unknown {
	return path.split(".").reduce<unknown>((node, key) => {
		return node && typeof node === "object"
			? (node as Record<string, unknown>)[key]
			: undefined;
	}, en);
}

vi.mock("next-intl", () => ({
	useTranslations: (namespace: string) => {
		const t = (key: string, values?: Record<string, unknown>) => {
			const raw = resolve(`${namespace}.${key}`);
			if (typeof raw !== "string") {
				throw new Error(`missing translation: ${namespace}.${key}`);
			}
			return Object.entries(values ?? {}).reduce(
				(out, [name, value]) =>
					out.replaceAll(`{${name}}`, String(value)),
				raw,
			);
		};
		t.raw = (key: string) => resolve(`${namespace}.${key}`);
		return t;
	},
}));

import { RepositorySyncStatus } from "../RepositorySyncStatus";

const copy = en.projects.codingInstructions.repositorySync;
const COMMIT = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
const REFUSED = "b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0";

const PUBLISHED = {
	sourceCommitSha: COMMIT,
	sourceRef: "main",
};

function run(overrides: Partial<SyncRunView> = {}): SyncRunView {
	return {
		id: "sync_1:run_a",
		trigger: "WEBHOOK",
		startedAt: new Date(Date.now() - 3 * 60_000),
		finishedAt: new Date(Date.now() - 2 * 60_000),
		status: "SUCCEEDED",
		error: null,
		note: null,
		commitSha: COMMIT,
		snapshotId: "snap_1",
		snapshotVersion: 12,
		userName: null,
		fromCurrentConfiguration: true,
		...overrides,
	};
}

function state(
	overrides: Partial<RepositorySyncState> = {},
): RepositorySyncState {
	return {
		sourceOfTruth: "REPOSITORY",
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
			rootPath: "",
			automatic: true,
			automaticPausedReason: null,
			automaticPausedAt: null,
			delegateName: "Example Member",
		},
		latestRun: run(),
		availableIntegrations: [],
		...overrides,
	};
}

describe("RepositorySyncStatus — what the summary already says", () => {
	it("does not restate the published version, commit, branch or repository", () => {
		render(<RepositorySyncStatus state={state()} published={PUBLISHED} />);

		const block = screen.getByRole("status");
		expect(block).not.toHaveTextContent(/published:/i);
		expect(block).not.toHaveTextContent("example-org/instructions");
		// The copy line is about Fabric's copy, not a second headline for the
		// commit the summary names; only the last run's own line may name the
		// commit it took (`took commit a1b2c3d`).
		expect(
			screen.getByTestId("repository-sync-copy"),
		).not.toHaveTextContent("a1b2c3d");
	});

	it("says nothing about Fabric's copy for an upload-sourced version, which has no commit to compare", () => {
		render(
			<RepositorySyncStatus
				state={state()}
				published={{ ...PUBLISHED, sourceCommitSha: null }}
			/>,
		);

		expect(screen.queryByTestId("repository-sync-copy")).toBeNull();
	});
});

describe("RepositorySyncStatus — a commit made from the tab (Fizzy #2878 §10)", () => {
	const MADE = "0123456789abcdef0123456789abcdef01234567";

	it("says the commit was made and Fabric's copy is syncing, instead of calling the copy behind", () => {
		render(
			<RepositorySyncStatus
				state={state()}
				published={PUBLISHED}
				syncingCommit={{ sha: MADE, ref: "main" }}
			/>,
		);

		const line = screen.getByTestId("repository-sync-copy");
		expect(line).toHaveTextContent(
			"Committed 0123456 to main · Fabric's copy is syncing…",
		);
		expect(line).not.toHaveTextContent(/behind|matched/);
	});

	it("goes back to the ordinary copy line once the wait is over", () => {
		render(
			<RepositorySyncStatus
				state={state()}
				published={PUBLISHED}
				syncingCommit={null}
			/>,
		);

		expect(screen.getByTestId("repository-sync-copy")).toHaveTextContent(
			/^Fabric's copy matched main at the last sync/,
		);
	});
});

describe("RepositorySyncStatus — Fabric's copy", () => {
	it("says it matched the branch at the last sync, and when, not that it is current now", () => {
		render(<RepositorySyncStatus state={state()} published={PUBLISHED} />);

		const line = screen.getByTestId("repository-sync-copy");
		expect(line).toHaveTextContent(
			/^Fabric's copy matched main at the last sync \(.+\)\.$/,
		);
		expect(line).not.toHaveTextContent(/is current/);
	});

	it("says the commit was refused by the secret scan, with a way to the findings", async () => {
		const onSeeFindings = vi.fn();
		const user = userEvent.setup();
		render(
			<RepositorySyncStatus
				state={state({
					latestRun: run({
						status: "FAILED",
						error: "TREE_REFUSED",
						commitSha: REFUSED,
					}),
				})}
				published={PUBLISHED}
				onSeeFindings={onSeeFindings}
			/>,
		);

		const line = screen.getByTestId("repository-sync-copy");
		expect(line).toHaveTextContent(
			/Fabric's copy is behind main: commit b1c2d3e was refused by the secret scan \(.+\)\./,
		);
		await user.click(screen.getByRole("button", { name: "See findings" }));
		expect(onSeeFindings).toHaveBeenCalledTimes(1);
	});

	it("treats a REJECTED run as the same refusal", () => {
		render(
			<RepositorySyncStatus
				state={state({
					latestRun: run({ status: "REJECTED", commitSha: REFUSED }),
				})}
				published={PUBLISHED}
			/>,
		);

		expect(screen.getByTestId("repository-sync-copy")).toHaveTextContent(
			"commit b1c2d3e was refused by the secret scan",
		);
	});

	it("says a refusal with no commit recorded without inventing one", () => {
		render(
			<RepositorySyncStatus
				state={state({
					latestRun: run({
						status: "FAILED",
						error: "TREE_REFUSED",
						commitSha: null,
					}),
				})}
				published={PUBLISHED}
			/>,
		);

		expect(screen.getByTestId("repository-sync-copy")).toHaveTextContent(
			/the last sync was refused by the secret scan/,
		);
	});

	it("offers no findings link when no banner is on the page to point at", () => {
		render(
			<RepositorySyncStatus
				state={state({ latestRun: run({ status: "REJECTED" }) })}
				published={PUBLISHED}
			/>,
		);

		expect(
			screen.queryByRole("button", { name: "See findings" }),
		).not.toBeInTheDocument();
	});

	it("says why it is behind when the last sync failed, once, not again under the last run", () => {
		render(
			<RepositorySyncStatus
				state={state({
					latestRun: run({ status: "FAILED", error: "REF_MISSING" }),
				})}
				published={PUBLISHED}
			/>,
		);

		const region = screen.getByRole("status");
		expect(screen.getByTestId("repository-sync-copy")).toHaveTextContent(
			"Fabric's copy is behind main. Branch main no longer exists.",
		);
		expect(
			region.textContent?.match(/Branch main no longer exists\./g),
		).toHaveLength(1);
	});

	it("claims nothing while a run is open, since the progress line already says so", () => {
		render(
			<RepositorySyncStatus
				state={state({
					running: true,
					latestRun: run({ finishedAt: null, status: null }),
				})}
				published={PUBLISHED}
			/>,
		);

		expect(
			screen.queryByTestId("repository-sync-copy"),
		).not.toBeInTheDocument();
		expect(screen.getByRole("status")).toHaveTextContent(copy.running);
	});

	it("claims nothing when the server has reported no run, rather than guessing current", () => {
		render(
			<RepositorySyncStatus
				state={state({ latestRun: null })}
				published={PUBLISHED}
			/>,
		);

		expect(
			screen.queryByTestId("repository-sync-copy"),
		).not.toBeInTheDocument();
		expect(screen.getByRole("status")).not.toHaveTextContent(
			"Fabric's copy is",
		);
	});
});

describe("RepositorySyncStatus — automatic sync and the checkout", () => {
	it("says a GitHub repository syncs after each push and normally every 15 minutes", () => {
		render(<RepositorySyncStatus state={state()} />);

		expect(screen.getByRole("status")).toHaveTextContent(
			"Automatic sync: on · after each push and normally every 15 minutes",
		);
	});

	it("says another provider normally syncs on the 15-minute check, because only GitHub pushes a webhook", () => {
		const base = state();
		render(
			<RepositorySyncStatus
				state={{
					...base,
					configured: base.configured
						? { ...base.configured, provider: "AZURE_DEVOPS" }
						: null,
				}}
			/>,
		);

		expect(screen.getByRole("status")).toHaveTextContent(
			"Automatic sync: on · normally every 15 minutes",
		);
		expect(screen.getByRole("status")).not.toHaveTextContent(
			"after each push",
		);
	});

	it("says automatic sync is off", () => {
		const base = state();
		render(
			<RepositorySyncStatus
				state={{
					...base,
					configured: base.configured
						? { ...base.configured, automatic: false }
						: null,
				}}
			/>,
		);

		expect(screen.getByRole("status")).toHaveTextContent(
			"Automatic sync: off",
		);
	});

	it("says automatic sync is paused, why, and offers Re-enable instead of the on/off line", async () => {
		const onConfigure = vi.fn();
		const user = userEvent.setup();
		const base = state();
		render(
			<RepositorySyncStatus
				state={{
					...base,
					configured: base.configured
						? {
								...base.configured,
								automaticPausedReason: "REF_MISSING",
							}
						: null,
				}}
				onConfigure={onConfigure}
			/>,
		);

		expect(screen.getByRole("status")).toHaveTextContent(
			"Automatic sync paused: the branch or folder no longer exists",
		);
		expect(screen.getByRole("status")).not.toHaveTextContent(
			"Automatic sync: on",
		);
		await user.click(
			screen.getByRole("button", { name: copy.reEnableButton }),
		);
		expect(onConfigure).toHaveBeenCalledTimes(1);
	});

	it("says the developer's own checkout is not tracked here", () => {
		render(<RepositorySyncStatus state={state()} />);

		expect(screen.getByRole("status")).toHaveTextContent(
			"Your own checkout is not tracked here; the session hook in your coding tool tells you when it is behind.",
		);
	});
});
