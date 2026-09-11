/**
 * Undoing a readiness state, and choosing how long a snooze lasts
 * (Fizzy #2165 — Checklist AC-8, plus the FR22 gap where nothing undid a
 * snooze).
 *
 * These assert what the panel SENDS, because that is where the two mistakes
 * live: lifting a snooze is `until: null` rather than a second endpoint, and
 * "Mark applicable" is the same procedure with `false`. A test that only checked
 * a button rendered would pass while sending the wrong thing.
 *
 * `useTranslations` resolves against the real `en.json` rather than echoing the
 * key, so a missing message fails here too.
 *
 * The last group covers the one row that does not behave like the others
 * (Fizzy #2457, R15 / R21 / R31): its action is offered on an ORGANIZATION-role
 * answer rather than the panel's project-role gate, and it opens the issuing
 * view in place rather than navigating.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

beforeAll(() => {
	if (typeof globalThis.ResizeObserver === "undefined") {
		class ResizeObserverPolyfill {
			observe(): void {}
			unobserve(): void {}
			disconnect(): void {}
		}
		(
			globalThis as unknown as {
				ResizeObserver: typeof ResizeObserverPolyfill;
			}
		).ResizeObserver = ResizeObserverPolyfill;
	}
	for (const method of [
		"hasPointerCapture",
		"setPointerCapture",
		"releasePointerCapture",
		"scrollIntoView",
	] as const) {
		if (!HTMLElement.prototype[method]) {
			HTMLElement.prototype[method] = (() => undefined) as never;
		}
	}
});

const {
	snoozeMock,
	setNotApplicableMock,
	requestHelpMock,
	projectGetMock,
	createKeyMock,
	toastMock,
	readinessRef,
	organizationRef,
} = vi.hoisted(() => ({
	snoozeMock: vi.fn(),
	setNotApplicableMock: vi.fn(),
	requestHelpMock: vi.fn(),
	projectGetMock: vi.fn(),
	createKeyMock: vi.fn(),
	toastMock: { success: vi.fn(), info: vi.fn(), error: vi.fn() },
	readinessRef: { current: null as unknown },
	// The panel reads organization context on every render, and the CLI row's
	// action needs a real organization to mint against — the key is issued for
	// the organization HOSTING the project, named explicitly. Mutable so one
	// group can supply one without changing what every other test sees.
	organizationRef: {
		current: {
			organizationId: null as string | null,
			organizationSlug: null as string | null,
			basePath: "/app",
		},
	},
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			// Left mocked with nothing behind it on purpose. The panel reads the
			// project's name off the readiness payload and issues no second read
			// for it, and the assertions below say so — which only means
			// something while this is here to be called.
			get: (input: unknown) => projectGetMock(input),
			readiness: {
				snooze: (input: unknown) => snoozeMock(input),
				setNotApplicable: (input: unknown) =>
					setNotApplicableMock(input),
				requestHelp: (input: unknown) => requestHelpMock(input),
			},
		},
		organizations: {
			apiKeys: { create: (input: unknown) => createKeyMock(input) },
		},
	},
}));

vi.mock("sonner", () => ({ toast: toastMock }));

// Hoisted to a module constant, not rebuilt per call: the real hook memoizes
// its return value precisely so downstream `useMemo`s keep a stable identity,
// and a mock that hands back a fresh object each render would model the very
// thing that memoization exists to prevent.
const GATES = { publishingSuiteEnabled: true };

vi.mock("@saas/projects/lib/project-tab-preferences", () => ({
	// These tests are about the panel's actions, not tab visibility: every tab
	// is reachable so the calls to action render as links.
	useProjectTabCustomization: () => ({ config: undefined, prefs: undefined }),
	useProjectTabGates: () => GATES,
	resolveProjectTabs: (tabs: readonly unknown[]) => tabs,
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => organizationRef.current,
}));

vi.mock("../ProjectReadinessProvider", () => ({
	useProjectReadiness: () => readinessRef.current,
}));

// Resolve against the shipped catalogue: a key with no copy must fail here, the
// same exposure the CTA labels had.
vi.mock("next-intl", async () => {
	const { readFileSync } = await import("node:fs");
	const messages = JSON.parse(
		readFileSync("../../packages/i18n/translations/en.json", "utf8"),
	) as Record<string, unknown>;
	return {
		useTranslations: (namespace: string) => {
			const base = namespace
				.split(".")
				.reduce<unknown>(
					(node, part) => (node as Record<string, unknown>)?.[part],
					messages,
				);
			return (key: string, values?: Record<string, unknown>) => {
				const raw = key
					.split(".")
					.reduce<unknown>(
						(node, part) =>
							(node as Record<string, unknown>)?.[part],
						base,
					);
				if (typeof raw !== "string") {
					throw new Error(`missing message: ${namespace}.${key}`);
				}
				return raw.replace(/\{(\w+)\}/g, (_, name: string) =>
					String(values?.[name] ?? `{${name}}`),
				);
			};
		},
	};
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProjectReadinessPanelSlot } from "../ProjectReadinessPanel";

type Item = Record<string, unknown>;

function item(overrides: Item = {}): Item {
	return {
		key: "feature-snapshot",
		category: "PROJECT_BASICS",
		i18nKey: "readiness.items.featureSnapshot",
		ctaLabelKey: "readiness.cta.featureSnapshot",
		needLevel: "MUST",
		isComplete: false,
		manualState: null,
		snoozeUntil: null,
		isVisible: true,
		isActiveGap: true,
		target: { kind: "tab", tab: "overview" },
		...overrides,
	};
}

function mountWith(items: Item[], overrides: Record<string, unknown> = {}) {
	const refetch = vi.fn();
	const publish = (nextItems: Item[]) => {
		readinessRef.current = {
			projectId: "p1",
			isLoading: false,
			isExpanded: true,
			setExpanded: vi.fn(),
			refetch,
			hasInlineSlot: false,
			claimInlineSlot: vi.fn(),
			data: {
				enabled: true,
				attention: {
					changes: [],
					levelDropped: false,
					seenAt: null,
					autoExpandedAt: null,
				},
				// The procedure names the project on every readiness read, so the
				// issuing view can name it without a query of its own.
				projectName: PROJECT,
				level: "PARTIALLY_READY",
				phase: "DEVELOPMENT_EXECUTION",
				phaseSource: "set",
				completedCount: 1,
				totalCount: 26,
				items: nextItems,
				activeGaps: nextItems.filter((i) => i.isActiveGap),
				recentlyCompleted: [],
				suggestPhaseTransition: false,
				canAct: true,
				...overrides,
			},
		};
	};
	publish(items);
	const client = new QueryClient({
		defaultOptions: { mutations: { retry: false } },
	});
	// A fresh element each time, because React bails out of re-rendering a tree
	// handed the identical element — which would make `refresh` a no-op.
	const tree = () => (
		<QueryClientProvider client={client}>
			<ProjectReadinessPanelSlot />
		</QueryClientProvider>
	);
	const result = render(tree());
	return {
		...result,
		/**
		 * Stand in for the readiness refetch: a new payload arriving at the
		 * same mount, which is what happens after any successful mutation.
		 */
		refresh: (nextItems: Item[]) => {
			publish(nextItems);
			result.rerender(tree());
		},
	};
}

