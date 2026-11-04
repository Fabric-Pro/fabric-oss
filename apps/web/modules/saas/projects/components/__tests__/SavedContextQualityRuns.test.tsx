import en from "@repo/i18n/translations/en.json";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	list: vi.fn(),
	get: vi.fn(),
	cancel: vi.fn(),
	compare: vi.fn(),
	download: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { contextQuality: { runs: mocks } },
}));
vi.mock("../../lib/markdown-to-document", () => ({
	triggerBlobDownload: mocks.download,
}));
vi.mock("next-intl", () => ({
	useFormatter: () => ({ dateTime: (date: Date) => date.toISOString() }),
	useTranslations:
		() => (key: string, values?: Record<string, string | number>) => {
			let message: unknown = en.projects.contexts.quality;
			for (const part of key.split(".")) {
				message = (message as Record<string, unknown>)[part];
			}
			return typeof message === "string"
				? message.replace(/\{(\w+)\}/g, (_, name) =>
						String(values?.[name] ?? name),
					)
				: key;
		},
}));

import { SavedContextQualityRuns } from "../SavedContextQualityRuns";

const copy = en.projects.contexts.quality;
const report = {
	projectId: "example-project",
	organizationId: "example-org",
	version: 1,
	mode: "recorded-output",
	scorerVersion: "fabric-deterministic-context-v1",
	datasetHash: "a".repeat(64),
	configurationHash: "b".repeat(64),
	snapshotHash: "c".repeat(64),
	status: "failed",
	counts: {
		cases: 1,
		passed: 0,
		failed: 1,
		integrityFailures: 0,
		qualityFailures: 1,
	},
	sources: [{ id: "example-source", revision: "d".repeat(64) }],
	cases: [
		{
			id: "example-case",
			status: "failed",
			checks: [
				{
					id: "required-phrases",
					category: "quality",
					status: "failed",
				},
			],
			retrieval: { precision: 1, recall: 1 },
			citations: { precision: 1, recall: 1 },
		},
	],
};

function run(overrides: Record<string, unknown> = {}) {
	return {
		id: "example-run",
		projectId: "example-project",
		organizationId: "example-org",
		name: "Example evaluation",
		status: "SUCCEEDED",
		report,
		evidenceAvailable: true,
		sourceRefs: [
			{ sourceId: "example-source", expectedRevision: "d".repeat(64) },
		],
		errorCode: null,
		cleanupStatus: "CONFIRMED",
		remoteRunUrl: "https://example.cloud.databricks.com/jobs/1/runs/1",
		mlflowRunUrl:
			"https://example.azuredatabricks.net/ml/experiments/1/runs/1",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T01:00:00.000Z",
		completedAt: "2026-01-01T01:00:00.000Z",
		...overrides,
	};
}

async function setup(
	overrides: Partial<
		React.ComponentProps<typeof SavedContextQualityRuns>
	> = {},
) {
	const props = {
		projectId: "example-project",
		organizationId: "example-org",
		canCancel: true,
		seedRunId: "example-run",
		...overrides,
	};
	let view!: ReturnType<typeof render>;
	await act(async () => {
		view = render(<SavedContextQualityRuns {...props} />);
	});
	return {
		...view,
		rerenderScope: async (next: Partial<typeof props>) => {
			await act(async () => {
				view.rerender(<SavedContextQualityRuns {...props} {...next} />);
			});
		},
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((accept) => {
		resolve = accept;
	});
	return { promise, resolve };
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.list.mockResolvedValue({ runs: [run()], nextCursor: null });
	mocks.get.mockResolvedValue({ run: run() });
	mocks.cancel.mockResolvedValue({
		run: run({ status: "CANCEL_REQUESTED", report: null }),
	});
});
afterEach(() => {
	vi.useRealTimers();
});

