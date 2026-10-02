/**
 * What the repository sync status says while a run is open: its own phases
 * (fetching, preparing, a counted copy), then the snapshot's check pass.
 * Resolves the REAL `en.json` copy and throws on a missing key, like the
 * sibling `RepositorySync.test.tsx`.
 *
 * Honest by construction: a count appears only when the server reported one, a
 * bar only when a total is known, and only the phase (never the count) sits in
 * the screen-reader text.
 */
import en from "@repo/i18n/translations/en.json";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
	RepositorySyncState,
	SyncRunView,
} from "../../../lib/instructions-repository-sync";

function resolve(path: string): unknown {
	return path.split(".").reduce<unknown>((node, key) => {
		if (node && typeof node === "object") {
			return (node as Record<string, unknown>)[key];
		}
		return undefined;
	}, en);
}

vi.mock("next-intl", () => ({
	useTranslations:
		(namespace: string) =>
		(key: string, values?: Record<string, unknown>) => {
			const raw = resolve(`${namespace}.${key}`);
			if (typeof raw !== "string") {
				throw new Error(`missing translation: ${namespace}.${key}`);
			}
			let out = raw;
			for (const [name, value] of Object.entries(values ?? {})) {
				out = out.replaceAll(`{${name}}`, String(value));
			}
			return out;
		},
}));

import { RepositorySyncStatus } from "../RepositorySyncStatus";

const copy = en.projects.codingInstructions.repositorySync;
const checks = en.projects.codingInstructions.publishedView;

const BASE: RepositorySyncState = {
	sourceOfTruth: "REPOSITORY",
	canConfigure: false,
	running: true,
	configured: {
		syncId: "sync_1",
		repositoryIntegrationId: "int_1",
		provider: "GITHUB",
		repositoryOwner: "example-org",
		repositoryName: "instructions",
		repositoryUrl: "https://github.com/example-org/instructions.git",
		integrationStatus: "ACTIVE",
		ref: "main",
		rootPath: "agents",
		automatic: false,
		automaticPausedReason: null,
		automaticPausedAt: null,
		delegateName: "Example Member",
	},
	latestRun: null,
	availableIntegrations: [],
};

function openRun(overrides: Partial<SyncRunView> = {}): SyncRunView {
	return {
		id: "sync_1:run_a",
		trigger: "MANUAL",
		startedAt: new Date(),
		finishedAt: null,
		status: null,
		error: null,
		note: null,
		commitSha: null,
		snapshotId: null,
		snapshotVersion: null,
		userName: "Example Member",
		fromCurrentConfiguration: true,
		...overrides,
	};
}

function renderRun(
	run: SyncRunView,
	inFlightSnapshot: RepositorySyncState["inFlightSnapshot"] = null,
) {
	return render(
		<RepositorySyncStatus
			state={{ ...BASE, latestRun: run, inFlightSnapshot }}
		/>,
	);
}

describe("RepositorySyncStatus: an open run's progress", () => {
	it("names fetching without any count or bar", () => {
		renderRun(
			openRun({
				progress: { phase: "FETCHING", done: null, total: null },
			}),
		);

		expect(screen.getAllByText(copy.fetching)).toHaveLength(2);
		expect(screen.queryByTestId("sync-progress-bar")).toBeNull();
	});

	it("names preparing without any count or bar", () => {
		renderRun(
			openRun({
				progress: { phase: "PREPARING", done: null, total: null },
			}),
		);

		expect(screen.getAllByText(copy.preparing)).toHaveLength(2);
		expect(screen.queryByTestId("sync-progress-bar")).toBeNull();
	});

	it("counts the copy in files uploaded out of files to copy, with a bar", () => {
		renderRun(
			openRun({
				progress: { phase: "COPYING", done: 3, total: 8 },
			}),
		);

		expect(screen.getByText("Copying 3 of 8 files")).toBeInTheDocument();
		expect(screen.getByText(copy.copyingPhase)).toHaveClass("sr-only");
		expect(screen.getByTestId("sync-progress-bar")).toBeInTheDocument();
	});

	it("announces only the phase: the count is hidden from assistive technology", () => {
		renderRun(
			openRun({
				progress: { phase: "COPYING", done: 3, total: 8 },
			}),
		);

		expect(screen.getByText("Copying 3 of 8 files")).toHaveAttribute(
			"aria-hidden",
			"true",
		);
		expect(screen.getByRole("status")).toHaveAttribute(
			"aria-live",
			"polite",
		);
	});

	it("continues into the snapshot's checks once it reports a pass", () => {
		renderRun(
			openRun({
				progress: { phase: "COPYING", done: 8, total: 8 },
			}),
			{
				status: "VALIDATING",
				version: 5,
				scanPending: false,
				progress: { phase: "CHECKING", done: 2, total: 8 },
			},
		);

		expect(screen.getByText("Checking 2 of 8 files")).toBeInTheDocument();
		expect(screen.getByText(checks.checkingPhase)).toHaveClass("sr-only");
		expect(screen.queryByText("Copying 8 of 8 files")).toBeNull();
	});

	it("keeps the plain 'Syncing' wording when nothing has reported yet", () => {
		renderRun(openRun({ progress: null }));

		expect(screen.getByText(copy.running)).toBeInTheDocument();
		expect(screen.queryByTestId("sync-progress-bar")).toBeNull();
	});

	it("never shows a count that does not add up", () => {
		renderRun(
			openRun({
				progress: { phase: "COPYING", done: 9, total: 8 },
			}),
		);

		expect(screen.queryByText(/Copying \d+ of \d+ files/)).toBeNull();
		expect(screen.queryByTestId("sync-progress-bar")).toBeNull();
	});
});
