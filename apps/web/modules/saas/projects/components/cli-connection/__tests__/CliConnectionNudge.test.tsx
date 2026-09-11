/**
 * Tests for `CliConnectionNudge` — the dismissible CLI-connection prompt on the
 * project page (Fizzy #2457, U8).
 *
 * What is pinned here, and why each one is load-bearing:
 *
 *   1. The prompt renders from `promptEligible` and from nothing else. Every
 *      ineligible case in the acceptance examples — an organization viewer, one
 *      satisfied context item, an archived project, an item marked not
 *      applicable, an in-force personal snooze — arrives as the SAME boolean,
 *      resolved server-side. A test that re-derived any of them here would be
 *      testing a second implementation of a decision the client does not own.
 *   2. An absent payload renders nothing. Loading, errored, readiness disabled
 *      and "mounted outside the provider" are all the same shape, and guessing
 *      eligible on any of them would offer to mint an API key to someone whose
 *      permission to mint one was never established.
 *   3. The prompt yields to every onboarding surface (R23) and does NOT return
 *      when one closes. Both halves matter: not stacking is the requirement,
 *      and not popping in mid-session is what keeps the fix from being worse
 *      than the bug.
 *   4. The render event fires once and only for a prompt that actually stays on
 *      screen. Eligibility resolves true on every readiness read — which polls
 *      and refetches after any mutation — so a per-read event would overcount
 *      impressions past the point of usefulness.
 *   5. The issuing view survives the caller's own eligibility flipping false.
 *      Eligibility is server-resolved and re-read on every refetch and poll, the
 *      onboarding ledger can be claimed by any surface on the page, and issuing
 *      a key hides the prompt itself — the view is mounted as a SIBLING of the
 *      prompt so none of that can unmount it while it holds the only copy of a
 *      secret the server stores as a hash.
 *   6. A key issued from the prompt stands the prompt down for the rest of the
 *      mount. Nothing on the server does it: the checklist item behind
 *      `promptEligible` completes when a coding tool REACHES Fabric, so a
 *      readiness read after a successful issue still says "eligible" and an
 *      unsuppressed prompt would offer to mint a second key to the person
 *      holding a fresh one.
 *   7. `hidden` hides without unmounting, and counts no impression while it is
 *      hiding. The page hides its chrome for Focus Mode without navigating; a
 *      prompt unmounted for that would reset its per-mount yield latch and
 *      count a second impression for one project visit.
 *
 * The readiness context is mocked rather than mounted: this component's
 * contract with it is one field, and driving a real provider would mean
 * standing up its query, its mutation-cache subscription and its poll to assert
 * things about none of them. `@tanstack/react-query` itself is real, because the
 * dismissal runs mutate -> optimistic hide and a stubbed `useMutation` would let
 * a broken call signature pass.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	createKeyMock,
	dismissMock,
	getMyDefaultMock,
	setMyDefaultMock,
	trackEventMock,
} = vi.hoisted(() => ({
	createKeyMock: vi.fn(),
	dismissMock: vi.fn(),
	getMyDefaultMock: vi.fn(),
	setMyDefaultMock: vi.fn(),
	trackEventMock: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		organizations: {
			apiKeys: { create: (input: unknown) => createKeyMock(input) },
		},
		projects: {
			readiness: {
				dismissCliNudge: (input: unknown) => dismissMock(input),
			},
		},
		functionTags: {
			setMyDefault: (input: unknown) => setMyDefaultMock(input),
		},
	},
}));

vi.mock("@analytics", () => ({
	useAnalytics: () => ({ trackEvent: trackEventMock }),
}));

/**
 * The readiness context, driven from this variable so a test can hand the
 * component any payload — including the two "we do not know" shapes: the
 * disabled literal the procedure returns when readiness is off, and a null
 * context for a mount outside the provider.
 *
 * Assigned directly where the test re-renders afterwards; published through
 * {@link publishReadiness} where the component has to notice on its own, which
 * is what the real provider does when its own state moves. The prompt's
 * "a key was just issued" suppression lives on this context now (Fizzy #2457),
 * so a fixture that could only be read at render time would model the one
 * thing these tests are about.
 */
