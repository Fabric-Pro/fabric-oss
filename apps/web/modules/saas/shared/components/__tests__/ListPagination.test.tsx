import de from "@repo/i18n/translations/de.json";
import en from "@repo/i18n/translations/en.json";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	input: {} as Record<string, unknown>,
	locale: "en" as "en" | "de",
}));
vi.mock("next-intl", async () => {
	const actual =
		await vi.importActual<typeof import("next-intl")>("next-intl");
	return {
		...actual,
		useLocale: () => state.locale,
		useTranslations: (namespace: string) =>
			actual.createTranslator({
				locale: state.locale,
				messages: state.locale === "de" ? de : en,
				namespace,
			}),
	};
});
vi.mock("@saas/organizations/hooks", () => ({
	useEffectiveOrganizationId: () => "example-org",
}));
vi.mock("@shared/lib/orpc-query-utils", () => {
	const node = (): unknown =>
		new Proxy(() => {}, {
			get: (_target, key) =>
				key === "queryOptions"
					? (options: { input: unknown }) => options
					: key === "mutationOptions"
						? () => ({})
						: node(),
		});
	return { orpc: node() };
});
vi.mock("@tanstack/react-query", () => ({
	keepPreviousData: (previous: unknown) => previous,
	useQuery: (options: { input: Record<string, unknown> }) => {
		state.input = options.input;
		return {
			data: {
				instances: [
					{
						id: "example-instance",
						name: "Example report",
						templateName: "Example template",
						status: "ACTIVE",
						executionCount: 0,
						createdAt: "2026-01-01",
						updatedAt: "2026-01-01",
					},
				],
				sends: [],
				tickets: [],
				total: 120,
			},
			isLoading: false,
			refetch: vi.fn(),
		};
	},
	useMutation: () => ({ isPending: false, mutate: vi.fn() }),
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import { CasesPagination } from "@saas/projects/components/test-cases/CasesTable";
import { PmImportDialog } from "@saas/projects/components/test-cases/PmImportDialog";
import { ArtifactDeliveryHistoryDialog } from "@saas/reports/components/ArtifactDeliveryHistoryDialog";
import { TemplateInstancesList } from "@saas/reports/components/TemplateInstancesList";

afterEach(() => {
	cleanup();
	state.locale = "en";
});
it("pages report instances on the server beyond the first 50", async () => {
	render(
		<NuqsTestingAdapter>
			<TemplateInstancesList />
		</NuqsTestingAdapter>,
	);
	await userEvent.type(screen.getByRole("spinbutton"), "7{Enter}");
	expect(state.input).toMatchObject({ offset: 60, limit: 10 });
});
it("jumps to an artifact delivery page", async () => {
	render(
		<ArtifactDeliveryHistoryDialog
			artifactId="example-artifact"
			artifactName="Example report"
			open
			onOpenChange={vi.fn()}
		/>,
	);
	expect(
		document.body.textContent?.match(/1\s*[-–]\s*10\s+of\s+120/g),
	).toHaveLength(1);
	await userEvent.type(screen.getByRole("spinbutton"), "4{Enter}");
	expect(state.input).toMatchObject({ offset: 30, limit: 10 });
});
it("jumps to a PM import page and resets on committed search", async () => {
	render(
		<PmImportDialog
			projectId="example-project"
			open
			onOpenChange={vi.fn()}
		/>,
	);
	await userEvent.type(screen.getByRole("spinbutton"), "3{Enter}");
	expect(state.input).toMatchObject({ page: 3, pageSize: 30 });
	await userEvent.type(screen.getByRole("searchbox"), "example{Enter}");
	expect(state.input).toMatchObject({ page: 1, search: "example" });
});
it("jumps through the cases pager and keeps its onboarding anchor", async () => {
	const onPage = vi.fn();
	const { container } = render(
		<CasesPagination
			page={1}
			pageSize={25}
			note="Example note"
			total={120}
			onPage={onPage}
			onPageSize={vi.fn()}
		/>,
	);
	await userEvent.type(screen.getByRole("spinbutton"), "4{Enter}");
	expect(onPage).toHaveBeenCalledWith(4);
	expect(screen.getAllByText("1–25 of 120 cases")).toHaveLength(1);
	expect(screen.getByText("Example note")).toBeInTheDocument();
	expect(
		screen.getAllByRole("navigation", { name: "Test case pages" }),
	).toHaveLength(1);
	expect(
		container.querySelector(
			'[data-onboarding-target="test-cases-pagination"]',
		),
	).toContainElement(screen.getByRole("spinbutton"));
});

import { MeetingCandidatesStrip } from "@saas/projects/components/decisions/DecisionsList";

it("jumps to the requested candidate rows", async () => {
	const candidates = Array.from({ length: 35 }, (_, index) => ({
		transcriptId: `example-transcript-${index}`,
		decisionIndex: index,
		text: `Example candidate ${index}`,
		meetingSubject: "Example meeting",
		meetingDate: null,
	}));
	render(
		<NuqsTestingAdapter>
			<MeetingCandidatesStrip
				candidates={candidates}
				projectId="example-project"
				canEdit={false}
				creating={false}
				dismissing={false}
				onCreate={vi.fn()}
				onDismiss={vi.fn()}
				onOpenDecision={vi.fn()}
			/>
		</NuqsTestingAdapter>,
	);
	await userEvent.click(
		screen.getByRole("button", { name: /detected in recent meetings/ }),
	);
	await userEvent.type(screen.getByRole("spinbutton"), "3{Enter}");
	expect(screen.getByText("Example candidate 20")).toBeInTheDocument();
	expect(screen.queryByText("Example candidate 0")).not.toBeInTheDocument();
});

import { PullFromPMDialog } from "@saas/projects/components/stories/PullFromPMDialog";

it.each([
	{
		name: "cases",
		navigation: "Testfall-Seiten",
		range: "1–25 von 120 Fällen",
		pageLabel: "Zu Seite 1",
		lastPage: 5,
		renderPager: () => (
			<CasesPagination
				page={1}
				pageSize={25}
				total={120}
				onPage={vi.fn()}
				onPageSize={vi.fn()}
			/>
		),
	},
	{
		name: "PM import",
		navigation: "Seiten der PM-Testfälle",
		range: "Seite 1 · 120 gesamt",
		pageLabel: "Seite 1",
		lastPage: 4,
		renderPager: () => (
			<PmImportDialog
				projectId="example-project"
				open
				onOpenChange={vi.fn()}
			/>
		),
	},
	{
		name: "PM tickets",
		navigation: "Seiten der PM-Tickets",
		range: "1–20 von 120 Tickets",
		pageLabel: "Seite 1",
		lastPage: 6,
		renderPager: () => (
			<PullFromPMDialog
				projectId="example-project"
				organizationId={null}
				open
				onClose={vi.fn()}
				onConfirm={vi.fn()}
				pmToolName="Example PM"
			/>
		),
	},
])(
	"keeps $name pagination fully German, including validation",
	async ({ navigation, range, pageLabel, lastPage, renderPager }) => {
		state.locale = "de";
		render(renderPager());
		expect(
			screen.getByRole("navigation", { name: navigation }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: pageLabel }),
		).toBeInTheDocument();
		expect(screen.getAllByText(range)).toHaveLength(1);
		const input = screen.getByRole("spinbutton", {
			name: `Gehe zu Seite, ${navigation}`,
		});
		expect(
			screen.getByRole("button", { name: `Los, ${navigation}` }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Previous page" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Next page" }),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", {
				name:
					navigation === "Seiten der PM-Testfälle"
						? "Zurück"
						: "Vorherige Seite",
			}),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", {
				name:
					navigation === "Seiten der PM-Testfälle"
						? "Weiter"
						: "Nächste Seite",
			}),
		).toBeInTheDocument();
		await userEvent.type(input, "999{Enter}");
		expect(screen.getByRole("alert")).toHaveTextContent(
			`Gib eine Seite von 1 bis ${lastPage} ein`,
		);
	},
);

