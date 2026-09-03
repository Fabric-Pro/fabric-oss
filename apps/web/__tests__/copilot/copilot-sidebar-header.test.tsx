/**
 * Tests for `CopilotSidebarHeader` — spec §3.3 FR-10, §3.5 FR-17/FR-18,
 * §6.2, §6.6, AC-8, AC-13.
 *
 * The header is the surface that:
 *   - Lets the author toggle visibility (SHARED ↔ PRIVATE) BEFORE the
 *     first message is persisted, and shows a locked indicator once the
 *     first turn pins the visibility.
 *   - Lets the author start a new conversation (archives the live thread
 *     server-side, then resets the local conversationId).
 *   - Lets the author open the history drawer (Group F renders the
 *     drawer itself; here we only verify the flip).
 *
 * What we DON'T cover here
 * ------------------------
 * Radix Tooltip's open/close lifecycle is delicate inside jsdom (portal
 * + pointer/keyboard timing). We assert the trigger structure +
 * aria-labels and let Radix's own suite cover the tooltip portal open
 * states. Same trade-off as `HelpTooltip.test.tsx`.
 *
 * Why next-intl is pass-through
 * -----------------------------
 * The translator mock returns the key as-is, so assertions reference
 * the i18n key (e.g. `assistantNewConversation`) instead of the
 * resolved English copy. That keeps tests stable across locale string
 * tweaks — the spec freezes the keys, not the English text.
 */

import { CopilotChatSessionProvider } from "@saas/shared/components/copilot/CopilotChatSessionProvider";
import {
	fireEvent,
	render as rtlRender,
	screen,
	waitFor,
} from "@testing-library/react";

// Every component under test reads its CopilotKit chat state from
// `<CopilotChatSessionProvider>` (one `useCopilotChatInternal()` per surface —
// see the provider's doc-comment and Fizzy #2389), so each render mounts the
// real provider over this file's mocked `useCopilotChatInternal`.
function render(ui: Parameters<typeof rtlRender>[0]) {
	return rtlRender(ui, { wrapper: CopilotChatSessionProvider });
}

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockSetVisibility,
	mockArchive,
	mockToastError,
	mockToastSuccess,
	mockLiveMessagesRef,
	mockSetOpen,
} = vi.hoisted(() => ({
	mockSetVisibility: vi.fn(),
	mockArchive: vi.fn(),
	mockToastError: vi.fn(),
	mockToastSuccess: vi.fn(),
	mockLiveMessagesRef: {
		current: [] as Array<{ role: string }>,
	},
	mockSetOpen: vi.fn(),
}));

// Mock `@copilotkit/react-core` to (a) avoid pulling in the package's
// transitive CSS imports (jsdom can't load `katex.min.css`) and (b)
// drive the `useCopilotChatInternal().messages` signal that
// `VisibilityChip` reads to derive the "first user message has landed"
// lock condition. Tests that exercise the lock-on-live-message path
// push entries into `mockLiveMessagesRef.current` BEFORE rendering.
vi.mock("@copilotkit/react-core", () => ({
	useCopilotChatInternal: () => ({
		messages: mockLiveMessagesRef.current,
	}),
}));