let readinessContext: unknown = null;
const readinessListeners = new Set<() => void>();

function publishReadiness(next: unknown) {
	readinessContext = next;
	for (const listener of readinessListeners) {
		listener();
	}
}

vi.mock(
	"@saas/projects/components/readiness/ProjectReadinessProvider",
	async () => {
		const { useSyncExternalStore } = await import("react");
		return {
			useProjectReadiness: () =>
				useSyncExternalStore(
					(onChange: () => void) => {
						readinessListeners.add(onChange);
						return () => {
							readinessListeners.delete(onChange);
						};
					},
					() => readinessContext,
					() => readinessContext,
				),
		};
	},
);

/* The blocking role-tag gate, mounted for real in one case below so the yield
   rule is proved against an actual onboarding surface rather than only against
   the signal it publishes through. Its four dependencies are mocked exactly as
   its own suite mocks them. */
let roleTagFlag = true;
let roleTagSnapshot: boolean | null = false;

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		functionTags: {
			getMyDefault: {
				queryOptions: () => ({
					queryKey: ["ft", "getMyDefault"],
					queryFn: getMyDefaultMock,
				}),
			},
			getMyProjectStatus: {
				key: () => [["functionTags", "getMyProjectStatus"], {}],
			},
		},
	},
}));
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => roleTagFlag,
}));
vi.mock("@saas/shared/components/RoleTagSnapshotProvider", () => ({
	useRoleTagSnapshot: () => roleTagSnapshot,
}));

import { FunctionTagsRequiredGate } from "@saas/get-started/components/FunctionTagsRequiredGate";
import { claimOnboardingView } from "@saas/get-started/lib/onboarding-claim";
import { CliConnectionNudge } from "../CliConnectionNudge";
import {
	CLI_NUDGE_OPENED_EVENT,
	CLI_NUDGE_RENDERED_EVENT,
	shouldShowCliConnectionNudge,
} from "../lib/cli-connection-nudge";

const PROJECT_ID = "project-under-test";
const PROJECT_NAME = "Checkout Rewrite";
const ORGANIZATION_ID = "org-hosting-the-project";
const ORGANIZATION_SLUG = "example-org";

/**
 * The accessible names the component renders. Restated here on purpose: this
 * copy is product-approved, and a test that re-imported the constants would
 * pass just as happily after someone silently reworded them.
 */
const REGION_LABEL = "CLI connection prompt";
const CONNECT_LABEL = "Connect CLI";
const DISMISS_LABEL = "Dismiss the CLI connection prompt";

/** The issuing view's own copy, used to drive it end to end from the prompt. */
const DIALOG_TITLE = "Connect Fabric to your coding tool";
const CREATE_KEY_LABEL = "Create the key";
const DONE_LABEL = "Done";

/**
 * What the create procedure hands back. `rawKey` is the whole reason the view
 * has the lifetime it has, so the fixture carries one rather than an empty
 * object that would let the configuration section render blank.
 */
function issuedKeyFixture() {
	return {
		id: "key-1",
		name: "Coding CLI (created from the connect prompt)",
		keyPrefix: "org_1a2b3c4d",
		rawKey: "org_1a2b3c4d_ZXhhbXBsZS1zZWNyZXQtdmFsdWU",
		scopes: ["mcp:read"],
		expiresAt: new Date("2026-12-09T00:00:00.000Z"),
		createdAt: new Date("2026-09-10T00:00:00.000Z"),
	};
}

type CliBlock = {
	organizationConnected: boolean;
	viewerCanCreateKey: boolean;
	viewerDismissed: boolean;
	promptEligible: boolean;
};

/** The block as it comes back for a viewer who qualifies (AE1). */
function eligibleBlock(): CliBlock {
	return {
		organizationConnected: false,
		viewerCanCreateKey: true,
		viewerDismissed: false,
		promptEligible: true,
	};
}

