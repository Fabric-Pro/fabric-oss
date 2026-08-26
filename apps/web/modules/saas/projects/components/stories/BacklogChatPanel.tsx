"use client";

import { CopilotKit } from "@copilotkit/react-core";
import { useCopilotErrorHandler } from "@saas/shared/components/copilot/use-copilot-error-handler";
import type { ComponentProps } from "react";
import { BacklogChat } from "./BacklogChat";

type BacklogChatPanelProps = ComponentProps<typeof BacklogChat> & {
	/** Used to scope the CopilotKit runtime URL to the active organization. */
	organizationId: string | null;
};

/**
 * Wraps the CopilotKit provider around {@link BacklogChat}. Extracted into its own
 * module so the entire CopilotKit runtime (`@copilotkit/react-core` +
 * `@copilotkit/react-ui`) can be code-split and loaded lazily on first open of the
 * AI Backlog panel, instead of shipping in the roadmap's initial bundle.
 */
export function BacklogChatPanel({
	organizationId,
	...chatProps
}: BacklogChatPanelProps) {
	const onCopilotError = useCopilotErrorHandler();

	return (
		<CopilotKit
			runtimeUrl={
				organizationId
					? `/api/copilotkit?organizationId=${organizationId}`
					: "/api/copilotkit"
			}
			agent="backlog_updater"
			showDevConsole={false}
			onError={onCopilotError}
		>
			<BacklogChat {...chatProps} />
		</CopilotKit>
	);
}