/** Reveal the resolved rows, which Show All is what surfaces. */
async function showAll(user: ReturnType<typeof userEvent.setup>) {
	const toggle = screen.queryByRole("button", { name: /show all/i });
	if (toggle) {
		await user.click(toggle);
	}
}

const MAILTO = "mailto:help@example.com?subject=Help%20with%20a%20thing";

/** The project the issuing view names in its starter instruction. */
const PROJECT = "Checkout Rewrite";
/** The organization HOSTING the project — the one a key would be minted for. */
const ORGANIZATION_ID = "org-hosting-the-project";
const ORGANIZATION_SLUG = "example-org";

// jsdom throws on a real navigation, so the assignment is captured instead of
// performed — what matters is the draft the panel hands to the mail client.
let assignedHref: string | null = null;
Object.defineProperty(window, "location", {
	configurable: true,
	value: {
		...window.location,
		set href(value: string) {
			assignedHref = value;
		},
		get href() {
			return assignedHref ?? "http://localhost/";
		},
	},
});

beforeEach(() => {
	vi.clearAllMocks();
	snoozeMock.mockResolvedValue({ ok: true });
	setNotApplicableMock.mockResolvedValue({ ok: true });
	requestHelpMock.mockResolvedValue({ ok: true, mailto: MAILTO });
	createKeyMock.mockResolvedValue({ rawKey: "org_1a2b3c4d_secret" });
	organizationRef.current = {
		organizationId: null,
		organizationSlug: null,
		basePath: "/app",
	};
	assignedHref = null;
});

