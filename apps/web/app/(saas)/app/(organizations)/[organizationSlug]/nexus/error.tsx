"use client";

import { NexusError } from "@saas/ai/components/NexusError";

export default function NexusRouteError({
	error,
	reset,
}: {
	error: Error & { digest?: string };
	reset: () => void;
}) {
	return <NexusError error={error} reset={reset} />;
}
