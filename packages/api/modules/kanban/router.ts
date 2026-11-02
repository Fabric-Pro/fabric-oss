import {
	createKanbanTokenProcedure,
	exchangeKanbanTokenProcedure,
} from "./procedures/create-token";
import { getKanbanConnectionStatus, healthCheck } from "./procedures/status";
import { getSyncStatus, pullFromKanban, pushToKanban } from "./procedures/sync";

export const kanbanRouter = {
	token: createKanbanTokenProcedure,
	exchangeToken: exchangeKanbanTokenProcedure,
	sync: {
		push: pushToKanban,
		pull: pullFromKanban,
		status: getSyncStatus,
	},
	status: {
		get: getKanbanConnectionStatus,
		health: healthCheck,
	},
};