describe("snoozing with a chosen duration", () => {
	it("offers durations instead of snoozing for a fixed period", async () => {
		const user = userEvent.setup();
		mountWith([item()]);

		await user.click(
			screen.getByRole("button", { name: "Actions for this item" }),
		);
		const menu = await screen.findByRole("menu");

		expect(
			within(menu)
				.getAllByRole("menuitem")
				.map((el) => el.textContent?.trim()),
		).toEqual([
			"1 day",
			"3 days",
			"1 week",
			"2 weeks",
			"1 month",
			// FR22 / AC-9: one menu holds the item's actions, so Not applicable
			// and Request help sit alongside the durations rather than as
			// separate buttons.
			"Not applicable",
			"Request help",
		]);
	});

	it("sends the instant the chosen duration lands on", async () => {
		const user = userEvent.setup();
		mountWith([item()]);
		const before = Date.now();

		await user.click(
			screen.getByRole("button", { name: "Actions for this item" }),
		);
		await user.click(
			await screen.findByRole("menuitem", { name: "1 week" }),
		);

		await waitFor(() => expect(snoozeMock).toHaveBeenCalledTimes(1));
		const { until, itemKey } = snoozeMock.mock.calls[0][0];
		expect(itemKey).toBe("feature-snapshot");
		const days = (until.getTime() - before) / (24 * 60 * 60 * 1000);
		expect(days).toBeGreaterThan(6.9);
		expect(days).toBeLessThan(7.1);
	});
});

describe("undoing a state", () => {
	const snoozed = () =>
		item({
			manualState: "SNOOZED",
			isActiveGap: false,
			snoozeUntil: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000),
		});

	it("says how much longer the item stays quiet", async () => {
		const user = userEvent.setup();
		mountWith([snoozed()]);
		await showAll(user);

		expect(
			await screen.findByText(/Snoozed for 6 days/i),
		).toBeInTheDocument();
	});

	it("lifts a snooze by sending a null date", async () => {
		const user = userEvent.setup();
		mountWith([snoozed()]);
		await showAll(user);

		await user.click(screen.getByRole("button", { name: /un-snooze/i }));

		await waitFor(() => expect(snoozeMock).toHaveBeenCalledTimes(1));
		// Null is what clears it — a date in the past would leave a stale row
		// behind and re-snooze the item the moment the clock moved.
		expect(snoozeMock.mock.calls[0][0].until).toBeNull();
	});

	it("can re-snooze a snoozed item for a different period", async () => {
		const user = userEvent.setup();
		mountWith([snoozed()]);
		await showAll(user);

		await user.click(screen.getByRole("button", { name: /^Change/i }));
		await user.click(
			await screen.findByRole("menuitem", { name: "1 day" }),
		);

		await waitFor(() => expect(snoozeMock).toHaveBeenCalledTimes(1));
		expect(snoozeMock.mock.calls[0][0].until).toBeInstanceOf(Date);
	});

	it("takes back Not Applicable", async () => {
		const user = userEvent.setup();
		mountWith([
			item({ manualState: "NOT_APPLICABLE", isActiveGap: false }),
		]);
		await showAll(user);

		await user.click(
			screen.getByRole("button", { name: /mark applicable/i }),
		);

		await waitFor(() =>
			expect(setNotApplicableMock).toHaveBeenCalledTimes(1),
		);
		expect(setNotApplicableMock.mock.calls[0][0].notApplicable).toBe(false);
	});

	it("offers no undo on a completed item, which nobody set", async () => {
		const user = userEvent.setup();
		mountWith([item({ isComplete: true, isActiveGap: false })]);
		await showAll(user);

		expect(
			screen.queryByRole("button", {
				name: /un-snooze|mark applicable/i,
			}),
		).not.toBeInTheDocument();
	});
});