/** A readiness context carrying `cliConnection`, as the provider builds it. */
function contextWith(cliConnection: CliBlock | undefined, enabled = true) {
	const value = {
		projectId: PROJECT_ID,
		data: { enabled, cliConnection },
		isLoading: false,
		isExpanded: false,
		setExpanded: () => undefined,
		refetch: () => undefined,
		hasInlineSlot: true,
		claimInlineSlot: () => () => undefined,
		/**
		 * The "a key was just issued here" fact, shared (Fizzy #2457).
		 *
		 * It used to be state inside the prompt, which meant the prompt could
		 * only see keys minted from its OWN issuing view — and the checklist's
		 * "API Key for CLI" row mounts a second one. Modelled the way the
		 * provider implements it: a latch nothing takes back, published to
		 * every consumer, so the prompt stands down here for the same reason it
		 * does in the app rather than because a test called its setter.
		 */
		cliKeyIssued: false,
		markCliKeyIssued: () =>
			publishReadiness({ ...value, cliKeyIssued: true }),
	};
	return value;
}

function Wrapper({ children }: { children: ReactNode }) {
	// One client per mount, not per render: a fresh client every render would
	// drop the dismissal mutation's own state mid-flight.
	const [client] = useState(
		() =>
			new QueryClient({
				defaultOptions: {
					queries: { retry: false },
					mutations: { retry: false },
				},
			}),
	);
	return (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

function renderNudge(extra?: ReactNode) {
	return render(
		<>
			{extra}
			<CliConnectionNudge
				organizationId={ORGANIZATION_ID}
				organizationSlug={ORGANIZATION_SLUG}
				projectName={PROJECT_NAME}
			/>
		</>,
		{ wrapper: Wrapper },
	);
}

/**
 * The element the tests re-render to flip one prop. Same component type and
 * same (null) key as the one `renderNudge` mounts, which is what lets a
 * `rerender` reach the SAME instance instead of mounting a second one — the
 * whole question in the `hidden` cases below.
 */
function nudge(props?: { hidden?: boolean }) {
	return (
		<CliConnectionNudge
			hidden={props?.hidden}
			organizationId={ORGANIZATION_ID}
			organizationSlug={ORGANIZATION_SLUG}
			projectName={PROJECT_NAME}
		/>
	);
}

/** The prompt as a reader would find it: in the accessibility tree. */
const prompt = () => screen.queryByRole("alert", { name: REGION_LABEL });

/**
 * The prompt as the DOM holds it, including while something has taken it out
 * of the accessibility tree — a `hidden` chrome toggle, or the open modal that
 * marks the rest of the document `aria-hidden`. Only for telling "hidden" apart
 * from "not there", which is exactly the distinction two cases below turn on.
 *
 * A raw selector rather than `queryByRole(..., { hidden: true })`, because the
 * `hidden` attribute now sits on the alert itself rather than on a wrapper
 * around it, and an accessible NAME is not computed for a hidden element — so
 * a role query filtered by `name` cannot match one, whatever `hidden` is set
 * to. This asks the question the two cases actually want: is the element the
 * prompt renders still in the document, labelled as the prompt. `prompt()`
 * above remains the a11y-tree view, and it is what asserts the label reaches a
 * reader.
 */
const promptElement = () =>
	document.querySelector<HTMLElement>(
		`[role="alert"][aria-label="${REGION_LABEL}"]`,
	);

const renderedCalls = () =>
	trackEventMock.mock.calls.filter(
		([name]) => name === CLI_NUDGE_RENDERED_EVENT,
	);

/** Claims released after each test so the module-scope ledger cannot leak. */
let heldClaims: Array<() => void> = [];

function holdClaim() {
	const release = claimOnboardingView();
	heldClaims.push(release);
	return release;
}

beforeEach(() => {
	vi.clearAllMocks();
	readinessContext = contextWith(eligibleBlock());
	dismissMock.mockResolvedValue({ ok: true });
	createKeyMock.mockResolvedValue(issuedKeyFixture());
	getMyDefaultMock.mockResolvedValue({ tags: [], enforcementEnabled: true });
	roleTagFlag = true;
	roleTagSnapshot = false;
	heldClaims = [];
});

afterEach(() => {
	for (const release of heldClaims) {
		release();
	}
	heldClaims = [];
});

/* -------------------------------------------------------------------------- */
/* The rule                                                                    */
/* -------------------------------------------------------------------------- */

describe("shouldShowCliConnectionNudge", () => {
	it("returns false for an absent payload rather than assuming eligibility", () => {
		expect(
			shouldShowCliConnectionNudge({
				cliConnection: undefined,
				onboardingClaimed: false,
				dismissed: false,
				keyIssued: false,
			}),
		).toBe(false);
	});

	it("returns true only when the server says the prompt is eligible", () => {
		expect(
			shouldShowCliConnectionNudge({
				cliConnection: { promptEligible: true },
				onboardingClaimed: false,
				dismissed: false,
				keyIssued: false,
			}),
		).toBe(true);
		expect(
			shouldShowCliConnectionNudge({
				cliConnection: { promptEligible: false },
				onboardingClaimed: false,
				dismissed: false,
				keyIssued: false,
			}),
		).toBe(false);
	});

	it("yields to a claimed view and to a dismissal, whatever the server said", () => {
		expect(
			shouldShowCliConnectionNudge({
				cliConnection: { promptEligible: true },
				onboardingClaimed: true,
				dismissed: false,
				keyIssued: false,
			}),
		).toBe(false);
		expect(
			shouldShowCliConnectionNudge({
				cliConnection: { promptEligible: true },
				onboardingClaimed: false,
				dismissed: true,
				keyIssued: false,
			}),
		).toBe(false);
	});

	/**
	 * The input no server answer can replace. `promptEligible` stays true after
	 * a key is minted — the item behind it completes on a coding tool reaching
	 * Fabric, not on a key existing — so this is the only thing standing the
	 * prompt down for the person who has just issued one.
	 */
	it("yields to a key issued from the prompt, while the server still says eligible", () => {
		expect(
			shouldShowCliConnectionNudge({
				cliConnection: { promptEligible: true },
				onboardingClaimed: false,
				dismissed: false,
				keyIssued: true,
			}),
		).toBe(false);
	});

	/**
	 * End-to-end through the rule with a whole block rather than the narrowed
	 * one: an organization viewer's payload says `viewerCanCreateKey: false` AND
	 * `promptEligible: false`, and the rule must answer from the second. The
	 * other three fields are context, and a rule that started reading them would
	 * pass this case while losing the four the server resolves and they do not
	 * (an archived project, a not-applicable mark, an in-force snooze, the
	 * rollout gate).
	 */
	it("answers from promptEligible for a real ineligible payload", () => {
		expect(
			shouldShowCliConnectionNudge({
				cliConnection: {
					organizationConnected: false,
					viewerCanCreateKey: false,
					viewerDismissed: false,
					promptEligible: false,
				} as CliBlock,
				onboardingClaimed: false,
				dismissed: false,
				keyIssued: false,
			}),
		).toBe(false);
	});
});

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

describe("CliConnectionNudge — when it renders", () => {
	it("AE1: renders for an eligible payload, with both controls", async () => {
		renderNudge();

		expect(
			await screen.findByRole("alert", { name: REGION_LABEL }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: CONNECT_LABEL }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: DISMISS_LABEL }),
		).toBeInTheDocument();
	});

	it("names the checklist row that outlives a dismissal (R28)", () => {
		renderNudge();

		expect(
			screen.getByText(/dismissing this is permanent/i),
		).toBeInTheDocument();
		expect(screen.getByText(/"API Key for CLI"/)).toBeInTheDocument();
	});

	/**
	 * AE2, AE5, AE12, AE13 and AE18 in one table, because that is honestly what
	 * they are on the client: five different server-side reasons that arrive as
	 * one false. Naming them individually is what keeps the mapping from the
	 * acceptance examples legible when one of them changes meaning.
	 */
	it.each([
		["AE2: an organization viewer", { viewerCanCreateKey: false }],
		["AE5: one satisfied context item", {}],
		["AE12: an archived project", {}],
		["AE13: the item marked not applicable", {}],
		["AE18: an in-force personal snooze", {}],
	])("renders nothing for %s", (_name, overrides) => {
		readinessContext = contextWith({
			...eligibleBlock(),
			...overrides,
			promptEligible: false,
		});

		renderNudge();

		expect(prompt()).not.toBeInTheDocument();
	});

	it("AE3/R6: renders nothing once the organization is connected", () => {
		readinessContext = contextWith({
			organizationConnected: true,
			viewerCanCreateKey: true,
			viewerDismissed: false,
			promptEligible: false,
		});

		renderNudge();

		expect(prompt()).not.toBeInTheDocument();
	});

	it("renders nothing, and throws nothing, on the disabled readiness payload", () => {
		// The exact literal the procedure returns when readiness is off: the
		// block is present and inert, which is what makes the surfaces'
		// dependency on readiness structural rather than a second flag.
		readinessContext = contextWith(
			{
				organizationConnected: false,
				viewerCanCreateKey: false,
				viewerDismissed: false,
				promptEligible: false,
			},
			false,
		);

		expect(() => renderNudge()).not.toThrow();
		expect(prompt()).not.toBeInTheDocument();
	});

	it("renders nothing while the payload is absent", () => {
		readinessContext = contextWith(undefined);

		renderNudge();

		expect(prompt()).not.toBeInTheDocument();
	});

	it("renders nothing when mounted outside the readiness provider", () => {
		readinessContext = null;

		expect(() => renderNudge()).not.toThrow();
		expect(prompt()).not.toBeInTheDocument();
	});
});

