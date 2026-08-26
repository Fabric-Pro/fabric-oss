/**
 * OpenAPI Tools Router
 *
 * Combines all OpenAPI-related procedures.
 */

import { servicesProcedures } from "./procedures/services";
import { toolsProcedures } from "./procedures/tools";

export const openapiRouter = {
	services: servicesProcedures,
	tools: toolsProcedures,
};
