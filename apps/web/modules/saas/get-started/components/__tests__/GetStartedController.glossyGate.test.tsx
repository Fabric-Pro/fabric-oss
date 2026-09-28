/**
 * The `GLOSSY_EDITION` gate as the controller threads it (Fizzy #2589).
 *
 * The registry and the step list are unit-tested over plain values next door
 * (`glossy-runtime-gate.test.ts`). This file pins the wiring: that the
 * controller reads the organization's flag and hands it to BOTH consumers —
 * the Documents page tour, which builds its steps from the anchors on screen,
 * and the guided tour — so neither can advertise the feature to an
 * organization that is not enrolled, even when the anchor happens to exist.
 *
 * The spotlight is stubbed down to the step ids it was given.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { configure, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act, useState as useMockFlagState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

configure({ asyncUtilTimeout: 5000 });

// ----------------------------------------------------------------------------
// Mocks — defined BEFORE the import of GetStartedController.
// ----------------------------------------------------------------------------

const flags = vi.hoisted(() => ({ glossyEdition: false }));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({
		user: { id: "user-1", name: "Test User" },
		session: { id: "test-session" },
		loaded: true,
		reloadSession: vi.fn(),
	}),
}));

const getState = vi.fn();
const update = vi.fn();

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		users: {
			onboarding: {
				getState: (...args: unknown[]) => getState(...args),
				update: (...args: unknown[]) => update(...args),
			},
		},
		functionTags: { setMyDefault: vi.fn() },
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		functionTags: {
			getMyDefault: {
				queryOptions: () => ({
					queryKey: ["ft", "getMyDefault"],
					queryFn: async () => ({ tags: ["engineer"] }),
				}),
			},
		},
		projects: {
			// One project, so the guided tour keeps its project steps.
			list: {
				queryOptions: ({ input }: { input: unknown }) => ({
					queryKey: ["projects.list", input],
					queryFn: async () => ({ projects: [{ id: "project-1" }] }),
				}),
			},
			tabVisibility: {
				get: {
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: ["projects.tabVisibility.get", input],
						queryFn: async () => ({ config: null }),
					}),
				},
			},
			tabPreferences: {
				get: {
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: ["projects.tabPreferences.get", input],
						queryFn: async () => ({ prefs: null }),
					}),
				},
			},
		},
	},
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationId: () => "org-1",
}));

vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	// A genuine hook, so hook order is exercised the way React would. Only
	// the Glossy gate is driven here; every other flag stays off.
	useFeatureFlag: (key: string) => {
		const [value] = useMockFlagState(false);
		return key === "GLOSSY_EDITION" ? flags.glossyEdition : value;
	},
}));
vi.mock("@saas/shared/components/RoleTagSnapshotProvider", () => ({
	useRoleTagSnapshot: () => false,
}));

vi.mock("../GetStartedDrawer", () => ({
	GetStartedDrawer: ({ onStartTour }: { onStartTour: () => void }) => (
		<button type="button" onClick={onStartTour}>
			Start tour from drawer
		</button>
	),
}));
vi.mock("../GetStartedWelcomeDialog", () => ({
	GetStartedWelcomeDialog: () => null,
}));
vi.mock("../GetStartedSpotlight", () => ({
	GetStartedSpotlight: (props: { steps: readonly { id: string }[] }) => (
		<div data-testid="spotlight">
			<span data-testid="ids">
				{props.steps.map((s) => s.id).join(",")}
			</span>
		</div>
	),
}));

import { makeOnboardingStateData as makeStateData } from "../../lib/__tests__/onboarding-state-fixtures";
import {
	GET_STARTED_OPEN_EVENT,
	GET_STARTED_TOUR_PAGE_EVENT,
	type TourPageEventDetail,
} from "../../lib/tour-steps";
import { GetStartedController } from "../GetStartedController";

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function renderController() {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return render(
		<QueryClientProvider client={client}>
			<GetStartedController />
		</QueryClientProvider>,
	);
}

const DOCUMENTS_ANCHORS = [
	"documents-create",
	"documents-list",
	"documents-glossy",
] as const;

/** Mount Documents tab anchors — by default all of them, Glossy marker too. */
function mountDocumentsAnchors(anchors: readonly string[] = DOCUMENTS_ANCHORS) {
	for (const anchor of anchors) {
		const el = document.createElement("div");
		el.dataset.onboardingTarget = anchor;
		el.dataset.testAnchor = "true";
		document.body.appendChild(el);
	}
}

async function tourDocumentsPage() {
	await act(async () => {
		window.dispatchEvent(
			new CustomEvent<TourPageEventDetail>(GET_STARTED_TOUR_PAGE_EVENT, {
				detail: { pageId: "documents" },
			}),
		);
	});
	await screen.findByTestId("spotlight");
}

async function startGuidedTour() {
	await act(async () => {
		window.dispatchEvent(new CustomEvent(GET_STARTED_OPEN_EVENT));
	});
	await userEvent.click(
		await screen.findByRole("button", { name: "Start tour from drawer" }),
	);
	await screen.findByTestId("spotlight");
}

const stepIds = () =>
	(screen.getByTestId("ids").textContent ?? "").split(",").filter(Boolean);

beforeEach(() => {
	vi.clearAllMocks();
	sessionStorage.clear();
	flags.glossyEdition = false;
	// A settled user: no welcome dialog, no auto-launch, no tags prompt.
	getState.mockResolvedValue(
		makeStateData({
			state: { autoLaunched: true },
			eligibleForAutoLaunch: false,
			eligibleForFunctionTagsPrompt: false,
		}),
	);
	update.mockImplementation(async () => makeStateData());
});

afterEach(() => {
	for (const el of document.querySelectorAll("[data-test-anchor]")) {
		el.remove();
	}
});

// ----------------------------------------------------------------------------

describe("GetStartedController — Glossy gate on the Documents page tour", () => {
	it("skips the Glossy component with the gate off, even with its anchor on screen", async () => {
		mountDocumentsAnchors();
		renderController();
		await tourDocumentsPage();

		expect(stepIds()).toEqual([
			"page-documents-documents-create",
			"page-documents-documents-list",
		]);
	});

	it("walks the Glossy component with the gate on", async () => {
		flags.glossyEdition = true;
		mountDocumentsAnchors();
		renderController();
		await tourDocumentsPage();

		expect(stepIds()).toEqual([
			"page-documents-documents-create",
			"page-documents-documents-list",
			"page-documents-documents-glossy",
		]);
	});

	it("skips it with the gate on when no card carries the anchor", async () => {
		// No Proposal or Business Case on the tab: the component is
		// conditional, so it drops out rather than spotlighting nothing.
		flags.glossyEdition = true;
		mountDocumentsAnchors(["documents-create", "documents-list"]);
		renderController();
		await tourDocumentsPage();

		expect(stepIds()).not.toContain("page-documents-documents-glossy");
		expect(stepIds()).toContain("page-documents-documents-create");
	});
});

describe("GetStartedController — Glossy gate on the guided tour", () => {
	it("leaves the Glossy step out with the gate off", async () => {
		renderController();
		await startGuidedTour();

		expect(stepIds()).toContain("documents");
		expect(stepIds()).not.toContain("glossy");
	});

	it("walks the Glossy step right after Documents with the gate on", async () => {
		flags.glossyEdition = true;
		renderController();
		await startGuidedTour();

		const ids = stepIds();
		expect(ids[ids.indexOf("documents") + 1]).toBe("glossy");
	});
});
