/**
 * Typed proxy over `orpcClient.projects.slackHuddleIngest.*`.
 *
 * IMPORTANT (per repo memory — the triggerNow/triggerMonitor mismatch bug): the
 * client method names here MUST match the router keys EXACTLY
 * (`enable` / `disable` / `triggerNow`). We deliberately reference the real
 * `orpcClient.projects.slackHuddleIngest` namespace directly rather than casting
 * through a hand-rolled shape with `as unknown as`, so a method-name drift fails
 * the type-check instead of failing silently at runtime.
 */

import { orpcClient } from "@shared/lib/orpc-client";

export function getSlackHuddleIngestClient() {
	return orpcClient.projects.slackHuddleIngest;
}
