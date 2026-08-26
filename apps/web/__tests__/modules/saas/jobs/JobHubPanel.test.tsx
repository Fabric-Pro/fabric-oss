/**
 * `JobHubPanel` / `JobCard` — what the panel actually tells a user.
 *
 * The feature exists to replace a black box, so the assertions here are about
 * the sentences a user reads: that a running job shows live counts, that a
 * failed job shows its reason rather than a bare "Failed", and that an empty
 * panel explains what would appear instead of just being blank.
 *
 * Translations resolve against the real `en.json` (rather than echoing keys
 * back, as the global setup does) so a missing or renamed string fails here.
 */

import messages from "@repo/i18n/translations/en.json";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => {
	const lookup = (path: string): unknown =>
		path
			.split(".")
			.reduce<unknown>(
				(node, key) =>
					node && typeof node === "object"
						? (node as Record<string, unknown>)[key]
						: undefined,
				messages,
			);

	// Minimal ICU: `{name}` interpolation plus the `plural` form used by the
	// count labels.
	const format = (template: string, values: Record<string, unknown>) =>
		template
			.replace(
				/\{(\w+), plural, one \{([^}]*)\} other \{([^}]*)\}\}/g,
				(_all, name: string, one: string, other: string) => {
					const count = Number(values[name] ?? 0);
					return (count === 1 ? one : other).replace(
						"#",
						String(count),
					);
				},
			)
			.replace(/\{(\w+)\}/g, (_all, name: string) =>
				String(values[name] ?? ""),
			);

	const useTranslations = (namespace: string) => {
		const t = (key: string, values: Record<string, unknown> = {}) => {
			const template = lookup(`${namespace}.${key}`);
			if (typeof template !== "string") {
				throw new Error(`Missing translation: ${namespace}.${key}`);
			}
			return format(template, values);
		};
		t.raw = (key: string) => lookup(`${namespace}.${key}`);
		return t;
	};

	return {
		useTranslations,
		useLocale: () => "en",
		useFormatter: () => ({
			dateTime: (d: Date) => d.toISOString(),
			number: (n: number) => String(n),
			relativeTime: (d: Date) => d.toISOString(),
		}),
		useMessages: () => messages,
		NextIntlClientProvider: ({ children }: { children: React.ReactNode }) =>
			children,
	};
});

const mocks = vi.hoisted(() => ({
	useJobs: vi.fn(),
	params: { id: "proj-1" } as Record<string, string> | null,
}));

vi.mock("next/navigation", () => ({
	useParams: () => mocks.params,
}));

vi.mock("../../../../modules/saas/jobs/hooks/use-jobs", async () => {
	const actual = (await vi.importActual(
		"../../../../modules/saas/jobs/hooks/use-jobs",
	)) as Record<string, unknown>;
	return { ...actual, useJobs: mocks.useJobs };
});

import { JobHubPanel } from "../../../../modules/saas/jobs/components/JobHubPanel";
import type { JobListItem } from "../../../../modules/saas/jobs/hooks/use-jobs";

function makeJob(over: Partial<JobListItem> = {}): JobListItem {
	return {
		id: "job-1",
		kind: "TEAMS_CHANNEL_MONITOR",
		status: "RUNNING",
		title: "Teams · #general",
		sourceType: "teamsLinkedChannel",
		sourceId: "chan-1",
		counts: { threadsAnalyzed: 12, proposalsCreated: 4 },
		steps: [
			{ key: "fetch", status: "completed" },
			{ key: "analyze", status: "running" },
			{ key: "propose", status: "pending" },
		],
		error: null,
		projectId: "proj-1",
		projectName: "Fabric",
		startedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
		completedAt: null,
		...over,
	};
}

