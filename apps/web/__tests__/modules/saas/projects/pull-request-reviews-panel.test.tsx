/**
 * `PullRequestReviewsPanel` — the affordance rules, not the presentation.
 *
 * Two things a reader of this component would plausibly get wrong, and both
 * would ship a control that only ever produces an error:
 *
 *   - a member who cannot edit must not be offered the read form at all. The
 *     server refuses them (TEST_CASE_UPDATE), so an enabled button here would
 *     be an invitation to a 403.
 *   - phase 1 reads GitHub only. A project whose repositories are all GitLab or
 *     Azure DevOps must be TOLD that, not shown a picker with nothing in it.
 *
 * The list rendering itself is asserted only far enough to prove a stored
 * review reaches the screen with its repository and number.
 */

import messages from "@repo/i18n/translations/en.json";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { state } = vi.hoisted(() => ({
	state: {
		sources: [] as Array<Record<string, unknown>>,
		reviews: [] as Array<Record<string, unknown>>,
	},
}));

/**
 * The global setup echoes translation keys back, which would make every
 * assertion below pass against `prReview.empty.title` whether or not that copy
 * exists. This resolves the REAL en.json instead, so a missing or renamed key
 * fails the test — which is most of what a render test of this panel is for.
 *
 * Handles the two ICU shapes this namespace uses: `{name}` substitution and the
 * `{count, plural, ...}` on the file count. Anything richer belongs in next-intl
 * itself, not in a test shim.
 */
