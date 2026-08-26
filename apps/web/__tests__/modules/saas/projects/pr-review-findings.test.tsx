/**
 * `PrReviewFindings` — the three review states, and who may act on them.
 *
 * Found untested by the QA review lens reviewing its own pull request (#2411):
 * the component shipped with no render test at all, and the distinction it exists
 * to draw is the one most easily lost.
 *
 * That distinction: an empty finding list means either "nobody has run this" or
 * "it ran and found nothing", and those are opposite messages. Collapsing them
 * turns an un-run lens into a clean bill of health — reassurance nobody earned.
 */

import messages from "@repo/i18n/translations/en.json";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * The global setup echoes translation keys back, which would make every assertion
 * here pass against a key whether or not the copy exists. Resolving the real
 * en.json means a renamed or missing string fails the test — which for a component
 * whose entire job is saying the right sentence is most of the value.
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
		template.replace(/\{(\w+)\}/g, (_all, name: string) =>
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
	useMutation: (opts: { mutationKey?: unknown }) => {
		// Distinguished by nothing but call order in the component, so all three
		// share an inert stub; these tests assert rendering, not dispatch.
		void opts;
		return { mutate: vi.fn(), isPending: false };
	},
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			pullRequestReviews: {
				get: { queryKey: () => ["get"] },
				analyseQa: { mutationOptions: () => ({}) },
				analyseArchitecture: { mutationOptions: () => ({}) },
				judgeFinding: { mutationOptions: () => ({}) },
				postComment: { mutationOptions: () => ({}) },
			},
		},
	},
}));

vi.mock("@shared/lib/orpc-client", () => ({ orpcClient: {} }));

import { PrReviewFindings } from "@saas/projects/components/test-cases/pr-review/PrReviewFindings";

const QA_FINDING = {
	id: "f-1",
	lens: "QA",
	severity: "MEDIUM",
	title: "Retry path is untested",
	detail: "The new retry branch has no case asserting a single capture.",
	recommendation:
		"Add a case that retries a failed capture twice and asserts one charge.",
	filePath: "src/payments/capture.ts",
	criterionRef: "AC 2",
	status: "OPEN",
	model: "gpt-4.1-mini",
};

const ARCH_FINDING = {
	id: "f-2",
	lens: "ARCHITECTURE",
	severity: "HIGH",
	title: "Circular import: a.ts ↔ b.ts",
	detail: "2 files import each other in a cycle.",
	recommendation:
		"Break one edge in the cycle: move what a.ts needs from b.ts.",
	filePath: "a.ts",
	criterionRef: null,
	status: "OPEN",
	model: null,
};

function renderPanel(
	over: Partial<Parameters<typeof PrReviewFindings>[0]> = {},
) {
	return render(
		<PrReviewFindings
			projectId="proj-1"
			reviewId="rev-1"
			findings={[]}
			analysedAt={null}
			analysisModel={null}
			architectureAnalysedAt={null}
			hasDiff={true}
			canEdit={true}
			{...over}
		/>,
	);
}

describe("the three review states", () => {
	it("says NOT REVIEWED when the lens has never run", () => {
		renderPanel({ analysedAt: null });

		expect(screen.getByText(/not reviewed yet/i)).toBeVisible();
		// Crucially it must NOT claim a clean result.
		expect(screen.queryByText(/no coverage gaps found/i)).toBeNull();
	});

	it("says REVIEWED AND CLEAN, with a timestamp, when it ran and found nothing", () => {
		renderPanel({ analysedAt: new Date().toISOString(), findings: [] });

		expect(screen.getByText(/no coverage gaps found/i)).toBeVisible();
		expect(screen.queryByText(/not reviewed yet/i)).toBeNull();
	});

	it("renders the findings when it has them", () => {
		renderPanel({
			analysedAt: new Date().toISOString(),
			findings: [QA_FINDING],
		});

		expect(screen.getByText("Retry path is untested")).toBeVisible();
		expect(screen.getByText("src/payments/capture.ts")).toBeVisible();
		expect(screen.getByText("AC 2")).toBeVisible();
		expect(screen.queryByText(/no coverage gaps found/i)).toBeNull();
	});

	it("says there is nothing to review when no diff was stored — in BOTH sections", () => {
		renderPanel({ hasDiff: false });

		// Both lenses report it independently rather than one banner covering the
		// panel: each section owns its own state, so a reader who scrolls to the
		// architecture heading is not left wondering why it says nothing.
		expect(screen.getAllByText(/nothing to review/i)).toHaveLength(2);
	});
});

