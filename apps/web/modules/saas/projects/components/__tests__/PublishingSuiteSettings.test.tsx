import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublishingSuiteSettings } from "../PublishingSuiteSettings";

const getMock = vi.fn();
const updateMock = vi.fn();
const generateMock = vi.fn();
const teamsLinkedMock = vi.fn();
const slackLinkedMock = vi.fn();

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			publishingSuite: {
				getSettings: (...a: unknown[]) => getMock(...a),
				updateSettings: (...a: unknown[]) => updateMock(...a),
				generateNow: (...a: unknown[]) => generateMock(...a),
			},
			teamsChannelMonitor: {
				listLinkedChannels: (...a: unknown[]) => teamsLinkedMock(...a),
			},
			slackChannelMonitor: {
				listLinkedChannels: (...a: unknown[]) => slackLinkedMock(...a),
			},
		},
	},
}));

const toastError = vi.fn();
const toastSuccess = vi.fn();
const toastInfo = vi.fn();
vi.mock("sonner", () => ({
	toast: {
		error: (...a: unknown[]) => toastError(...a),
		success: (...a: unknown[]) => toastSuccess(...a),
		info: (...a: unknown[]) => toastInfo(...a),
	},
}));

function renderCard(
	canEdit: boolean,
	canGenerate = canEdit,
	onNavigateToChatChannels?: () => void,
) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	// The client is returned, not just used: one case below has to drive a
	// REFETCH to observe what the textareas' remount key does, and there is no
	// other handle on it from outside the provider.
	return {
		client,
		...render(
			<QueryClientProvider client={client}>
				<PublishingSuiteSettings
					projectId="proj_1"
					organizationId={null}
					canEdit={canEdit}
					canGenerate={canGenerate}
					onNavigateToChatChannels={onNavigateToChatChannels}
				/>
			</QueryClientProvider>,
		),
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	getMock.mockResolvedValue({
		settings: {
			id: null,
			projectId: "proj_1",
			cadence: "WEEKLY",
			lookbackDays: null,
			notificationsEnabled: true,
		},
	});
	updateMock.mockResolvedValue({ settings: { cadence: "MONTHLY" } });
	generateMock.mockResolvedValue({ status: "started" });
	teamsLinkedMock.mockResolvedValue([]);
	slackLinkedMock.mockResolvedValue([
		{
			slackTeamId: "T-example",
			channelId: "C-example",
			channelName: "release-notes",
		},
	]);
});
afterEach(() => vi.clearAllMocks());