function mockJobs(jobs: JobListItem[], isPending = false) {
	mocks.useJobs.mockReturnValue({
		data: { jobs, retentionDays: 7 },
		isPending,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.params = { id: "proj-1" };
});

describe("JobHubPanel", () => {
	it("shows a running job with its live item counts", () => {
		mockJobs([makeJob()]);

		render(<JobHubPanel open onOpenChange={() => {}} />);

		expect(screen.getByText("Teams · #general")).toBeInTheDocument();
		expect(
			screen.getByText(/12 threads analyzed · 4 proposals created/),
		).toBeInTheDocument();
		expect(screen.getAllByRole("status")[0]).toHaveAccessibleName(
			"Running",
		);
	});

	it("uses the singular form for a count of one", () => {
		mockJobs([
			makeJob({
				kind: "TEAMS_CHANNEL_MONITOR",
				title: "Teams · general",
				counts: { threadsAnalyzed: 1, proposalsCreated: 1 },
				steps: [],
			}),
		]);

		render(<JobHubPanel open onOpenChange={() => {}} />);

		// "1 threads analyzed" reads as sloppy in the one place the panel is
		// meant to inspire confidence.
		expect(
			screen.getByText(/1 thread analyzed · 1 proposal created/),
		).toBeInTheDocument();
	});

	it("counts a skipped step as settled, not outstanding", () => {
		mockJobs([
			makeJob({
				kind: "CODE_INDEXING",
				title: "acme/api",
				status: "COMPLETED",
				steps: [
					{ key: "clone", status: "completed" },
					{ key: "symbols", status: "skipped" },
					{ key: "finalize", status: "completed" },
				],
			}),
		]);

		render(<JobHubPanel open onOpenChange={() => {}} />);

		// "2/3" on a finished job implies a step is still to come, which is
		// never true once the run is over.
		expect(screen.getByText(/3\/3 steps/)).toBeInTheDocument();
	});

	it("renders indexing progress against the known total", () => {
		mockJobs([
			makeJob({
				kind: "CODE_INDEXING",
				title: "acme/api",
				counts: { filesProcessed: 120, totalFiles: 3400 },
				steps: [],
			}),
		]);

		render(<JobHubPanel open onOpenChange={() => {}} />);

		// A bare "120 files" reads as done; against the total it reads as progress.
		expect(
			screen.getByText(/120\/3,400 files indexed/),
		).toBeInTheDocument();
	});

	it("shows the failure reason, not just a failed badge", () => {
		mockJobs([
			makeJob({
				status: "FAILED",
				error: "Authentication token expired. Re-connect to retry.",
				completedAt: new Date().toISOString(),
			}),
		]);

		render(<JobHubPanel open onOpenChange={() => {}} />);

		expect(
			screen.getByText(
				"Authentication token expired. Re-connect to retry.",
			),
		).toBeInTheDocument();
	});

	it("separates active jobs from finished ones", () => {
		mockJobs([
			makeJob({ id: "running" }),
			makeJob({
				id: "done",
				status: "COMPLETED",
				title: "GitLab: fabric-backend",
				completedAt: new Date().toISOString(),
			}),
		]);

		render(<JobHubPanel open onOpenChange={() => {}} />);

		expect(screen.getByText("Active · 1")).toBeInTheDocument();
		expect(screen.getByText("Recent · 1")).toBeInTheDocument();
	});

	it("expands a running job's subtasks by default, with per-step status", () => {
		mockJobs([makeJob()]);

		render(<JobHubPanel open onOpenChange={() => {}} />);

		// Mid-run, the reason to open the panel is to see which step is slow.
		expect(screen.getByText("Fetch messages")).toBeInTheDocument();
		expect(screen.getByText("Analyze content")).toBeInTheDocument();
		expect(screen.getByText("Create proposals")).toBeInTheDocument();
		expect(screen.getByText("1/3 steps")).toBeInTheDocument();
	});

	it("explains what will appear when there are no jobs", () => {
		mockJobs([]);

		render(<JobHubPanel open onOpenChange={() => {}} />);

		expect(screen.getByText("No background jobs")).toBeInTheDocument();
		expect(
			screen.getByText(/monitors a Teams or Slack channel/),
		).toBeInTheDocument();
	});

	it("offers no cancellation control on a running job", () => {
		mockJobs([makeJob()]);

		render(<JobHubPanel open onOpenChange={() => {}} />);

		// Explicitly out of scope for this iteration — asserted so it cannot
		// arrive by accident with a later refactor.
		expect(
			screen.queryByRole("button", { name: /cancel/i }),
		).not.toBeInTheDocument();
	});

	it("surfaces the current project's jobs above other projects'", () => {
		mockJobs([
			makeJob({
				id: "other",
				projectId: "proj-2",
				projectName: "Other",
				title: "Slack · #random",
				startedAt: new Date().toISOString(),
			}),
			makeJob({
				id: "mine",
				projectId: "proj-1",
				title: "Teams · #general",
				startedAt: new Date(Date.now() - 60_000).toISOString(),
			}),
		]);

		render(<JobHubPanel open onOpenChange={() => {}} />);

		const titles = screen
			.getAllByText(/Teams · #general|Slack · #random/)
			.map((node) => node.textContent);
		// Newer, but from another project — the one you just triggered wins.
		expect(titles[0]).toBe("Teams · #general");
	});

	it("tells the user how long finished jobs stick around", () => {
		mockJobs([makeJob()]);

		render(<JobHubPanel open onOpenChange={() => {}} />);

		expect(
			screen.getByText("Finished jobs stay here for 7 days"),
		).toBeInTheDocument();
	});
});
