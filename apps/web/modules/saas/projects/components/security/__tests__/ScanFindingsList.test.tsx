import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────
// Drive the two findings.list reads (findings + summary). We return the same
// data for both; the component narrows the summary differently but for these
// tests one dataset is enough.
const useQueryMock = vi.fn();
const useMutationMock = vi.fn();
const invalidateMock = vi.fn();

vi.mock("@tanstack/react-query", () => ({
	useQuery: (...args: unknown[]) => useQueryMock(...args),
	useMutation: (...args: unknown[]) => useMutationMock(...args),
	useQueryClient: () => ({ invalidateQueries: invalidateMock }),
}));

// A thin orpc stub — every leaf returns queryOptions/mutationOptions/key so the
// component can build inputs; the actual data comes from useQueryMock. The
// factory is hoisted above module scope, so `passthrough` is defined inside it.
vi.mock("@shared/lib/orpc-query-utils", () => {
	const passthrough = {
		queryOptions: (opts: unknown) => opts,
		mutationOptions: (opts: unknown) => opts,
		key: () => ["k"],
	};
	return {
		orpc: {
			projects: {
				scan: {
					findings: {
						list: passthrough,
						update: passthrough,
						bulkUpdate: passthrough,
					},
					review: {
						latest: passthrough,
						start: passthrough,
						apply: passthrough,
					},
					// Theme view reads the latest grouping run to resolve each
					// theme's ticket link (Task A).
					grouping: {
						latest: passthrough,
					},
					// Findings-history dialog rendered (closed) by ScanFindingsList.
					activity: passthrough,
				},
				stories: {
					setBlocked: passthrough,
					list: passthrough,
					get: passthrough,
				},
			},
		},
	};
});

// Stub the review button so we don't need to mock the review procedures here;
// its own behavior is covered by ReviewProposalsDialog tests.
vi.mock("../ReviewFindingsButton", () => ({
	ReviewFindingsButton: () => <button type="button">Review findings</button>,
}));

// Stub the grouping button for the same reason — its own behavior (config
// gate, poll, results dialog) is covered by GroupIntoTicketsButton's own tests.
vi.mock("../GroupIntoTicketsButton", () => ({
	GroupIntoTicketsButton: () => (
		<button type="button">Group into tickets</button>
	),
}));

// The real Security view is a CLIENT-SIDE tab, so `usePathname()` returns the
// project ROOT (…/projects/<id>) — it does NOT end in `/security`. Mock that
// realistic URL so the finding→story link assertions reflect production (the
// old `/app/proj-1/security` mock hid the bug where the href stayed at root).
vi.mock("next/navigation", () => ({
	usePathname: () => "/app/example-org/projects/proj-1",
}));

import { ScanFindingsList } from "../ScanFindingsList";

beforeAll(() => {
	HTMLElement.prototype.hasPointerCapture ??= () => false;
	HTMLElement.prototype.setPointerCapture ??= () => {};
	HTMLElement.prototype.releasePointerCapture ??= () => {};
	HTMLElement.prototype.scrollIntoView ??= () => {};
});

type FindingSeed = {
	id: string;
	title: string;
	severity: string;
	category?: string;
	status?: string;
	location?: string | null;
	confidence?: number | null;
	ruleSource?: string;
	remediation?: string;
	story?: { id: string; identifier: string } | null;
};

function finding(seed: FindingSeed) {
	return {
		category: "SECURITY",
		status: "OPEN",
		ruleSource: "OWASP Top 10 — A03:2021 Injection",
		description: `Description for ${seed.title}`,
		remediation: "Fix it.",
		location: null,
		sourceUrl: null,
		storyId: seed.story?.id ?? null,
		story: null,
		isCustomRule: false,
		confidence: null,
		fingerprint: null,
		firstDetectedAt: null,
		...seed,
	};
}

/**
 * Two findings in feature F-1 (CRITICAL + HIGH) → a multi-finding GROUP whose
 * effective severity is its MAX (Critical). One finding in F-2 (MEDIUM) → a
 * SINGLETON (not grouped), which sits in the Medium section.
 */