/**
 * Request help is the one action that leaves the product (Fizzy #2165, FR22 and
 * the 31 Aug direction that it should mail a monitored inbox). The panel cannot
 * see whether the mail got out, so it must repeat what the server says rather
 * than assume the request was passed on.
 */
describe("requesting help", () => {
	it("asks for help on the item behind the menu", async () => {
		const user = userEvent.setup();
		mountWith([item()]);

		await user.click(
			screen.getByRole("button", { name: "Actions for this item" }),
		);
		await user.click(
			await screen.findByRole("menuitem", { name: "Request help" }),
		);

		await waitFor(() => expect(requestHelpMock).toHaveBeenCalledTimes(1));
		expect(requestHelpMock.mock.calls[0][0]).toMatchObject({
			projectId: "p1",
			itemKey: "feature-snapshot",
		});
	});

	it("opens the user's own mail client with the draft the server composed", async () => {
		const user = userEvent.setup();
		mountWith([item()]);

		await user.click(
			screen.getByRole("button", { name: "Actions for this item" }),
		);
		await user.click(
			await screen.findByRole("menuitem", { name: "Request help" }),
		);

		await waitFor(() => expect(assignedHref).toBe(MAILTO));
		// Nothing is asserted about delivery, because nothing about delivery
		// is knowable from here once the draft is handed to the mail client.
		expect(toastMock.success).not.toHaveBeenCalled();
	});

	it("says plainly when there is no address to write to", async () => {
		requestHelpMock.mockResolvedValue({ ok: true, mailto: null });
		const user = userEvent.setup();
		mountWith([item()]);

		await user.click(
			screen.getByRole("button", { name: "Actions for this item" }),
		);
		await user.click(
			await screen.findByRole("menuitem", { name: "Request help" }),
		);

		await waitFor(() =>
			expect(toastMock.info).toHaveBeenCalledWith(
				expect.stringContaining("no support address is configured"),
			),
		);
		expect(assignedHref).toBeNull();
	});
});

/**
 * The "API Key for CLI" row (Fizzy #2457, U9).
 *
 * Two departures from every other row, and each one is a defect if it silently
 * stops holding:
 *
 *   R21. Its ACTION is offered on the SERVER's organization-role answer
 *        (`cliConnection.viewerCanCreateKey`), not on the panel's project-role
 *        gate. That gate is false for an ordinary organization member — a
 *        project role exists only where a `ProjectMember` row does, and creating
 *        a project seeds none — so leaving this row on it would show the
 *        read-only label to precisely the audience the feature exists for.
 *        The widening reaches the action and the "View only" label that would
 *        otherwise sit beside it, and stops there. The item's actions menu is
 *        a project-role right whichever row it is on: "Not applicable" writes
 *        readiness state through a procedure that requires project edit
 *        rights, and an organization member downgraded to project VIEWER —
 *        supported, since a `ProjectMember` row is authoritative over the
 *        org-role fallback — is answered FORBIDDEN by it.
 *   R15. Its action opens the issuing view in place. The key it mints is shown
 *        exactly once, so no page reached by a link could render the finished
 *        configuration — the row's `target` exists because the rule type
 *        requires one and is not meant to be followed.
 *   R31. Focus comes back to that action when the view closes (AE22), which is
 *        only possible while the action is a real focusable element that is
 *        still in the document — hence the last test, which takes the row away
 *        underneath an open view.
 */
