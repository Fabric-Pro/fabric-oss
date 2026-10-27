import type { FabricServiceActor } from "../../../lib/fabric-mcp-service-headers";
import { openFabricGateway } from "../../shared/fabric-gateway-client";

/** Read the schemas this turn's gateway offers; an unavailable gateway offers none. */
export async function preloadFrameToolsActivity(actor: FabricServiceActor) {
	const gateway = openFabricGateway(actor);
	if (!gateway) {
		return [];
	}
	try {
		const listed = await gateway.listTools();
		return (listed ?? [])
			.filter(
				({ name }) =>
					name === "fabric_get_frame" ||
					name === "fabric_edit_frame_block",
			)
			.map(({ name, description, inputSchema }) => ({
				name,
				description,
				inputSchema,
			}));
	} finally {
		await gateway.close();
	}
}
