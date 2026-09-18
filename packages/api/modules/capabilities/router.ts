/**
 * Capability gating router (Fizzy #1930).
 *
 * Mounted at the top level rather than under `projects`, even though every v1
 * capability is project-scoped, because the call sites are not: Atlas, reports,
 * the newsletter and the scan all resolve gates, and nesting the read under one
 * consumer's namespace would make it read as that consumer's private concern.
 */

import { getCapabilityGatesProcedure } from "./procedures/get";
import {
	restoreCapabilityWarningsProcedure,
	suppressCapabilityWarningProcedure,
} from "./procedures/suppress";

export const capabilitiesRouter = {
	gates: getCapabilityGatesProcedure,
	suppressWarning: suppressCapabilityWarningProcedure,
	restoreWarnings: restoreCapabilityWarningsProcedure,
};