/* -------------------------------------------------------------------------- */
/* Dismissal                                                                   */
/* -------------------------------------------------------------------------- */

describe("CliConnectionNudge — dismissal", () => {
	it("AE4: hides the prompt and records the dismissal exactly once", async () => {
		const user = userEvent.setup();
		renderNudge();

		await user.click(screen.getByRole("button", { name: DISMISS_LABEL }));

		expect(prompt()).not.toBeInTheDocument();
		await waitFor(() => expect(dismissMock).toHaveBeenCalledTimes(1));
		expect(dismissMock).toHaveBeenCalledWith({
			projectId: PROJECT_ID,
			organizationId: ORGANIZATION_ID,
		});
	});

	it("stays hidden when a later readiness read still reports it eligible", async () => {
		const user = userEvent.setup();
		const { rerender } = renderNudge();

		await user.click(screen.getByRole("button", { name: DISMISS_LABEL }));
		expect(prompt()).not.toBeInTheDocument();

		// The refetch that follows the dismissal mutation can land before the
		// row is written, re-reporting the viewer as eligible. The optimistic
		// flag is what stops the prompt flashing back in.
		readinessContext = contextWith(eligibleBlock());
		rerender(
			<CliConnectionNudge
				organizationId={ORGANIZATION_ID}
				organizationSlug={ORGANIZATION_SLUG}
				projectName={PROJECT_NAME}
			/>,
		);

		expect(prompt()).not.toBeInTheDocument();
	});

	it("gives the icon-only control an accessible name (R31)", () => {
		renderNudge();

		const dismissControl = screen.getByRole("button", {
			name: DISMISS_LABEL,
		});
		expect(dismissControl).toHaveAccessibleName(DISMISS_LABEL);
	});
});