describe("PublishingSuiteSettings", () => {
	it("does not show a fabricated cadence while the settings query is loading", async () => {
		// Regression guard for the client inventing its own "?? WEEKLY"
		// default: hold the settings read open and confirm the control shows
		// its neutral placeholder, not any specific cadence, until the read
		// resolves.
		let resolveSettings!: (value: {
			settings: {
				id: string | null;
				projectId: string;
				cadence: string;
				lookbackDays: number | null;
				notificationsEnabled: boolean;
			};
		}) => void;
		getMock.mockReturnValue(
			new Promise((resolve) => {
				resolveSettings = resolve;
			}),
		);

		renderCard(true);

		const select = await screen.findByLabelText(/suggestion cadence/i);
		for (const label of ["weekly", "manual", "biweekly", "monthly"]) {
			expect(select).not.toHaveTextContent(new RegExp(label, "i"));
		}

		resolveSettings({
			settings: {
				id: null,
				projectId: "proj_1",
				cadence: "MANUAL",
				lookbackDays: null,
				notificationsEnabled: true,
			},
		});

		await waitFor(() => {
			expect(select).toHaveTextContent(/manual/i);
		});
	});

	it("saves a cadence change", async () => {
		const user = userEvent.setup();
		renderCard(true);

		await screen.findByLabelText(/suggestion cadence/i);
		await user.click(screen.getByLabelText(/suggestion cadence/i));
		await user.click(
			await screen.findByRole("option", { name: /monthly/i }),
		);

		await waitFor(() => {
			expect(updateMock).toHaveBeenCalledWith(
				expect.objectContaining({
					projectId: "proj_1",
					organizationId: null,
					cadence: "MONTHLY",
				}),
			);
		});
	});

	it("disables every control for a user with neither capability", async () => {
		renderCard(false, false);
		const select = await screen.findByLabelText(/suggestion cadence/i);
		expect(select).toBeDisabled();
		expect(
			screen.getByRole("button", { name: /generate now/i }),
		).toBeDisabled();
	});

	it("lets an Editor generate while the admin-only settings stay locked", async () => {
		// An Editor holds PUBLISHING_TOPIC_CREATE but not PROJECT_SETTINGS_EDIT.
		// Gating the button on the settings capability would make MANUAL cadence
		// unusable for the very role the endpoint authorizes.
		const user = userEvent.setup();
		renderCard(false, true);

		expect(
			await screen.findByLabelText(/suggestion cadence/i),
		).toBeDisabled();
		const generate = screen.getByRole("button", { name: /generate now/i });
		expect(generate).toBeEnabled();

		await user.click(generate);

		await waitFor(() => expect(generateMock).toHaveBeenCalled());
		// "started" is the fourth of four distinct result statuses — assert its
		// toast too, not just that the mutation fired.
		await waitFor(() => {
			expect(toastSuccess).toHaveBeenCalledWith(
				"Generating new topic suggestions now.",
			);
		});
	});

	it("surfaces an in-progress generate as an informational message distinct from success or error", async () => {
		generateMock.mockResolvedValue({ status: "in_flight" });
		const user = userEvent.setup();
		renderCard(true);

		await user.click(
			await screen.findByRole("button", { name: /generate now/i }),
		);

		await waitFor(() => {
			expect(toastInfo).toHaveBeenCalledWith(
				expect.stringMatching(/already in progress/i),
			);
		});
		expect(toastSuccess).not.toHaveBeenCalled();
		expect(toastError).not.toHaveBeenCalled();
	});

	it("surfaces a rate-limited generate as a message rather than silence", async () => {
		generateMock.mockResolvedValue({ status: "rate_limited" });
		const user = userEvent.setup();
		renderCard(true);

		await user.click(
			await screen.findByRole("button", { name: /generate now/i }),
		);

		await waitFor(() => {
			expect(toastError).toHaveBeenCalledWith(
				expect.stringMatching(/recently|wait|hour/i),
			);
		});
	});

	it("surfaces an unavailable generate as an error distinct from rate-limiting", async () => {
		generateMock.mockResolvedValue({ status: "unavailable" });
		const user = userEvent.setup();
		renderCard(true);

		await user.click(
			await screen.findByRole("button", { name: /generate now/i }),
		);

		await waitFor(() => {
			expect(toastError).toHaveBeenCalledWith(
				expect.stringMatching(/unavailable/i),
			);
		});
		// Both rate_limited and unavailable route through toast.error — prove
		// the two are still told apart by message content.
		expect(toastError).not.toHaveBeenCalledWith(
			expect.stringMatching(/recently|wait|hour/i),
		);
	});

	it("reports a save failure instead of failing silently", async () => {
		updateMock.mockRejectedValue(new Error("nope"));
		const user = userEvent.setup();
		renderCard(true);

		await screen.findByLabelText(/suggestion cadence/i);
		await user.click(screen.getByLabelText(/suggestion cadence/i));
		await user.click(
			await screen.findByRole("option", { name: /monthly/i }),
		);

		await waitFor(() => expect(toastError).toHaveBeenCalled());
	});

	it("saves an in-range lookback value on blur", async () => {
		const user = userEvent.setup();
		renderCard(true);

		const input = await screen.findByLabelText(/lookback window/i);
		await user.click(input);
		await user.type(input, "45");
		await user.tab();

		await waitFor(() => {
			expect(updateMock).toHaveBeenCalledWith(
				expect.objectContaining({ lookbackDays: 45 }),
			);
		});
	});

	it("clamps an out-of-range lookback value on blur instead of saving it raw", async () => {
		const user = userEvent.setup();
		renderCard(true);

		const input = await screen.findByLabelText(/lookback window/i);
		await user.click(input);
		await user.type(input, "9001");
		await user.tab();

		await waitFor(() => {
			expect(updateMock).toHaveBeenCalledWith(
				expect.objectContaining({ lookbackDays: 365 }),
			);
		});
		expect(updateMock).not.toHaveBeenCalledWith(
			expect.objectContaining({ lookbackDays: 9001 }),
		);
	});

	it("clears the lookback field to the engine default rather than zero", async () => {
		getMock.mockResolvedValue({
			settings: {
				id: null,
				projectId: "proj_1",
				cadence: "WEEKLY",
				lookbackDays: 30,
				notificationsEnabled: true,
			},
		});
		const user = userEvent.setup();
		renderCard(true);

		// The input is uncontrolled and remounts (via `key`) once the loaded
		// lookbackDays differs from the pre-load default — poll by label
		// rather than caching a node reference that the remount would orphan.
		await waitFor(() => {
			expect(screen.getByLabelText(/lookback window/i)).toHaveValue(30);
		});
		const input = screen.getByLabelText(/lookback window/i);
		await user.click(input);
		await user.clear(input);
		await user.tab();

		await waitFor(() => {
			expect(updateMock).toHaveBeenCalledWith(
				expect.objectContaining({ lookbackDays: null }),
			);
		});
		expect(updateMock).not.toHaveBeenCalledWith(
			expect.objectContaining({ lookbackDays: 0 }),
		);
	});

	it("saves a notify-contributors toggle", async () => {
		const user = userEvent.setup();
		renderCard(true);

		const toggle = await screen.findByRole("switch", {
			name: /notify contributors/i,
		});
		expect(toggle).toBeChecked();
		await user.click(toggle);

		await waitFor(() => {
			expect(updateMock).toHaveBeenCalledWith(
				expect.objectContaining({ notificationsEnabled: false }),
			);
		});
	});

	// The chat broadcast picker. The selection IS the on/off state — there is no
	// separate boolean, deliberately — which is why the empty-list case below is
	// a behaviour test rather than a formality.
	const settingsWithChannel = {
		settings: {
			id: "s1",
			projectId: "proj_1",
			cadence: "WEEKLY",
			lookbackDays: null,
			notificationsEnabled: true,
			chatChannels: [
				{
					platform: "SLACK",
					teamId: "T-example",
					channelId: "C-example",
				},
			],
		},
	};

	it("reflects the persisted selection as checked", async () => {
		getMock.mockResolvedValue(settingsWithChannel);
		renderCard(true);

		const box = await screen.findByLabelText(/SLACK: release-notes/i);
		expect(box).toBeChecked();
	});

	it("adds a channel to the selection when it is checked", async () => {
		const user = userEvent.setup();
		renderCard(true);

		const box = await screen.findByLabelText(/SLACK: release-notes/i);
		expect(box).not.toBeChecked();
		await user.click(box);

		await waitFor(() => {
			expect(updateMock).toHaveBeenCalledWith(
				expect.objectContaining({
					chatChannels: [
						{
							platform: "SLACK",
							teamId: "T-example",
							channelId: "C-example",
							channelName: "release-notes",
						},
					],
				}),
			);
		});
	});

	it("sends an empty list when the last selected channel is unchecked", async () => {
		// The case that proves the off switch reaches the server. With no separate
		// boolean, unchecking the last box is the ONLY way to turn chat off, and a
		// client that skipped the call on an empty array — or sent `undefined` —
		// would leave it permanently on with no control that says so.
		getMock.mockResolvedValue(settingsWithChannel);
		const user = userEvent.setup();
		renderCard(true);

		const box = await screen.findByLabelText(/SLACK: release-notes/i);
		await user.click(box);

		await waitFor(() => {
			expect(updateMock).toHaveBeenCalledWith(
				expect.objectContaining({ chatChannels: [] }),
			);
		});
	});

	it("points at channel setup when the project has none linked", async () => {
		slackLinkedMock.mockResolvedValue([]);
		const onNavigate = vi.fn();
		renderCard(true, true, onNavigate);

		expect(
			await screen.findByText(/connect a teams or slack channel/i),
		).toBeInTheDocument();

		// The copy alone was all this case used to assert, and it passed for
		// months while the empty state was a dead end: prose naming a
		// destination the reader had no way to reach. "Points at" has to mean
		// the reader can follow it, or the name overstates the assertion.
		await userEvent.click(
			screen.getByRole("button", { name: /connect a channel/i }),
		);
		expect(onNavigate).toHaveBeenCalledTimes(1);
	});

	it("offers channel setup when channels are ALREADY linked", async () => {
		// The reported case. A project with channels linked still had no way to
		// reach one more, because the only affordance lived in the empty-state
		// branch — the one branch such a project never renders.
		const onNavigate = vi.fn();
		renderCard(true, true, onNavigate);

		await screen.findByLabelText(/SLACK: release-notes/i);
		await userEvent.click(
			screen.getByRole("button", { name: /connect a channel/i }),
		);
		expect(onNavigate).toHaveBeenCalledTimes(1);
	});

	it("renders no connect affordance when the host offers no way to navigate", async () => {
		// The prop is optional, and a host that cannot switch tabs must not get
		// a button that does nothing when clicked.
		renderCard(true);

		await screen.findByLabelText(/SLACK: release-notes/i);
		expect(
			screen.queryByRole("button", { name: /connect a channel/i }),
		).not.toBeInTheDocument();
	});

	it("disables the picker for a user who cannot edit settings", async () => {
		renderCard(false);

		const box = await screen.findByLabelText(/SLACK: release-notes/i);
		expect(box).toBeDisabled();
	});
});