// The header reads `useChatContext().setOpen` from `@copilotkit/react-ui` to
// drive its close button. Mock it for the same reason react-core is mocked
// above — the real `@copilotkit/react-ui` barrel pulls in transitive CSS
// (`katex.min.css`) that jsdom can't load.
vi.mock("@copilotkit/react-ui", () => ({
	useChatContext: () => ({ open: true, setOpen: mockSetOpen }),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		agents: {
			conversations: {
				setVisibilityForDocument: (input: unknown) =>
					mockSetVisibility(input),
				archiveForDocument: (input: unknown) => mockArchive(input),
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: {
		success: (...args: unknown[]) => mockToastSuccess(...args),
		error: (...args: unknown[]) => mockToastError(...args),
	},
}));

// Translator is pass-through so we can assert on i18n keys (stable
// across copy edits) rather than the resolved English text.
vi.mock("next-intl", () => ({
	useTranslations: (_ns?: string) => (k: string) => k,
}));

import {
	CopilotSidebarHeader,
	type CopilotSidebarHeaderConfig,
} from "../../modules/saas/projects/components/copilot/CopilotSidebarHeader";

const baseConfig = (
	overrides: Partial<CopilotSidebarHeaderConfig> = {},
): CopilotSidebarHeaderConfig => ({
	title: "AI Assistant",
	documentRefKind: "PROJECT_DOCUMENT",
	documentRefId: "doc-1",
	projectId: "proj-1",
	organizationId: "org-1",
	conversationId: null,
	visibility: "SHARED",
	visibilityLockedAt: null,
	onNewConversation: vi.fn(),
	onOpenHistory: vi.fn(),
	...overrides,
});

describe("CopilotSidebarHeader — visibility chip (pre-lock)", () => {
	beforeEach(() => {
		mockSetVisibility.mockReset();
		mockArchive.mockReset();
		mockToastError.mockReset();
		mockToastSuccess.mockReset();
	});

	it("renders a role=switch toggle with aria-checked=false when SHARED + unlocked", () => {
		render(<CopilotSidebarHeader config={baseConfig()} />);
		const toggle = screen.getByRole("switch", {
			name: /Conversation visibility: Shared/i,
		});
		expect(toggle).toBeInTheDocument();
		// `aria-checked` is the canonical ARIA attribute for role=switch.
		// PRIVATE === checked (the "on" state of the privacy lever).
		expect(toggle.getAttribute("aria-checked")).toBe("false");
		// Visible text label matches the visibility state.
		expect(toggle.textContent).toMatch(/Shared/);
	});

	it("flips optimistically to PRIVATE on click when no conversation row exists yet (pre-first-send)", async () => {
		// `conversationId === null` is the brand-new-thread case from
		// spec FR-17 — visibility applies on the next persisted turn via
		// `appendTurnForDocument({ requestedVisibility })` rather than
		// via `setVisibilityForDocument`. So we assert the network call
		// is NOT made yet.
		render(
			<CopilotSidebarHeader
				config={baseConfig({ conversationId: null })}
			/>,
		);
		const toggle = screen.getByRole("switch", {
			name: /Conversation visibility: Shared/i,
		});
		fireEvent.click(toggle);
		// Optimistic flip — the chip now claims PRIVATE.
		const flipped = await screen.findByRole("switch", {
			name: /Conversation visibility: Private/i,
		});
		expect(flipped.getAttribute("aria-checked")).toBe("true");
		expect(mockSetVisibility).not.toHaveBeenCalled();
	});

	it("calls setVisibilityForDocument when an active conversation row exists", async () => {
		mockSetVisibility.mockResolvedValueOnce({
			conversation: {
				id: "row-1",
				visibility: "PRIVATE",
				visibilityLockedAt: null,
			},
		});
		render(
			<CopilotSidebarHeader
				config={baseConfig({ conversationId: "conv-abc" })}
			/>,
		);
		fireEvent.click(
			screen.getByRole("switch", {
				name: /Conversation visibility: Shared/i,
			}),
		);
		await waitFor(() => {
			expect(mockSetVisibility).toHaveBeenCalledWith({
				conversationId: "conv-abc",
				organizationId: "org-1",
				visibility: "PRIVATE",
			});
		});
	});

	it("reverts optimistic state + toasts on a CONFLICT (raced first-send lock)", async () => {
		// Spec §3.5 FR-18 / AC-8 — server returns CONFLICT when the
		// row's `visibilityLockedAt` is set by the time the toggle
		// reaches the server.
		mockSetVisibility.mockRejectedValueOnce(
			new Error("Visibility locked after first message"),
		);
		render(
			<CopilotSidebarHeader
				config={baseConfig({ conversationId: "conv-abc" })}
			/>,
		);
		fireEvent.click(
			screen.getByRole("switch", {
				name: /Conversation visibility: Shared/i,
			}),
		);
		await waitFor(() => {
			expect(mockToastError).toHaveBeenCalledWith(
				"Visibility locked after first message",
			);
		});
		// Optimistic flip reverted — chip is back to SHARED + interactive.
		const reverted = await screen.findByRole("switch", {
			name: /Conversation visibility: Shared/i,
		});
		expect(reverted.getAttribute("aria-checked")).toBe("false");
	});
});

describe("CopilotSidebarHeader — visibility chip (post-lock)", () => {
	beforeEach(() => {
		mockSetVisibility.mockReset();
	});

	it("renders a non-interactive locked chip with a tabIndex of -1 when visibilityLockedAt is set", () => {
		render(
			<CopilotSidebarHeader
				config={baseConfig({
					conversationId: "conv-abc",
					visibility: "PRIVATE",
					visibilityLockedAt: "2026-05-20T10:00:00Z",
				})}
			/>,
		);
		// Post-lock: NOT a button. Spec §6.6 — don't render the toggle
		// as `disabled` because that conveys the wrong affordance.
		expect(
			screen.queryByRole("switch", {
				name: /Conversation visibility/i,
			}),
		).toBeNull();
		// The chip is present but out of the tab order.
		const locked = screen.getByLabelText(
			/Conversation visibility: Private \(locked\)/i,
		);
		expect(locked).toBeInTheDocument();
		expect(locked.getAttribute("tabindex")).toBe("-1");
	});

	it("does NOT call setVisibilityForDocument when the chip is locked", () => {
		render(
			<CopilotSidebarHeader
				config={baseConfig({
					conversationId: "conv-abc",
					visibility: "SHARED",
					visibilityLockedAt: "2026-05-20T10:00:00Z",
				})}
			/>,
		);
		// There is no clickable button to invoke the network call.
		expect(
			screen.queryByRole("switch", {
				name: /Conversation visibility/i,
			}),
		).toBeNull();
		expect(mockSetVisibility).not.toHaveBeenCalled();
	});
});

describe("CopilotSidebarHeader — plus-icon (new conversation)", () => {
	beforeEach(() => {
		mockArchive.mockReset();
	});

	it("fires onNewConversation on click", () => {
		const onNewConversation = vi.fn();
		render(
			<CopilotSidebarHeader config={baseConfig({ onNewConversation })} />,
		);
		fireEvent.click(
			screen.getByRole("button", { name: /Start a new conversation/i }),
		);
		expect(onNewConversation).toHaveBeenCalledTimes(1);
		// The header itself does not call `archiveForDocument` —
		// that's the parent's responsibility (`DocumentEditor`'s
		// `handleNewConversation`). The header is just the trigger.
		expect(mockArchive).not.toHaveBeenCalled();
	});
});

describe("CopilotSidebarHeader — history-icon", () => {
	it("fires onOpenHistory on click", () => {
		const onOpenHistory = vi.fn();
		render(<CopilotSidebarHeader config={baseConfig({ onOpenHistory })} />);
		fireEvent.click(
			screen.getByRole("button", { name: /Open chat history/i }),
		);
		expect(onOpenHistory).toHaveBeenCalledTimes(1);
	});
});

describe("CopilotSidebarHeader — close control", () => {
	beforeEach(() => {
		mockSetOpen.mockReset();
	});

	it("renders a close button that dismisses the panel via setOpen(false)", () => {
		// Regression guard: Fabric replaces CopilotKit's default sidebar header
		// (which ships a close button) with this custom one, so the custom
		// header must re-add a close affordance wired to the chat context's
		// setOpen — otherwise an opened panel can never be dismissed.
		render(<CopilotSidebarHeader config={baseConfig()} />);
		const closeButton = screen.getByRole("button", {
			name: /Close the AI Assistant panel/i,
		});
		expect(closeButton).toBeInTheDocument();
		fireEvent.click(closeButton);
		expect(mockSetOpen).toHaveBeenCalledWith(false);
	});

	it("keeps the new-conversation and history controls alongside close", () => {
		render(<CopilotSidebarHeader config={baseConfig()} />);
		expect(
			screen.getByRole("button", { name: /Start a new conversation/i }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /Open chat history/i }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", {
				name: /Close the AI Assistant panel/i,
			}),
		).toBeInTheDocument();
	});
});

describe("CopilotSidebarHeader — visibility-locked-at change re-syncs from props", () => {
	it("flips from interactive toggle to locked chip when visibilityLockedAt arrives", () => {
		const { rerender } = render(
			<CopilotSidebarHeader config={baseConfig()} />,
		);
		// Initially interactive — toggle is present.
		expect(
			screen.getByRole("switch", {
				name: /Conversation visibility: Shared/i,
			}),
		).toBeInTheDocument();
		// Simulate Group H's post-stream callback writing the lock back
		// to parent state. The chip should re-render as the locked
		// `<span>` once the prop flips.
		rerender(
			<CopilotSidebarHeader
				config={baseConfig({
					conversationId: "conv-new",
					visibilityLockedAt: "2026-05-20T11:00:00Z",
				})}
			/>,
		);
		expect(
			screen.queryByRole("switch", {
				name: /Conversation visibility/i,
			}),
		).toBeNull();
		expect(
			screen.getByLabelText(
				/Conversation visibility: Shared \(locked\)/i,
			),
		).toBeInTheDocument();
	});
});