/* -------------------------------------------------------------------------- */
/* The yield rule (R23)                                                        */
/* -------------------------------------------------------------------------- */

describe("CliConnectionNudge — yielding to onboarding", () => {
	it("AE21: does not render while a surface already claims the view", () => {
		holdClaim();

		renderNudge();

		expect(prompt()).not.toBeInTheDocument();
	});

	it("AE21: stands down when a surface claims the view after it mounted", async () => {
		renderNudge();
		expect(prompt()).toBeInTheDocument();

		holdClaim();

		await waitFor(() => expect(prompt()).not.toBeInTheDocument());
	});

	it("does not reappear mid-session when the surface goes away", async () => {
		const release = holdClaim();
		const { unmount } = renderNudge();
		expect(prompt()).not.toBeInTheDocument();

		release();

		// `waitFor` rather than a bare assertion: it flushes the effects the
		// release could have woken, so this fails if any listener acts on it.
		// The requirement is that finishing a tour never makes a banner pop in
		// under the reader.
		await waitFor(() => expect(prompt()).not.toBeInTheDocument());

		// ...and becomes eligible again at the NEXT mount of the project view.
		unmount();
		renderNudge();
		expect(prompt()).toBeInTheDocument();
	});

	it("AE21: yields to the real blocking role-tag gate", async () => {
		renderNudge(<FunctionTagsRequiredGate />);

		expect(
			await screen.findByText("Set your function tags"),
		).toBeInTheDocument();
		await waitFor(() => expect(prompt()).not.toBeInTheDocument());
	});
});