const FINDINGS = [
	finding({
		id: "a",
		title: "SQL injection",
		severity: "CRITICAL",
		location: "Feature F-1",
	}),
	finding({
		id: "b",
		title: "Missing auth check",
		severity: "HIGH",
		location: "Feature F-1",
	}),
	finding({
		id: "c",
		title: "Weak password policy",
		severity: "MEDIUM",
		location: "Feature F-2",
	}),
];

/** Wire useQuery to return FINDINGS for every findings.list call. */
function primeFindings(data = FINDINGS) {
	useQueryMock.mockReturnValue({
		data: { findings: data },
		isLoading: false,
	});
}

const bulkMutateMock = vi.fn();

beforeEach(() => {
	useQueryMock.mockReset();
	useMutationMock.mockReset();
	invalidateMock.mockReset();
	bulkMutateMock.mockReset();

	// Default: every useMutation returns an inert mutation. The bulkUpdate one
	// is identified by the presence of its onSuccess handler shape — simplest is
	// to give them all the same mock but capture the bulk call via the component
	// calling `.mutate` with findingIds.
	useMutationMock.mockImplementation(
		(opts: { mutationOptions?: unknown }) => ({
			mutate: (vars: unknown) => {
				// Route bulk calls (they carry findingIds) to the bulk spy.
				if (vars && typeof vars === "object" && "findingIds" in vars) {
					bulkMutateMock(vars);
				}
				void opts;
			},
			isPending: false,
			variables: undefined,
		}),
	);
});

function renderList() {
	render(
		<ScanFindingsList
			projectId="proj-1"
			organizationId={null}
			latestScan={null}
			scanInFlight={false}
		/>,
	);
}

/** The F-1 group's disclosure button (name concatenates its badges + label). */
function groupButton(name: RegExp) {
	return screen.getByRole("button", { name });
}

describe("ScanFindingsList — engine filter (G12)", () => {
	it("offers an engine/scanner filter with all four engines", async () => {
		const user = userEvent.setup();
		primeFindings();
		renderList();

		const scannerSelect = screen.getByLabelText("Scanner");
		await user.click(scannerSelect);

		for (const label of [
			"AI Security",
			"AI Accessibility",
			"Semgrep",
			"Git history",
		]) {
			expect(
				await screen.findByRole("option", { name: label }),
			).toBeInTheDocument();
		}
	});

	it("offers a confidence sort option", async () => {
		const user = userEvent.setup();
		primeFindings();
		renderList();
		await user.click(screen.getByLabelText("Sort by"));
		expect(
			await screen.findByRole("option", { name: "Confidence" }),
		).toBeInTheDocument();
	});
});