vi.mock("next-intl", () => {
	const lookup = (path: string): string | undefined =>
		path
			.split(".")
			.reduce<unknown>(
				(node, key) =>
					node && typeof node === "object"
						? (node as Record<string, unknown>)[key]
						: undefined,
				messages,
			) as string | undefined;

	const format = (template: string, values: Record<string, unknown>) =>
		template
			.replace(
				/\{(\w+), plural,(.*?)\}$/,
				(_all, name: string, arms: string) => {
					const count = Number(values[name] ?? 0);
					const exact = new RegExp(`=${count}\\s*\\{([^}]*)\\}`).exec(
						arms,
					);
					const other = /other\s*\{([^}]*)\}/.exec(arms);
					return (exact?.[1] ?? other?.[1] ?? "").replace(
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

vi.mock("@tanstack/react-query", () => ({
	useQuery: (opts: { queryKey?: unknown[] }) => {
		const procedure = Array.isArray(opts?.queryKey)
			? opts.queryKey[0]
			: undefined;
		if (procedure === "projects.pipelineResults.sources") {
			return { data: { sources: state.sources }, isLoading: false };
		}
		if (procedure === "projects.pullRequestReviews.list") {
			return { data: { reviews: state.reviews }, isLoading: false };
		}
		return { data: undefined, isLoading: false };
	},
	useMutation: () => ({ mutate: vi.fn(), isPending: false }),
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@shared/lib/orpc-query-utils", () => {
	const queryOptions =
		(procedure: string) => (opts: { input?: unknown }) => ({
			queryKey: [procedure, opts?.input],
			queryFn: async () => undefined,
		});
	return {
		orpc: {
			projects: {
				pipelineResults: {
					sources: {
						queryOptions: queryOptions(
							"projects.pipelineResults.sources",
						),
					},
				},
				pullRequestReviews: {
					// The panel reads this to show how often each lens has been
					// dismissed. Stubbed empty: this file is about the read form and
					// the review list, and `LensAccuracy` has its own tests.
					lensStats: {
						queryOptions: queryOptions(
							"projects.pullRequestReviews.lensStats",
						),
						queryKey: () => [
							"projects.pullRequestReviews.lensStats",
						],
					},
					list: {
						queryOptions: queryOptions(
							"projects.pullRequestReviews.list",
						),
						queryKey: () => ["projects.pullRequestReviews.list"],
					},
					get: {
						queryOptions: queryOptions(
							"projects.pullRequestReviews.get",
						),
					},
					read: { mutationOptions: () => ({}) },
				},
			},
		},
	};
});

vi.mock("@shared/lib/orpc-client", () => ({ orpcClient: {} }));

import { PullRequestReviewsPanel } from "@saas/projects/components/test-cases/pr-review/PullRequestReviewsPanel";

const githubSource = {
	integrationId: "int-1",
	provider: "GITHUB",
	owner: "acme",
	repo: "store",
	defaultBranch: "main",
	qaBranch: null,
	effectiveBranch: "main",
};

describe("PullRequestReviewsPanel", () => {
	it("offers no read control to a member who cannot edit", () => {
		state.sources = [githubSource];
		state.reviews = [];

		render(<PullRequestReviewsPanel projectId="proj-1" canEdit={false} />);

		expect(
			screen.queryByRole("button", { name: /read pull request/i }),
		).toBeNull();
		expect(screen.queryByLabelText(/repository/i)).toBeNull();
	});

	it("offers a GitLab repository, because the server reads one", () => {
		// The panel filtered to GitHub while GitLab and Azure DevOps were
		// unimplemented server-side. They are implemented now — `providerFor`
		// resolves all three — so a filter here would hide a repository Fabric
		// can actually read.
		state.sources = [{ ...githubSource, provider: "GITLAB" }];
		state.reviews = [];

		render(<PullRequestReviewsPanel projectId="proj-1" canEdit={true} />);

		expect(
			screen.getByRole("button", { name: /read pull request/i }),
		).toBeVisible();
	});

	it("says no repository is connected rather than showing an empty picker", () => {
		state.sources = [];
		state.reviews = [];

		render(<PullRequestReviewsPanel projectId="proj-1" canEdit={true} />);

		expect(
			screen.getByText(/no code repository is connected/i),
		).toBeVisible();
		expect(
			screen.queryByRole("button", { name: /read pull request/i }),
		).toBeNull();
	});

	it("shows the read form when a GitHub repository is connected", () => {
		state.sources = [githubSource];
		state.reviews = [];

		render(<PullRequestReviewsPanel projectId="proj-1" canEdit={true} />);

		expect(
			screen.getByRole("button", { name: /read pull request/i }),
		).toBeVisible();
	});

	it("renders a stored review with its repository, number and file count", () => {
		state.sources = [githubSource];
		state.reviews = [
			{
				id: "rev-1",
				provider: "GITHUB",
				repoOwner: "acme",
				repoName: "store",
				prNumber: 42,
				title: "Add checkout retry",
				authorLabel: "dana",
				headSha: "a".repeat(40),
				prUrl: "https://github.com/acme/store/pull/42",
				changedFiles: 3,
				diffTruncated: false,
				status: "READ",
				failureText: null,
				createdAt: new Date().toISOString(),
			},
		];

		render(<PullRequestReviewsPanel projectId="proj-1" canEdit={false} />);

		expect(screen.getByText("Add checkout retry")).toBeVisible();
		expect(screen.getByText(/acme\/store #42/)).toBeVisible();
		expect(screen.getByText(/3 files/)).toBeVisible();
	});

	it("marks a truncated read so a partial diff does not read as a whole one", () => {
		state.sources = [githubSource];
		state.reviews = [
			{
				id: "rev-2",
				provider: "GITHUB",
				repoOwner: "acme",
				repoName: "store",
				prNumber: 7,
				title: "Regenerate client",
				authorLabel: null,
				headSha: "c".repeat(40),
				prUrl: null,
				changedFiles: 210,
				diffTruncated: true,
				status: "READ",
				failureText: null,
				createdAt: new Date().toISOString(),
			},
		];

		render(<PullRequestReviewsPanel projectId="proj-1" canEdit={false} />);

		expect(screen.getByText(/partial diff/i)).toBeVisible();
	});
});