describe("the API Key for CLI row", () => {
	const CLI_ITEM_NAME = "API Key for CLI";
	const CLI_ACTION = "Connect CLI";
	const VIEW_ONLY = "View only";

	function cliItem(overrides: Item = {}): Item {
		return item({
			key: "api-key-for-cli",
			category: "CONTEXT_AND_CONNECTIONS",
			i18nKey: "readiness.items.apiKeyForCli",
			ctaLabelKey: "readiness.cta.apiKeyForCli",
			needLevel: "SHOULD",
			target: { kind: "tab", tab: "overview" },
			...overrides,
		});
	}

	/**
	 * A viewer the PROJECT gate refuses (`canAct: false`) inside an organization
	 * whose role does or does not carry key creation. That combination is the
	 * ordinary case, not an edge one.
	 */
	function mountCliRow(
		options: {
			viewerCanCreateKey?: boolean;
			/** The PROJECT gate, which refuses this viewer unless told otherwise. */
			canAct?: boolean;
			items?: Item[];
			/** Blank it to model the payload that names no project. */
			projectName?: string;
		} = {},
	) {
		organizationRef.current = {
			organizationId: ORGANIZATION_ID,
			organizationSlug: ORGANIZATION_SLUG,
			basePath: `/app/${ORGANIZATION_SLUG}`,
		};
		return mountWith(options.items ?? [cliItem()], {
			canAct: options.canAct ?? false,
			...(options.projectName === undefined
				? {}
				: { projectName: options.projectName }),
			cliConnection: {
				organizationConnected: false,
				viewerCanCreateKey: options.viewerCanCreateKey ?? true,
				viewerDismissed: false,
				promptEligible: true,
			},
		});
	}

	/** The `<li>` an item's name sits in, so one row's controls can be read alone. */
	function rowFor(name: string): HTMLElement {
		const row = screen.getByRole("button", { name }).closest("li");
		if (!row) {
			throw new Error(`no row rendered for "${name}"`);
		}
		return row;
	}

	it("offers the action on the organization answer, where the project gate says no", () => {
		mountCliRow();

		const row = within(rowFor(CLI_ITEM_NAME));
		expect(
			row.getByRole("button", { name: CLI_ACTION }),
		).toBeInTheDocument();
		// "View only" printed beside a live button contradicts it, so the label
		// goes wherever the action is offered.
		expect(row.queryByText(VIEW_ONLY)).not.toBeInTheDocument();
	});

	/**
	 * The two rights are not the same right (Fizzy #2457).
	 *
	 * Creating an organization API key is an organization-role right; changing
	 * an item's readiness state is a project-role one, and the viewer this row
	 * exists for — an organization member, admin or owner explicitly downgraded
	 * to project VIEWER — holds the first and not the second. Their "Not
	 * applicable" reaches a procedure that resolves project permissions with an
	 * active `ProjectMember` row winning over the org-role fallback, and comes
	 * back FORBIDDEN. Offering the action must therefore not offer the menu.
	 */
	it("offers the action without the state controls the server would refuse", () => {
		mountCliRow();

		const row = within(rowFor(CLI_ITEM_NAME));
		expect(
			row.getByRole("button", { name: CLI_ACTION }),
		).toBeInTheDocument();
		expect(
			row.queryByRole("button", { name: "Actions for this item" }),
		).toBeNull();
		// Nothing anywhere on the row offers the entry the procedure refuses.
		expect(row.queryByText("Not applicable")).toBeNull();
	});

	it("keeps the item's own actions for a viewer the project gate allows", () => {
		// The other half of the split: widening the action must not narrow
		// anything for someone who could already act on this row.
		mountCliRow({ canAct: true });

		const row = within(rowFor(CLI_ITEM_NAME));
		expect(
			row.getByRole("button", { name: "Actions for this item" }),
		).toBeInTheDocument();
		expect(
			row.getByRole("button", { name: CLI_ACTION }),
		).toBeInTheDocument();
		expect(row.queryByText(VIEW_ONLY)).not.toBeInTheDocument();
	});

	it("withholds the action from a viewer whose organization role lacks key creation", () => {
		mountCliRow({ viewerCanCreateKey: false });

		// The row itself still reports the organization's state to everyone.
		const row = within(rowFor(CLI_ITEM_NAME));
		expect(row.queryByRole("button", { name: CLI_ACTION })).toBeNull();
		expect(row.queryByRole("link", { name: CLI_ACTION })).toBeNull();
		expect(row.getByText(VIEW_ONLY)).toBeInTheDocument();
	});

	/**
	 * The same withholding for the viewer the PROJECT gate allows (Fizzy #2457,
	 * round 2).
	 *
	 * A project owner or editor without organization key-create rights is an
	 * ordinary combination, and it used to fall through to the panel's generic
	 * call to action: the row is not the in-place-action row for them, so no
	 * action and no override was passed, `canAct` alone decided, and the link
	 * branch rendered an enabled "Connect CLI" built from the item's `target`.
	 * That target names the project Overview tab only to satisfy the rule type
	 * and the CTA drift test — the registry says so where it sets it — so the
	 * button walked them to a page with nothing about connecting a coding tool
	 * on it.
	 *
	 * The two gates are not weaker and stronger answers to one question: on
	 * this row the project answer is not an answer at all, which is why the
	 * organization one replaces it in both directions.
	 */
	it("offers no call to action to a project editor without organization key rights", () => {
		mountCliRow({ canAct: true, viewerCanCreateKey: false });

		const row = within(rowFor(CLI_ITEM_NAME));
		expect(row.queryByRole("button", { name: CLI_ACTION })).toBeNull();
		// Nothing to follow, under any label: the row offers no destination at
		// all rather than one that goes somewhere useless.
		expect(row.queryByRole("link")).toBeNull();
		// Their project-role controls are untouched — this withholds the one
		// action their organization role does not carry, and nothing else.
		expect(
			row.getByRole("button", { name: "Actions for this item" }),
		).toBeInTheDocument();
		// And "View only" would be a lie: they can act on this item, they just
		// cannot mint the key.
		expect(row.queryByText(VIEW_ONLY)).toBeNull();
	});

	it("offers nothing when no organization is resolved, rather than an action that could only fail", () => {
		// The key is minted against the organization HOSTING the project, named
		// explicitly. With none resolved there is nothing to mint against.
		mountWith([cliItem()], {
			canAct: false,
			cliConnection: {
				organizationConnected: false,
				viewerCanCreateKey: true,
				viewerDismissed: false,
				promptEligible: true,
			},
		});

		const row = within(rowFor(CLI_ITEM_NAME));
		expect(row.queryByRole("button", { name: CLI_ACTION })).toBeNull();
		expect(row.getByText(VIEW_ONLY)).toBeInTheDocument();
	});

	it("opens the issuing view in place instead of navigating", async () => {
		const user = userEvent.setup();
		mountCliRow();

		const row = within(rowFor(CLI_ITEM_NAME));
		// Not a link. An anchor here would promise a destination that cannot
		// exist: the secret is returned once and stored as a hash.
		expect(row.queryByRole("link", { name: CLI_ACTION })).toBeNull();

		await user.click(row.getByRole("button", { name: CLI_ACTION }));

		const dialog = await screen.findByRole("dialog");
		expect(dialog).toHaveTextContent("Connect Fabric to your coding tool");
		// The row's own `target` was never followed.
		expect(assignedHref).toBeNull();
		// And opening the view reads nothing: everything it needs, the project's
		// name included, was already on the readiness payload.
		expect(projectGetMock).not.toHaveBeenCalled();
	});

	/**
	 * Where the issuing view's project name comes from (Fizzy #2457).
	 *
	 * It used to come from a second `projects.get` the panel opened only when
	 * the view did. The readiness read carries the name now, so the assertion
	 * is in two halves: the sentence names the project, and nothing was read to
	 * find that out.
	 */
	it("names the project from the readiness payload, reading nothing more", async () => {
		const user = userEvent.setup();
		mountCliRow();

		await user.click(
			within(rowFor(CLI_ITEM_NAME)).getByRole("button", {
				name: CLI_ACTION,
			}),
		);
		await user.click(
			await screen.findByRole("button", { name: /create the key/i }),
		);

		const instruction = await screen.findByTestId(
			"connect-cli-starter-instruction",
		);
		expect(instruction).toHaveTextContent(PROJECT);
		expect(projectGetMock).not.toHaveBeenCalled();
	});

	/**
	 * The payload names no project when there is none to name — the
	 * flag-disabled shape, and the first render before the read lands. That is
	 * an EMPTY STRING rather than a missing field, so the fallback has to be
	 * `||`; `??` would put an empty quoted name in the middle of the sentence.
	 */
	it("falls back to a generic name when the payload names no project", async () => {
		const user = userEvent.setup();
		mountCliRow({ projectName: "" });

		await user.click(
			within(rowFor(CLI_ITEM_NAME)).getByRole("button", {
				name: CLI_ACTION,
			}),
		);
		await user.click(
			await screen.findByRole("button", { name: /create the key/i }),
		);

		const instruction = await screen.findByTestId(
			"connect-cli-starter-instruction",
		);
		expect(instruction).toHaveTextContent('the project "this project"');
	});

	it("mints nothing by opening the view", async () => {
		const user = userEvent.setup();
		mountCliRow();

		await user.click(
			within(rowFor(CLI_ITEM_NAME)).getByRole("button", {
				name: CLI_ACTION,
			}),
		);
		await screen.findByRole("dialog");

		expect(createKeyMock).not.toHaveBeenCalled();
	});

	it("leaves every other row on the panel's own gate", () => {
		mountCliRow({ items: [cliItem(), item()] });

		const ordinary = within(rowFor("Feature Snapshot"));
		expect(ordinary.getByText(VIEW_ONLY)).toBeInTheDocument();
		expect(
			ordinary.queryByRole("button", { name: "Actions for this item" }),
		).toBeNull();
		expect(
			ordinary.queryByRole("link", { name: "Define Features" }),
		).toBeNull();
		// ...while the widened row is fully live.
		expect(
			within(rowFor(CLI_ITEM_NAME)).getByRole("button", {
				name: CLI_ACTION,
			}),
		).toBeInTheDocument();
	});

	it("returns focus to the row's action when the view closes (AE22)", async () => {
		const user = userEvent.setup();
		mountCliRow();

		const action = within(rowFor(CLI_ITEM_NAME)).getByRole("button", {
			name: CLI_ACTION,
		});
		await user.click(action);
		await screen.findByRole("dialog");

		await user.click(screen.getByRole("button", { name: /^cancel$/i }));

		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);
		// Not `document.body`: a keyboard-only reader has to land back where
		// they were, not at the top of the page.
		await waitFor(() => expect(action).toHaveFocus());
	});

	it("keeps the view open when the readiness refetch takes its row away", async () => {
		const user = userEvent.setup();
		const { refresh } = mountCliRow();

		await user.click(
			within(rowFor(CLI_ITEM_NAME)).getByRole("button", {
				name: CLI_ACTION,
			}),
		);
		await screen.findByRole("dialog");

		// Issuing a key is a successful mutation, and the provider re-reads on
		// any of those. That read can move the row, filter it out or change the
		// eligibility that decides whether it renders at all — while the view is
		// still holding the only copy of the secret. So the view must not be
		// mounted inside the row, or inside anything the row's eligibility
		// gates. (The read does not COMPLETE the item: the rule detects a CLI
		// that has actually reached Fabric, which minting a key is not.)
		refresh([]);

		expect(screen.queryByText(CLI_ITEM_NAME)).not.toBeInTheDocument();
		expect(screen.getByRole("dialog")).toHaveTextContent(
			"Connect Fabric to your coding tool",
		);
	});
});
