import {
	type FabricBackgroundAdapter,
	getBackgroundAgentsProvider as getSharedBackgroundAgentsProvider,
} from "../../lib/coding-execution";

/**
 * Returns the Fabric-managed background execution adapter configured from
 * environment variables. Shared by sandbox and shuttle-execution activities.
 */
export function getBackgroundAgentsProvider(): FabricBackgroundAdapter {
	return getSharedBackgroundAgentsProvider();
}