/* -------------------------------------------------------------------------- */
/* Telemetry (R25)                                                             */
/* -------------------------------------------------------------------------- */

describe("CliConnectionNudge — funnel events", () => {
	it("records the render once, when the prompt actually appears", async () => {
		renderNudge();

		await waitFor(() => expect(renderedCalls()).toHaveLength(1));
		expect(renderedCalls()[0][1]).toEqual({ projectId: PROJECT_ID });
	});

	it("does not record it again when a refetch re-resolves the same eligibility", async () => {
		const { rerender } = renderNudge();
		await waitFor(() => expect(renderedCalls()).toHaveLength(1));

		// A new payload object with identical contents — what the readiness
		// query hands down after any of the several things that make it re-read.
		for (let i = 0; i < 3; i++) {
			readinessContext = contextWith(eligibleBlock());
			rerender(
				<CliConnectionNudge
					organizationId={ORGANIZATION_ID}
					organizationSlug={ORGANIZATION_SLUG}
					projectName={PROJECT_NAME}
				/>,
			);
		}

		expect(prompt()).toBeInTheDocument();
		expect(renderedCalls()).toHaveLength(1);
	});

	it("records nothing when the prompt yields", async () => {
		holdClaim();

		renderNudge();
		await waitFor(() => expect(prompt()).not.toBeInTheDocument());

		expect(renderedCalls()).toHaveLength(0);
	});

	it("records nothing when a surface claims the view in the same commit", async () => {
		renderNudge(<FunctionTagsRequiredGate />);

		expect(
			await screen.findByText("Set your function tags"),
		).toBeInTheDocument();
		expect(renderedCalls()).toHaveLength(0);
	});

	it("records the open when the issuing view is opened from the prompt", async () => {
		const user = userEvent.setup();
		renderNudge();

		await user.click(screen.getByRole("button", { name: CONNECT_LABEL }));

		expect(
			await screen.findByText("Connect Fabric to your coding tool"),
		).toBeInTheDocument();
		expect(trackEventMock).toHaveBeenCalledWith(CLI_NUDGE_OPENED_EVENT, {
			projectId: PROJECT_ID,
		});
	});
});

/* -------------------------------------------------------------------------- */
/* The issuing view's lifetime                                                 */
/* -------------------------------------------------------------------------- */

describe("CliConnectionNudge — the issuing view is a sibling", () => {
	/**
	 * The reason the view is mounted outside the prompt's visibility branch.
	 * Issuing a key completes the checklist item, which flips `promptEligible`
	 * false on the very next readiness read — while the view still holds the
	 * only copy of a secret the server stores as a hash.
	 */
	it("stays open after the prompt's own eligibility flips false", async () => {
		const user = userEvent.setup();
		const { rerender } = renderNudge();

		await user.click(screen.getByRole("button", { name: CONNECT_LABEL }));
		expect(
			await screen.findByText("Connect Fabric to your coding tool"),
		).toBeInTheDocument();

		readinessContext = contextWith({
			organizationConnected: true,
			viewerCanCreateKey: true,
			viewerDismissed: false,
			promptEligible: false,
		});
		rerender(
			<CliConnectionNudge
				organizationId={ORGANIZATION_ID}
				organizationSlug={ORGANIZATION_SLUG}
				projectName={PROJECT_NAME}
			/>,
		);

		expect(prompt()).not.toBeInTheDocument();
		expect(
			screen.getByText("Connect Fabric to your coding tool"),
		).toBeInTheDocument();
	});

	it("mounts no issuing view without an organization to mint against", async () => {
		render(
			<CliConnectionNudge
				organizationId={null}
				projectName={PROJECT_NAME}
			/>,
			{ wrapper: Wrapper },
		);

		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: CONNECT_LABEL }));

		expect(
			screen.queryByText("Connect Fabric to your coding tool"),
		).not.toBeInTheDocument();
	});
});