/**
 * 1C-1b part 2 (§7.1(a), FR8–FR10): the advisory recommendation preferences.
 *
 * Themes and priorities are one-per-line textareas rather than comma-separated
 * inputs — a comma is a plausible character inside a theme, and a delimiter the
 * value can legitimately contain is a delimiter that will eventually split
 * somebody's input in half.
 *
 * The states that matter here are the CLEAR states. An emptied list must reach
 * the API as `[]` and an emptied textarea as `null`; either one arriving as
 * `undefined` means "leave it alone", so the clear would silently do nothing
 * and the user would have no way to tell.
 */
function settingsWithPreferences(overrides: Record<string, unknown> = {}) {
	return {
		settings: {
			id: "s1",
			projectId: "proj_1",
			cadence: "WEEKLY",
			lookbackDays: null,
			notificationsEnabled: true,
			preferredThemes: ["Developer Experience", "Release Engineering"],
			preferredPostTypes: ["BLOG_POST"],
			strategicPriorities: "Ship weekly.\nName the trade-off.",
			...overrides,
		},
	};
}

/**
 * Every preference control is disabled while the settings read is in flight
 * (`settingsDisabled` includes `settingsQuery.isLoading`), and `findByLabelText`
 * resolves as soon as the element EXISTS — which is during exactly that window.
 * Interacting there fails with "clear() is only supported on editable
 * elements", which reads like a broken control rather than a race.
 */
