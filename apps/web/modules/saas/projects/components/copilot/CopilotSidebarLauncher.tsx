"use client";

import { useChatContext } from "@copilotkit/react-ui";
import { SparklesIcon } from "lucide-react";

/**
 * Branded launcher for the AI Assistant `<CopilotSidebar>`, passed through the
 * `Button` slot. CopilotKit instantiates that slot with no props (see
 * `@copilotkit/react-ui` `Modal.tsx` — `<Button></Button>`), so this module
 * exposes a `createCopilotSidebarLauncher(config)` factory that closes over the
 * config, mirroring the `createCopilotSidebarHeader()` pattern.
 *
 * The custom sidebar header owns *closing* (its X button), so this launcher is
 * purely the *reopen* affordance: it renders `null` while the panel is open and
 * a labelled pill while it is closed, calling the shared chat context's
 * `setOpen(true)` on click. It replaces CopilotKit's default round bubble,
 * which — while the panel is open — is hidden behind the sidebar window (the
 * reason the panel previously had no usable close/reopen control once opened).
 *
 * Design (project CLAUDE.md): design-token colours only, rounded pill,
 * `transition-colors` (never `transition-all`), a visible focus ring, and an
 * accessible name from the visible label. No glassmorphism, gradient, or
 * hardcoded hex.
 */

export interface CopilotSidebarLauncherConfig {
	/** Visible label and accessible name. Defaults to "AI Assistant". */
	label?: string;
}

export function CopilotSidebarLauncher({
	label = "AI Assistant",
}: CopilotSidebarLauncherConfig) {
	const { open, setOpen } = useChatContext();

	// While the panel is open the header's X button is the close control, so a
	// floating launcher would be redundant — render nothing.
	if (open) {
		return null;
	}

	return (
		<button
			type="button"
			onClick={() => setOpen(true)}
			className="fixed bottom-4 right-4 z-30 inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground shadow-sm transition-colors duration-150 hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
		>
			<SparklesIcon className="size-4" aria-hidden="true" />
			<span>{label}</span>
		</button>
	);
}

/**
 * Factory that wraps `<CopilotSidebarLauncher>` so it can be passed to
 * `<CopilotSidebar Button={...}>`. CopilotKit instantiates the `Button`
 * component with no props, so the closure captures the config.
 */
export function createCopilotSidebarLauncher(
	config: CopilotSidebarLauncherConfig = {},
) {
	function CopilotSidebarLauncherSlot() {
		return <CopilotSidebarLauncher label={config.label} />;
	}
	return CopilotSidebarLauncherSlot;
}