describe("ScanFindingsList — severity sections + grouping (G9)", () => {
	it("renders a severity-section heading per non-empty severity with its count", () => {
		primeFindings();
		renderList();

		// F-1 group (max=Critical) → Critical section; F-2 singleton → Medium.
		const critical = screen.getByRole("heading", { name: /critical/i });
		expect(critical).toHaveTextContent(/2 findings/);
		const medium = screen.getByRole("heading", { name: /medium/i });
		expect(medium).toHaveTextContent(/1 finding/);

		// No High / Low sections — those severities have no items of their own
		// (the HIGH finding lives inside the Critical group).
		expect(
			screen.queryByRole("heading", { name: /^high/i }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("heading", { name: /^low/i }),
		).not.toBeInTheDocument();
	});

	it("does NOT group a singleton — a lone finding renders as a bare row, not a group", () => {
		primeFindings();
		renderList();

		// The single F-2 finding is always visible (no collapsed group hides it).
		expect(screen.getByText("Weak password policy")).toBeInTheDocument();

		// There is no F-2 disclosure/group button — only F-1 is a group.
		expect(
			screen.queryByRole("button", { name: /F-2/ }),
		).not.toBeInTheDocument();
		expect(groupButton(/F-1/)).toBeInTheDocument();
	});

	it("collapses a multi-finding group BY DEFAULT and shows the count chip", () => {
		primeFindings();
		renderList();

		const f1 = groupButton(/F-1/);
		// Collapsed by default.
		expect(f1).toHaveAttribute("aria-expanded", "false");
		// Count chip on the group card.
		expect(f1).toHaveTextContent(/2 findings/);
		// Members are hidden until expanded.
		expect(screen.queryByText("SQL injection")).not.toBeInTheDocument();
		expect(
			screen.queryByText("Missing auth check"),
		).not.toBeInTheDocument();
	});

	it("places a group in the section of its MAX severity, keeping all members inside", async () => {
		const user = userEvent.setup();
		primeFindings();
		renderList();

		// The F-1 group (Critical + High) badges as Critical on its card…
		const f1 = groupButton(/F-1/);
		expect(f1).toHaveTextContent(/Critical/);

		// …and expanding it reveals BOTH the Critical and the High member.
		await user.click(f1);
		expect(f1).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByText("SQL injection")).toBeInTheDocument();
		expect(screen.getByText("Missing auth check")).toBeInTheDocument();
	});

	it("collapses and re-expands a group without losing its findings", async () => {
		const user = userEvent.setup();
		primeFindings();
		renderList();

		const f1 = groupButton(/F-1/);
		// Expand first (default is collapsed now).
		await user.click(f1);
		expect(f1).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByText("SQL injection")).toBeInTheDocument();

		// Collapse → members hidden.
		await user.click(f1);
		expect(f1).toHaveAttribute("aria-expanded", "false");
		expect(screen.queryByText("SQL injection")).not.toBeInTheDocument();

		// Re-expand → members come back (nothing lost).
		await user.click(f1);
		expect(screen.getByText("SQL injection")).toBeInTheDocument();
		expect(screen.getByText("Missing auth check")).toBeInTheDocument();
	});

	it("expand-all opens every group; collapse-all returns to default (singletons stay visible)", async () => {
		const user = userEvent.setup();
		primeFindings();
		renderList();

		// Default collapsed: group members hidden, singleton visible.
		expect(screen.queryByText("SQL injection")).not.toBeInTheDocument();
		expect(screen.getByText("Weak password policy")).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: /expand all/i }));
		expect(screen.getByText("SQL injection")).toBeInTheDocument();
		expect(screen.getByText("Missing auth check")).toBeInTheDocument();
		expect(screen.getByText("Weak password policy")).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: /collapse all/i }));
		expect(screen.queryByText("SQL injection")).not.toBeInTheDocument();
		// The singleton is unaffected by collapse-all.
		expect(screen.getByText("Weak password policy")).toBeInTheDocument();
	});

	it("gives expanded group members and singletons full-width text (no max-w-prose)", async () => {
		const user = userEvent.setup();
		primeFindings();
		renderList();

		// Singleton: expand its row, assert the description is not width-capped.
		const singletonExpander = screen.getByRole("button", {
			name: /expand finding: Weak password policy/i,
		});
		await user.click(singletonExpander);
		const singletonDesc = screen.getByText(
			"Description for Weak password policy",
		);
		expect(singletonDesc.className).not.toMatch(/max-w-prose/);

		// Group member: expand the group, then the member row.
		await user.click(groupButton(/F-1/));
		await user.click(
			screen.getByRole("button", {
				name: /expand finding: SQL injection/i,
			}),
		);
		const memberDesc = screen.getByText("Description for SQL injection");
		expect(memberDesc.className).not.toMatch(/max-w-prose/);
	});
});