async function findEnabled(matcher: RegExp) {
	await screen.findByLabelText(matcher);
	// RE-QUERIED inside waitFor, never held. The textareas carry a `key`
	// derived from the stored value, so React REMOUNTS them the moment the
	// settings read lands — a reference captured before that points at a
	// detached node that stays disabled forever. The checkboxes have no such
	// key, which is why they passed while the textareas timed out.
	await waitFor(() => expect(screen.getByLabelText(matcher)).toBeEnabled());
	return screen.getByLabelText(matcher);
}

describe("PublishingSuiteSettings — recommendation preferences", () => {
	beforeEach(() => {
		getMock.mockResolvedValue(settingsWithPreferences());
	});

	it("re-renders the themes textarea when a refetch swaps [A, B] for [A B] — the shapes a joined key collides", async () => {
		// The textarea is UNCONTROLLED: `defaultValue` is read once per mount, so
		// the `key` is the only thing that shows a new server value. Keying on
		// `preferredThemes.join(" ")` makes ["Alpha", "Beta"] and ["Alpha Beta"]
		// the same key — React keeps the node mounted, ignores the new
		// defaultValue, and the admin goes on reading text the project no longer
		// has. Two themes becoming one is the ordinary result of another editor
		// joining a line, so this is not an exotic shape.
		getMock.mockResolvedValue(
			settingsWithPreferences({ preferredThemes: ["Alpha", "Beta"] }),
		);
		const { client } = renderCard(true);
		await findEnabled(/preferred themes/i);
		expect(screen.getByLabelText(/preferred themes/i)).toHaveValue(
			"Alpha" + String.fromCharCode(10) + "Beta",
		);

		getMock.mockResolvedValue(
			settingsWithPreferences({ preferredThemes: ["Alpha Beta"] }),
		);
		await client.invalidateQueries();

		await waitFor(() =>
			expect(screen.getByLabelText(/preferred themes/i)).toHaveValue(
				"Alpha Beta",
			),
		);
	});

	it("renders the three controls with their stored values", async () => {
		renderCard(true);

		await findEnabled(/preferred themes/i);
		expect(screen.getByLabelText(/preferred themes/i)).toHaveValue(
			"Developer Experience\nRelease Engineering",
		);
		expect(screen.getByLabelText(/strategic priorities/i)).toHaveValue(
			"Ship weekly.\nName the trade-off.",
		);
		// Post types are a fixed set of checkboxes over the enum, never a text
		// input: a free-form value here would be a preference the generator can
		// never satisfy.
		expect(await screen.findByLabelText(/^Blog Post$/i)).toBeChecked();
		expect(await findEnabled(/^Tweet$/i)).not.toBeChecked();
	});

	it("renders NO exclusion control", async () => {
		// An explicit negative assertion, not an omission. `excludedKeywords`
		// ships in C-3 together with the deterministic filter that enforces it;
		// this guard is what stops a well-meaning edit adding the input first and
		// handing an admin a switch that visibly does nothing.
		renderCard(true);

		await findEnabled(/preferred themes/i);
		expect(screen.queryByLabelText(/excluded keywords/i)).toBeNull();
	});

	it("sends an emptied themes list as [], not undefined", async () => {
		const user = userEvent.setup();
		renderCard(true);

		const themes = await findEnabled(/preferred themes/i);
		await user.clear(themes);
		await user.tab();

		await waitFor(() => {
			expect(updateMock).toHaveBeenCalledWith(
				expect.objectContaining({ preferredThemes: [] }),
			);
		});
	});

	it("sends emptied priorities as null, not an empty string", async () => {
		// The state a form gets wrong by default: an emptied textarea yields "",
		// and "" stored where null belongs hashes differently from "never set" —
		// buying the project a reprocessing run it did not earn.
		const user = userEvent.setup();
		renderCard(true);

		const priorities = await findEnabled(/strategic priorities/i);
		await user.clear(priorities);
		await user.tab();

		await waitFor(() => {
			expect(updateMock).toHaveBeenCalledWith(
				expect.objectContaining({ strategicPriorities: null }),
			);
		});
	});

	it("drops blank lines and trims rather than sending them", async () => {
		const user = userEvent.setup();
		renderCard(true);

		const themes = await findEnabled(/preferred themes/i);
		await user.clear(themes);
		await user.type(themes, "  Alpha  {Enter}{Enter}Beta{Enter}");
		await user.tab();

		await waitFor(() => {
			expect(updateMock).toHaveBeenCalledWith(
				expect.objectContaining({ preferredThemes: ["Alpha", "Beta"] }),
			);
		});
	});

	it("collapses an inner whitespace run before measuring, so a theme the API accepts is not refused here", async () => {
		// Raised in adversarial review of the boundary change. The oRPC schema
		// normalizes each theme BEFORE applying the 60-character cap, so this
		// value — 40 + 5 spaces + 19 = 64 raw, 60 collapsed — is legal server
		// side. While the form measured the merely-trimmed line it refused to
		// save it, and the error named a length the user could not see, because
		// the characters being counted are ones the model never receives.
		//
		// The assertion is on what is SENT, not on the absence of a toast: a
		// version that silently truncated to 60 would also produce no toast.
		const user = userEvent.setup();
		renderCard(true);

		const collapsed = `${"x".repeat(40)} ${"y".repeat(19)}`;
		const themes = await findEnabled(/preferred themes/i);
		await user.clear(themes);
		await user.type(themes, `${"x".repeat(40)}     ${"y".repeat(19)}`);
		await user.tab();

		await waitFor(() => {
			expect(updateMock).toHaveBeenCalledWith(
				expect.objectContaining({ preferredThemes: [collapsed] }),
			);
		});
		expect(collapsed).toHaveLength(60);
		expect(toastError).not.toHaveBeenCalled();
	});

	it("refuses to save more themes than the cap allows and says so", async () => {
		const user = userEvent.setup();
		renderCard(true);

		const themes = await findEnabled(/preferred themes/i);
		await user.clear(themes);
		await user.type(
			themes,
			Array.from({ length: 26 }, (_, i) => `Theme ${i}`).join("{Enter}"),
		);
		await user.tab();

		await waitFor(() => {
			expect(toastError).toHaveBeenCalled();
		});
		expect(updateMock).not.toHaveBeenCalled();
	});

	it("refuses to save a theme longer than the per-item cap", async () => {
		const user = userEvent.setup();
		renderCard(true);

		const themes = await findEnabled(/preferred themes/i);
		await user.clear(themes);
		await user.type(themes, "a".repeat(61));
		await user.tab();

		await waitFor(() => {
			expect(toastError).toHaveBeenCalled();
		});
		expect(updateMock).not.toHaveBeenCalled();
	});

	it("toggles a post type without disturbing the others", async () => {
		const user = userEvent.setup();
		renderCard(true);

		await user.click(await findEnabled(/^Tweet$/i));

		await waitFor(() => {
			expect(updateMock).toHaveBeenCalledWith(
				expect.objectContaining({
					preferredPostTypes: ["BLOG_POST", "TWEET"],
				}),
			);
		});
	});

	it("disables every preference control without edit permission", async () => {
		renderCard(false);

		expect(
			await screen.findByLabelText(/preferred themes/i),
		).toBeDisabled();
		expect(
			await screen.findByLabelText(/strategic priorities/i),
		).toBeDisabled();
		expect(await screen.findByLabelText(/^Tweet$/i)).toBeDisabled();
	});
});