/* -------------------------------------------------------------------------- */
/* After a key is issued                                                       */
/* -------------------------------------------------------------------------- */

describe("CliConnectionNudge — after a key is issued", () => {
	/**
	 * Driven through the real issuing view rather than by calling the callback,
	 * because the thing being pinned is that the prompt stands itself down on
	 * the SUCCESS of that mutation.
	 */
	async function issueAKey() {
		const user = userEvent.setup();
		const rendered = renderNudge();

		await user.click(screen.getByRole("button", { name: CONNECT_LABEL }));
		await user.click(
			await screen.findByRole("button", { name: CREATE_KEY_LABEL }),
		);
		await waitFor(() =>
			expect(
				screen.getByTestId("connect-cli-configuration"),
			).toBeInTheDocument(),
		);

		return { user, rendered };
	}

	it("stands the prompt down, and the issuing view keeps the secret", async () => {
		const { user } = await issueAKey();

		// Gone from the DOM, not merely from the accessibility tree — an open
		// modal marks the rest of the document `aria-hidden`, so the ordinary
		// query would report this even if the prompt were still there.
		expect(promptElement()).not.toBeInTheDocument();
		// ...and the view holding the only copy of the key is untouched by the
		// prompt disappearing out from under it.
		expect(screen.getByText(DIALOG_TITLE)).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: DONE_LABEL }));
		await waitFor(() =>
			expect(screen.queryByText(DIALOG_TITLE)).not.toBeInTheDocument(),
		);
		expect(promptElement()).not.toBeInTheDocument();
	});

	it("stays down when the readiness refetch still reports it eligible", async () => {
		const { rendered } = await issueAKey();

		// What actually comes back after issuing: the readiness provider
		// re-reads on any successful mutation, and the item behind
		// `promptEligible` completes on a coding tool REACHING Fabric, so the
		// server's answer has not moved at all.
		//
		// A new PAYLOAD on the same context, not a new context: a refetch
		// replaces `data` and leaves the rest of the provider's state where it
		// was, the issued-key latch included. Handing the component a
		// wholesale-fresh context here would model a new project view instead,
		// which is the case below.
		readinessContext = {
			...(readinessContext as Record<string, unknown>),
			data: { enabled: true, cliConnection: eligibleBlock() },
		};
		rendered.rerender(nudge());

		expect(promptElement()).not.toBeInTheDocument();
	});

	it("offers again on the next project view, since issuing is not connecting", async () => {
		const { rendered } = await issueAKey();
		expect(promptElement()).not.toBeInTheDocument();

		// The reader may still have a configuration block to paste. Suppression
		// is per project view on purpose: the offer comes back on the next
		// visit, and the "API Key for CLI" checklist row keeps it reachable in
		// between. Nothing is persisted, here or on the server.
		//
		// A fresh context alongside the fresh mount, because that is what a new
		// project view is: the readiness provider now owns the latch, so that
		// both surfaces offering this key honour one answer, and it is the
		// provider's own mount that clears it. Within a single visit the
		// suppression deliberately outlives this component — a reader who mints
		// a key, opens a document and comes back must not be told again that
		// nobody has connected a coding tool.
		rendered.unmount();
		publishReadiness(contextWith(eligibleBlock()));
		renderNudge();

		expect(prompt()).toBeInTheDocument();
	});

	/**
	 * The other half of the same fact, and the regression that motivated moving
	 * it (Fizzy #2457): the checklist row mounts its own issuing view, so the
	 * prompt has to honour a key minted from a callback it never sees.
	 */
	it("records the issue on the shared context, not privately", async () => {
		await issueAKey();

		expect(
			(readinessContext as { cliKeyIssued: boolean }).cliKeyIssued,
		).toBe(true);
	});

	/**
	 * The regression itself, from the prompt's side: the panel's row records
	 * the same fact on the same context, and the prompt stands down for it
	 * without ever having opened a view of its own. Proved end to end through
	 * both real components in
	 * `modules/saas/projects/components/readiness/__tests__/ProjectReadinessPanel.cli-key-issued.test.tsx`.
	 */
	it("stands down for a key issued elsewhere in the project view", async () => {
		const { rerender } = render(nudge(), { wrapper: Wrapper });
		expect(
			await screen.findByRole("alert", { name: REGION_LABEL }),
		).toBeInTheDocument();

		// Exactly what the checklist row's own issuing view does on success.
		(
			readinessContext as { markCliKeyIssued: () => void }
		).markCliKeyIssued();
		rerender(nudge());

		// Gone from the DOM rather than merely from the accessibility tree, and
		// with no dialog of this component's own ever opened.
		expect(promptElement()).not.toBeInTheDocument();
	});
});