describe("ScanFindingsList — theme tag + theme filter", () => {
	// Three findings across THREE distinct themes (ruleSources), each with its own
	// location so they render as bare singleton rows (all visible at once).
	const MULTI_THEME = [
		finding({
			id: "a",
			title: "SQL injection",
			severity: "CRITICAL",
			location: "Feature F-1",
			ruleSource: "OWASP A03 Injection",
		}),
		finding({
			id: "x",
			title: "Reflected XSS",
			severity: "HIGH",
			location: "Feature F-2",
			ruleSource: "OWASP A07 XSS",
		}),
		finding({
			id: "s",
			title: "Hardcoded secret",
			severity: "MEDIUM",
			location: "packages/api/keys.ts",
			ruleSource: "Secret history: AWS access key",
		}),
	];

	/**
	 * Wire useQuery so the findings/summary reads return `findings` while the
	 * grouping-latest read (the only one carrying `enabled`) returns a COMPLETED
	 * run whose `results` carry the given theme entries.
	 */
	function primeThemeView(
		data: ReturnType<typeof finding>[],
		results: unknown | null,
	) {
		useQueryMock.mockImplementation((opts: { enabled?: unknown }) => {
			if (opts && typeof opts === "object" && "enabled" in opts) {
				return {
					data: {
						grouping: results
							? { status: "COMPLETED", results }
							: null,
					},
					isLoading: false,
				};
			}
			return { data: { findings: data }, isLoading: false };
		});
	}

	it("renders a clickable theme tag on each visible finding row", () => {
		primeFindings(MULTI_THEME);
		renderList();

		for (const rs of [
			"OWASP A03 Injection",
			"OWASP A07 XSS",
			"Secret history: AWS access key",
		]) {
			expect(
				screen.getByRole("button", {
					name: `Filter findings by theme: ${rs}`,
				}),
			).toBeInTheDocument();
		}
	});

	it("clicking a finding's theme tag narrows the list to that theme", async () => {
		const user = userEvent.setup();
		primeFindings(MULTI_THEME);
		renderList();

		// All three findings shown initially.
		expect(screen.getByText("SQL injection")).toBeInTheDocument();
		expect(screen.getByText("Reflected XSS")).toBeInTheDocument();
		expect(screen.getByText("Hardcoded secret")).toBeInTheDocument();

		await user.click(
			screen.getByRole("button", {
				name: "Filter findings by theme: OWASP A07 XSS",
			}),
		);

		// Only the XSS finding remains; the other themes are filtered out.
		expect(screen.getByText("Reflected XSS")).toBeInTheDocument();
		expect(screen.queryByText("SQL injection")).not.toBeInTheDocument();
		expect(screen.queryByText("Hardcoded secret")).not.toBeInTheDocument();
	});

	it("offers a Theme filter dropdown listing distinct themes with counts", async () => {
		const user = userEvent.setup();
		primeFindings(MULTI_THEME);
		renderList();

		await user.click(screen.getByLabelText("Theme"));

		expect(
			await screen.findByRole("option", { name: /All themes/ }),
		).toBeInTheDocument();
		// Each distinct theme is listed with its finding count.
		expect(
			await screen.findByRole("option", {
				name: /OWASP A03 Injection \(1\)/,
			}),
		).toBeInTheDocument();
		expect(
			await screen.findByRole("option", {
				name: /Secret history: AWS access key \(1\)/,
			}),
		).toBeInTheDocument();
	});

	it("narrows the list when a theme is picked from the dropdown", async () => {
		const user = userEvent.setup();
		primeFindings(MULTI_THEME);
		renderList();

		await user.click(screen.getByLabelText("Theme"));
		await user.click(
			await screen.findByRole("option", {
				name: /Secret history: AWS access key/,
			}),
		);

		expect(screen.getByText("Hardcoded secret")).toBeInTheDocument();
		expect(screen.queryByText("SQL injection")).not.toBeInTheDocument();
		expect(screen.queryByText("Reflected XSS")).not.toBeInTheDocument();
	});

	it("clears an active theme filter back to all findings", async () => {
		const user = userEvent.setup();
		primeFindings(MULTI_THEME);
		renderList();

		// Activate a theme via its row tag…
		await user.click(
			screen.getByRole("button", {
				name: "Filter findings by theme: Secret history: AWS access key",
			}),
		);
		expect(screen.getByText("Hardcoded secret")).toBeInTheDocument();
		expect(screen.queryByText("SQL injection")).not.toBeInTheDocument();

		// …then the clear affordance resets to every finding.
		await user.click(
			screen.getByRole("button", { name: /clear theme filter/i }),
		);
		expect(screen.getByText("SQL injection")).toBeInTheDocument();
		expect(screen.getByText("Reflected XSS")).toBeInTheDocument();
		expect(screen.getByText("Hardcoded secret")).toBeInTheDocument();
	});

	it("hides the Theme filter control when only one theme is present", () => {
		// The default FINDINGS all share one ruleSource → nothing to filter.
		primeFindings();
		renderList();
		expect(screen.queryByLabelText("Theme")).not.toBeInTheDocument();
	});

	it("links a finding to the ticket its theme was grouped into (tenant-aware)", () => {
		primeThemeView(MULTI_THEME, {
			createdThemes: [
				{
					category: "SECURITY",
					ruleSource: "Secret history: AWS access key",
					themeKey: "theme-secret-history",
					findingCount: 1,
					storyId: "story-77",
					storyIdentifier: "B-12",
				},
			],
		});
		renderList();

		// The secret-history finding links straight to its grouped ticket; the
		// project-root pathname mock "/app/example-org/projects/proj-1" →
		// "/app/example-org/projects/proj-1/stories/story-77".
		const ticketLink = screen.getByRole("link", { name: /B-12/ });
		expect(ticketLink).toHaveAttribute(
			"href",
			"/app/example-org/projects/proj-1/stories/story-77",
		);
	});
});