describe("SavedContextQualityRuns", () => {
	it("separates successful execution from failed quality checks and offers the bounded report", async () => {
		await setup();
		const detail = screen.getByRole("region", { name: copy.saved.details });
		expect(
			within(detail).getByText(copy.saved.statuses.SUCCEEDED),
		).toBeInTheDocument();
		expect(within(detail).getByText(copy.failed)).toBeInTheDocument();
		expect(within(detail).getByText(copy.checkFailed)).toBeInTheDocument();
		expect(
			within(detail).getByRole("link", { name: copy.saved.remoteRun }),
		).toHaveAttribute(
			"href",
			"https://example.cloud.databricks.com/jobs/1/runs/1",
		);
		fireEvent.click(
			within(detail).getByRole("button", { name: copy.download }),
		);
		expect(mocks.download).toHaveBeenCalledWith(
			expect.any(Blob),
			"context-quality-report.json",
		);
		expect(
			within(detail).queryByRole("button", { name: copy.saved.cancel }),
		).not.toBeInTheDocument();
	});

	it("withholds reports, downloads and links whenever evidenceAvailable is false", async () => {
		mocks.get.mockResolvedValue({ run: run({ evidenceAvailable: false }) });
		await setup();
		const detail = screen.getByRole("region", { name: copy.saved.details });
		expect(
			within(detail).getByText(copy.saved.evidenceUnavailable),
		).toBeInTheDocument();
		expect(within(detail).queryByText(copy.failed)).not.toBeInTheDocument();
		expect(
			within(detail).queryByText(report.snapshotHash),
		).not.toBeInTheDocument();
		expect(within(detail).queryByRole("link")).not.toBeInTheDocument();
		expect(
			within(detail).queryByRole("button", { name: copy.download }),
		).not.toBeInTheDocument();
	});

	it("does not render credentials, unsafe schemes or third-party external links", async () => {
		for (const remoteRunUrl of [
			"javascript:alert(1)",
			"https://example.com/run",
			"https://example.databricks.com.example.com/run",
			"https://synthetic:synthetic@example.databricks.com/run",
			"http://example.cloud.databricks.com/run",
			"https://synthetic:synthetic@example.cloud.databricks.com/run",
			"https://example.cloud.databricks.com:8443/run",
			"https://example.databricks.com/run",
			"https://cloud.databricks.com/run",
			"https://example.databricks.azure.us.example.com/run",
			"https://example.cloud.databricks.mil.example.com/run",
			"https://example.com/run?redirect=https://example.cloud.databricks.us",
			"https://example.cloud.databricks.us@example.com/run",
			"https://127.0.0.1/run",
		]) {
			mocks.get.mockResolvedValueOnce({
				run: run({ remoteRunUrl, mlflowRunUrl: null }),
			});
			const view = await setup();
			expect(screen.queryByRole("link")).not.toBeInTheDocument();
			view.unmount();
		}
	});

	it.each([
		"example.azuredatabricks.net",
		"example.cloud.databricks.com",
		"example.gcp.databricks.com",
		"example.databricks.azure.cn",
		"example.databricks.azure.us",
		"example.cloud.databricks.us",
		"example.cloud.databricks.mil",
	])(
		"preserves run and experiment links on the supported workspace domain %s",
		async (hostname) => {
			const remoteRunUrl = `https://${hostname}/jobs/123/runs/456?o=789#details`;
			const mlflowRunUrl = `https://${hostname}/ml/experiments/123/runs/example-run`;
			mocks.get.mockResolvedValue({
				run: run({ remoteRunUrl, mlflowRunUrl }),
			});
			await setup();
			expect(
				screen.getByRole("link", { name: copy.saved.remoteRun }),
			).toHaveAttribute("href", remoteRunUrl);
			expect(
				screen.getByRole("link", { name: copy.saved.mlflowRun }),
			).toHaveAttribute("href", mlflowRunUrl);
			for (const label of [copy.saved.remoteRun, copy.saved.mlflowRun]) {
				expect(
					screen.getByRole("link", { name: label }),
				).toHaveAttribute("target", "_blank");
				expect(
					screen.getByRole("link", { name: label }),
				).toHaveAttribute("rel", "noopener noreferrer");
			}
		},
	);

	it("polls only active lifecycles, including cancellation intent, and stops on confirmation", async () => {
		vi.useFakeTimers();
		const active = run({ status: "RUNNING", report: null });
		mocks.list.mockResolvedValue({ runs: [active], nextCursor: null });
		mocks.get.mockResolvedValue({ run: active });
		await setup();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2500);
		});
		expect(mocks.get).toHaveBeenCalledTimes(2);
		const pending = run({ status: "CANCEL_REQUESTED", report: null });
		mocks.list.mockResolvedValue({ runs: [pending], nextCursor: null });
		mocks.get.mockResolvedValue({ run: pending });
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2500);
		});
		expect(
			screen.getByText(copy.saved.cancellationPending),
		).toBeInTheDocument();
		expect(
			screen.queryByText(copy.saved.cancellationConfirmed),
		).not.toBeInTheDocument();
		const cancelled = run({ status: "CANCELLED", report: null });
		mocks.list.mockResolvedValue({ runs: [cancelled], nextCursor: null });
		mocks.get.mockResolvedValue({ run: cancelled });
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2500);
		});
		expect(
			screen.getByText(copy.saved.cancellationConfirmed),
		).toBeInTheDocument();
		const reads = mocks.get.mock.calls.length;
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_000);
		});
		expect(mocks.get).toHaveBeenCalledTimes(reads);
	});

	it("does not poll completed or reconciliation-required runs", async () => {
		vi.useFakeTimers();
		for (const status of [
			"SUCCEEDED",
			"FAILED",
			"CANCELLED",
			"RECONCILIATION_REQUIRED",
		]) {
			mocks.list.mockResolvedValue({
				runs: [run({ status })],
				nextCursor: null,
			});
			mocks.get.mockResolvedValue({ run: run({ status }) });
			const view = await setup();
			const reads = mocks.get.mock.calls.length;
			await act(async () => {
				await vi.advanceTimersByTimeAsync(10_000);
			});
			expect(mocks.get).toHaveBeenCalledTimes(reads);
			view.unmount();
		}
	});

	it("ignores a pre-cancel poll arriving after cancellation is acknowledged", async () => {
		vi.useFakeTimers();
		const running = run({ status: "RUNNING", report: null });
		mocks.list.mockResolvedValue({ runs: [running], nextCursor: null });
		mocks.get.mockResolvedValue({ run: running });
		await setup();
		const oldRead = deferred<{ run: ReturnType<typeof run> }>();
		mocks.get.mockImplementationOnce(() => oldRead.promise);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2500);
		});
		const pending = run({ status: "CANCEL_REQUESTED", report: null });
		mocks.cancel.mockResolvedValueOnce({ run: pending });
		mocks.list.mockResolvedValue({ runs: [pending], nextCursor: null });
		mocks.get.mockResolvedValue({ run: pending });
		await act(async () => {
			fireEvent.click(
				screen.getByRole("button", { name: copy.saved.cancel }),
			);
		});
		expect(mocks.cancel).toHaveBeenCalledWith({
			projectId: "example-project",
			organizationId: "example-org",
			runId: "example-run",
		});
		expect(
			screen.getByText(copy.saved.cancellationPending),
		).toBeInTheDocument();
		await act(async () => {
			oldRead.resolve({ run: running });
		});
		expect(
			screen.getByText(copy.saved.cancellationPending),
		).toBeInTheDocument();
		expect(
			screen.queryByText(copy.saved.cancellationConfirmed),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: copy.saved.cancel }),
		).not.toBeInTheDocument();
	});

	it("does not offer cancellation when server capabilities deny it", async () => {
		mocks.get.mockResolvedValue({
			run: run({ status: "RUNNING", report: null }),
		});
		const view = await setup({ canCancel: false });
		expect(
			screen.queryByRole("button", { name: copy.saved.cancel }),
		).not.toBeInTheDocument();
		expect(mocks.cancel).not.toHaveBeenCalled();
		view.unmount();
	});

	it("discards late details and prior project data on a scope change", async () => {
		const oldRead = deferred<{ run: ReturnType<typeof run> }>();
		mocks.get.mockImplementationOnce(() => oldRead.promise);
		const view = await setup();
		mocks.list.mockResolvedValue({ runs: [], nextCursor: null });
		mocks.get.mockRejectedValue(new Error("synthetic private exception"));
		await view.rerenderScope({
			projectId: "example-other-project",
			organizationId: "example-other-org",
		});
		await act(async () => {
			oldRead.resolve({ run: run() });
		});
		expect(
			screen.queryByRole("region", { name: copy.saved.details }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByText("Example evaluation"),
		).not.toBeInTheDocument();
		expect(
			screen.queryByText("synthetic private exception"),
		).not.toBeInTheDocument();
	});

	it("clears evidence if access is revoked on a later poll", async () => {
		vi.useFakeTimers();
		const current = run({ status: "RUNNING" });
		mocks.list.mockResolvedValue({ runs: [current], nextCursor: null });
		mocks.get.mockResolvedValue({ run: current });
		await setup();
		expect(
			screen.getByRole("link", { name: copy.saved.remoteRun }),
		).toBeInTheDocument();
		mocks.get.mockRejectedValueOnce(new Error("synthetic private denial"));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2500);
		});
		expect(
			screen.queryByRole("region", { name: copy.saved.details }),
		).not.toBeInTheDocument();
		expect(screen.queryByRole("link")).not.toBeInTheDocument();
		expect(screen.getByText(copy.saved.error)).toBeInTheDocument();
		expect(
			screen.queryByText("synthetic private denial"),
		).not.toBeInTheDocument();
	});

	it("does not display a numeric comparison when the server withholds either run's evidence", async () => {
		const second = run({
			id: "example-candidate",
			name: "Candidate evaluation",
		});
		mocks.list.mockResolvedValue({
			runs: [run(), second],
			nextCursor: null,
		});
		mocks.compare.mockResolvedValue({
			baseline: run({ evidenceAvailable: false }),
			candidate: second,
			compatible: true,
			passedDelta: 1,
			differences: {
				dataset: false,
				configuration: false,
				scorer: false,
			},
		});
		const user = userEvent.setup();
		await setup();
		await user.click(
			screen.getByRole("combobox", { name: copy.saved.baseline }),
		);
		await user.click(
			screen.getByRole("option", { name: "Example evaluation" }),
		);
		await user.click(
			screen.getByRole("combobox", { name: copy.saved.candidate }),
		);
		await user.click(
			screen.getByRole("option", { name: "Candidate evaluation" }),
		);
		await user.click(
			screen.getByRole("button", { name: copy.saved.compare }),
		);
		await screen.findByText(copy.saved.evidenceUnavailable);
		expect(
			screen.queryByText(/Difference in passed cases/),
		).not.toBeInTheDocument();
		expect(mocks.compare).toHaveBeenCalledWith({
			projectId: "example-project",
			organizationId: "example-org",
			baselineId: "example-run",
			candidateId: "example-candidate",
		});
	});
});