describe("the architecture section is independent", () => {
	it("keeps its own not-run state while QA has findings", () => {
		renderPanel({
			analysedAt: new Date().toISOString(),
			findings: [QA_FINDING],
			architectureAnalysedAt: null,
		});

		expect(screen.getByText("Retry path is untested")).toBeVisible();
		expect(screen.getByText(/not checked yet/i)).toBeVisible();
	});

	it("shows each lens only its OWN findings", () => {
		// Guards the shared LensSection refactor: both sections read one list and
		// filter by lens, so a broken filter would duplicate every finding.
		renderPanel({
			analysedAt: new Date().toISOString(),
			architectureAnalysedAt: new Date().toISOString(),
			findings: [QA_FINDING, ARCH_FINDING],
		});

		expect(screen.getAllByText("Retry path is untested")).toHaveLength(1);
		expect(screen.getAllByText(/Circular import/)).toHaveLength(1);
	});

	it("states no provenance for the computed lens", () => {
		// The QA lens names its model because it is a guess. The architecture lens
		// computes, so attributing a model would be a lie about where it came from.
		renderPanel({
			analysedAt: new Date().toISOString(),
			analysisModel: "gpt-4.1-mini",
			architectureAnalysedAt: new Date().toISOString(),
			findings: [QA_FINDING, ARCH_FINDING],
		});

		expect(screen.getAllByText(/Reviewed by gpt-4.1-mini/)).toHaveLength(1);
	});
});

describe("permission gating", () => {
	it("offers no run or judgement controls to a member who cannot edit", () => {
		renderPanel({
			canEdit: false,
			analysedAt: new Date().toISOString(),
			findings: [QA_FINDING],
		});

		// The findings themselves stay readable — read-only is not invisible.
		expect(screen.getByText("Retry path is untested")).toBeVisible();
		for (const name of [
			/review for test coverage/i,
			/check circular imports/i,
			/^accept$/i,
			/^dismiss$/i,
		]) {
			expect(screen.queryByRole("button", { name })).toBeNull();
		}
	});

	it("offers both run controls and accept/dismiss to an editor", () => {
		renderPanel({
			analysedAt: new Date().toISOString(),
			findings: [QA_FINDING],
		});

		expect(
			screen.getByRole("button", { name: /review for test coverage/i }),
		).toBeVisible();
		expect(
			screen.getByRole("button", { name: /check circular imports/i }),
		).toBeVisible();
		expect(screen.getByRole("button", { name: /^accept$/i })).toBeVisible();
		expect(
			screen.getByRole("button", { name: /^dismiss$/i }),
		).toBeVisible();
	});

	it("offers Reopen instead of Accept once a finding has been judged", () => {
		renderPanel({
			analysedAt: new Date().toISOString(),
			findings: [{ ...QA_FINDING, status: "DISMISSED" }],
		});

		expect(screen.getByRole("button", { name: /reopen/i })).toBeVisible();
		expect(screen.queryByRole("button", { name: /^accept$/i })).toBeNull();
		// The judged state is stated, not merely implied by the missing buttons.
		expect(screen.getByText(/dismissed/i)).toBeVisible();
	});

	it("shows the remediation apart from the diagnosis", () => {
		renderPanel({
			analysedAt: new Date().toISOString(),
			findings: [QA_FINDING],
		});

		expect(screen.getByText(/recommendation/i)).toBeVisible();
		expect(
			screen.getByText(
				/retries a failed capture twice and asserts one charge/i,
			),
		).toBeVisible();
	});

	// Findings stored before the column existed have none. A label with nothing
	// after it reads as a lens that failed rather than a row that predates the
	// field.
	it("renders no remediation label on a finding that carries none", () => {
		renderPanel({
			analysedAt: new Date().toISOString(),
			findings: [{ ...QA_FINDING, recommendation: null }],
		});

		expect(screen.queryByText(/recommendation/i)).toBeNull();
		expect(screen.getByText(QA_FINDING.title)).toBeVisible();
	});

	it("offers to post the review only once a lens has run", () => {
		// Posting from a review nobody reviewed would write "no open findings" into
		// somebody else's pull request — reassurance nobody earned, published.
		const { rerender } = renderPanel({ analysedAt: null });
		expect(
			screen.queryByRole("button", { name: /post to pull request/i }),
		).toBeNull();

		rerender(
			<PrReviewFindings
				projectId="proj-1"
				reviewId="rev-1"
				findings={[QA_FINDING]}
				analysedAt={new Date().toISOString()}
				analysisModel={null}
				architectureAnalysedAt={null}
				hasDiff={true}
				canEdit={true}
			/>,
		);
		expect(
			screen.getByRole("button", { name: /post to pull request/i }),
		).toBeVisible();
	});

	it("offers no posting control to a member who cannot edit", () => {
		renderPanel({
			canEdit: false,
			analysedAt: new Date().toISOString(),
			findings: [QA_FINDING],
		});

		expect(
			screen.queryByRole("button", { name: /post to pull request/i }),
		).toBeNull();
	});

	it("names the review's provenance only when a model produced it", () => {
		// Guards the pair the panel draws: the QA lens attributes its model, the
		// architecture lens computes and must attribute nothing.
		renderPanel({
			analysedAt: new Date().toISOString(),
			architectureAnalysedAt: new Date().toISOString(),
			analysisModel: "gpt-4.1-mini",
			findings: [QA_FINDING, ARCH_FINDING],
		});

		expect(screen.getAllByText(/Reviewed by gpt-4.1-mini/)).toHaveLength(1);
	});

	it("disables the run controls when there is no diff to review", () => {
		renderPanel({ hasDiff: false });

		expect(
			screen.getByRole("button", { name: /review for test coverage/i }),
		).toBeDisabled();
		expect(
			screen.getByRole("button", { name: /check circular imports/i }),
		).toBeDisabled();
	});
});