it("keeps the three pagination namespaces in parity between English and German", () => {
	for (const [english, german] of [
		[en.projects.testCases.pagination, de.projects.testCases.pagination],
		[en.projects.testCases.import, de.projects.testCases.import],
		[
			Object.fromEntries(
				Object.entries(en.tooltips.stories).filter(([key]) =>
					/^pullFromPm(PaginationAria|JumpLabel|Go|RangeError|PageLabel|Range|PreviousPage|NextPage)$/.test(
						key,
					),
				),
			),
			Object.fromEntries(
				Object.entries(de.tooltips.stories).filter(([key]) =>
					/^pullFromPm(PaginationAria|JumpLabel|Go|RangeError|PageLabel|Range|PreviousPage|NextPage)$/.test(
						key,
					),
				),
			),
		],
	]) {
		expect(Object.keys(german).sort()).toEqual(Object.keys(english).sort());
	}
});

it.each([0, 10])(
	"keeps the cases note and single-page/empty range for %i cases",
	(total) => {
		const { container } = render(
			<CasesPagination
				page={1}
				pageSize={25}
				total={total}
				note="Example note"
				onPage={vi.fn()}
				onPageSize={vi.fn()}
			/>,
		);
		expect(screen.getByText(/Example note/)).toBeInTheDocument();
		expect(
			screen.getByText(total ? /1–10 of 10 cases/ : /No cases/),
		).toBeInTheDocument();
		expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
		expect(
			container.querySelector(
				'[data-onboarding-target="test-cases-pagination"]',
			)?.tagName,
		).toBe("DIV");
	},
);