describe("saved comparison races", () => {
	async function choose(
		user: ReturnType<typeof userEvent.setup>,
		label: string,
		name: string,
	) {
		await user.click(screen.getByRole("combobox", { name: label }));
		await user.click(screen.getByRole("option", { name }));
	}

	it("shows compatibility differences without inventing a numeric delta", async () => {
		const candidate = run({
			id: "example-candidate",
			name: "Candidate evaluation",
		});
		mocks.list.mockResolvedValue({
			runs: [run(), candidate],
			nextCursor: null,
		});
		mocks.compare.mockResolvedValue({
			baseline: run(),
			candidate,
			compatible: false,
			passedDelta: null,
			differences: { dataset: true, configuration: false, scorer: true },
		});
		const user = userEvent.setup();
		await setup();
		await choose(user, copy.saved.baseline, "Example evaluation");
		await choose(user, copy.saved.candidate, "Candidate evaluation");
		await user.click(
			screen.getByRole("button", { name: copy.saved.compare }),
		);
		await screen.findByText(copy.saved.incompatible);
		expect(
			screen.getByText(copy.saved.differences.dataset),
		).toBeInTheDocument();
		expect(
			screen.getByText(copy.saved.differences.scorer),
		).toBeInTheDocument();
		expect(
			screen.queryByText(copy.saved.differences.configuration),
		).not.toBeInTheDocument();
		expect(
			screen.queryByText(/Difference in passed cases/),
		).not.toBeInTheDocument();
	});

	it("discards a comparison response after either selection changes", async () => {
		const candidate = run({
			id: "example-candidate",
			name: "Candidate evaluation",
		});
		mocks.list.mockResolvedValue({
			runs: [run(), candidate],
			nextCursor: null,
		});
		const response = deferred<{
			baseline: ReturnType<typeof run>;
			candidate: ReturnType<typeof run>;
			compatible: boolean;
			passedDelta: number;
			differences: {
				dataset: boolean;
				configuration: boolean;
				scorer: boolean;
			};
		}>();
		mocks.compare.mockImplementationOnce(() => response.promise);
		const user = userEvent.setup();
		await setup();
		await choose(user, copy.saved.baseline, "Example evaluation");
		await choose(user, copy.saved.candidate, "Candidate evaluation");
		await user.click(
			screen.getByRole("button", { name: copy.saved.compare }),
		);
		await choose(user, copy.saved.candidate, "Example evaluation");
		await act(async () => {
			response.resolve({
				baseline: run(),
				candidate,
				compatible: true,
				passedDelta: 1,
				differences: {
					dataset: false,
					configuration: false,
					scorer: false,
				},
			});
		});
		expect(
			screen.queryByText(/Difference in passed cases/),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: copy.saved.compare }),
		).toBeDisabled();
	});
});
