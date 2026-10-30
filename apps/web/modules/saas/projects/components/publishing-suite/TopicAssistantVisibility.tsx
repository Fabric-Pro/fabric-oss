"use client";

import { useChatContext } from "@copilotkit/react-ui";
import { useEffect, useRef } from "react";

/** Tailwind `sm` — the width below which CopilotKit goes full-screen. */
const ASSISTANT_FULLSCREEN_BELOW = 640;

/** Close without unmounting the composer or the session that owns a live run. */
export function TopicAssistantVisibility({ isActive }: { isActive: boolean }) {
	const { open, setOpen } = useChatContext();
	const previousActive = useRef(isActive);
	const rememberedOpen = useRef(true);
	useEffect(() => {
		if (!isActive) {
			if (previousActive.current) {
				rememberedOpen.current = open;
			}
			setOpen(false);
		} else if (!previousActive.current) {
			setOpen(rememberedOpen.current);
		}
		previousActive.current = isActive;
	}, [isActive, open, setOpen]);
	useEffect(() => {
		if (
			window.matchMedia(
				`(max-width: ${ASSISTANT_FULLSCREEN_BELOW - 1}px)`,
			).matches
		) {
			rememberedOpen.current = false;
			setOpen(false);
		}
	}, [setOpen]);
	return null;
}