/* -------------------------------------------------------------------------- */
/* Hidden by the page's chrome                                                 */
/* -------------------------------------------------------------------------- */

describe("CliConnectionNudge — hidden by the page's chrome", () => {
	it("hides from the reader without unmounting", async () => {
		const { rerender } = render(nudge(), { wrapper: Wrapper });
		expect(
			await screen.findByRole("alert", { name: REGION_LABEL }),
		).toBeInTheDocument();

		rerender(nudge({ hidden: true }));

		// Out of the accessibility tree for a reader and for assistive tech...
		expect(prompt()).not.toBeInTheDocument();
		// ...and still in the document, which is the point: the caller hides
		// its chrome without navigating, so the component keeps its state.
		expect(promptElement()).toBeInTheDocument();
		// By the NATIVE attribute specifically. It is what takes the element out
		// of the accessibility tree and what makes a parent's `space-y-*` skip it
		// (`> :not([hidden]) ~ :not([hidden])`); `aria-hidden` alone would do
		// neither, and a class alone would do only the second.
		expect(promptElement()).toHaveAttribute("hidden");

		rerender(nudge());
		expect(prompt()).toBeInTheDocument();
	});

	it("records no impression while hidden, and one when chrome returns", async () => {
		const { rerender } = render(nudge({ hidden: true }), {
			wrapper: Wrapper,
		});

		await waitFor(() => expect(promptElement()).toBeInTheDocument());
		expect(renderedCalls()).toHaveLength(0);

		rerender(nudge());

		await waitFor(() => expect(renderedCalls()).toHaveLength(1));
		expect(renderedCalls()[0][1]).toEqual({ projectId: PROJECT_ID });
	});

	it("records no second impression across a hide/show cycle", async () => {
		const { rerender } = render(nudge(), { wrapper: Wrapper });
		await waitFor(() => expect(renderedCalls()).toHaveLength(1));

		rerender(nudge({ hidden: true }));
		rerender(nudge());
		expect(prompt()).toBeInTheDocument();

		// The per-mount latch survived the cycle, which is only true of a
		// component that never unmounted. Toggling Focus Mode on a project
		// counts one impression, not two.
		await waitFor(() => expect(renderedCalls()).toHaveLength(1));
		expect(renderedCalls()).toHaveLength(1);
	});

	it("keeps the sticky onboarding yield across a hide/show cycle", async () => {
		holdClaim();
		const { rerender } = render(nudge(), { wrapper: Wrapper });
		expect(promptElement()).not.toBeInTheDocument();

		rerender(nudge({ hidden: true }));
		rerender(nudge());

		// The latch is sticky SINCE MOUNT. A remount would clear it and put the
		// prompt back on screen under a reader who is being shown something
		// else — the regression hiding by unmounting would have introduced.
		await waitFor(() => expect(promptElement()).not.toBeInTheDocument());
	});
});