describe("ScanFindingsList — summary bar TOTAL", () => {
	it("shows a TOTAL stat counting every finding in the current view", () => {
		primeFindings();
		renderList();

		// The TOTAL label is present and its value is the total finding count (3).
		const totalLabel = screen.getByText("Total");
		const stat = totalLabel.parentElement as HTMLElement;
		expect(within(stat).getByText("3")).toBeInTheDocument();
	});

	it("counts resolved + dismissed findings in the TOTAL, not just open ones", () => {
		// One open, one resolved, one dismissed → TOTAL is still 3.
		primeFindings([
			finding({ id: "o", title: "Open one", severity: "HIGH" }),
			finding({
				id: "r",
				title: "Resolved one",
				severity: "LOW",
				status: "RESOLVED",
			}),
			finding({
				id: "d",
				title: "Dismissed one",
				severity: "LOW",
				status: "DISMISSED",
			}),
		]);
		renderList();

		const stat = screen.getByText("Total").parentElement as HTMLElement;
		expect(within(stat).getByText("3")).toBeInTheDocument();
	});
});

describe("ScanFindingsList — bulk bar (G8)", () => {
	it("reveals the bulk bar when a finding is selected and applies across the selection", async () => {
		const user = userEvent.setup();
		primeFindings();
		renderList();

		// No bulk bar until something is selected.
		expect(
			screen.queryByRole("region", {
				name: /bulk actions for selected findings/i,
			}),
		).not.toBeInTheDocument();

		// SQL injection lives in the collapsed F-1 group — expand to reach its row.
		await user.click(groupButton(/F-1/));

		// Select the first finding via its row checkbox.
		await user.click(
			screen.getByRole("checkbox", {
				name: /select finding: SQL injection/i,
			}),
		);

		const bar = screen.getByRole("region", {
			name: /bulk actions for selected findings/i,
		});
		expect(within(bar).getByText("1")).toBeInTheDocument();

		// Mark resolved → confirm → applies a bulk update carrying findingIds.
		await user.click(
			within(bar).getByRole("button", { name: /mark resolved/i }),
		);
		const dialog = await screen.findByRole("alertdialog");
		await user.click(
			within(dialog).getByRole("button", { name: /^mark resolved$/i }),
		);

		expect(bulkMutateMock).toHaveBeenCalledTimes(1);
		const vars = bulkMutateMock.mock.calls[0][0];
		expect(vars.findingIds).toEqual(["a"]);
		expect(vars.status).toBe("RESOLVED");
	});

	it("select-all on a group selects every finding in that group", async () => {
		const user = userEvent.setup();
		primeFindings();
		renderList();

		// The F-1 group's select-all checkbox (works even while collapsed).
		const groupCheckbox = screen.getByRole("checkbox", {
			name: /select all findings in F-1/i,
		});
		await user.click(groupCheckbox);

		const bar = screen.getByRole("region", {
			name: /bulk actions for selected findings/i,
		});
		// Two findings in F-1 selected.
		expect(within(bar).getByText("2")).toBeInTheDocument();
	});
});
