import { analyzeProcedure } from "./procedures/analyze";
import {
	listBranchesProcedure,
	setPinnedBranchesProcedure,
} from "./procedures/branches";
import { cancelAnalysisProcedure } from "./procedures/cancel";
import { atlasChatProcedure } from "./procedures/chat";
import {
	createConversationProcedure,
	deleteConversationProcedure,
	getConversationProcedure,
	listConversationsProcedure,
	updateConversationProcedure,
} from "./procedures/conversations";
import { createEdgeProcedure } from "./procedures/create-edge";
import { deleteEdgeProcedure } from "./procedures/delete-edge";
import { describeNodeProcedure } from "./procedures/describe-node";
import { edgeHistoryProcedure } from "./procedures/edge-history";
import { atlasGraphProcedure } from "./procedures/graph";
import { atlasHistoryProcedure } from "./procedures/history";
import { linkRepositoriesProcedure } from "./procedures/link-repositories";
import { listRepositoriesProcedure } from "./procedures/list-repositories";
import { atlasNodeProcedure } from "./procedures/node";
import { nodeHistoryProcedure } from "./procedures/node-history";
import { remapSoloProcedure } from "./procedures/remap-solo";
import { remapSystemProcedure } from "./procedures/remap-system";
import { restoreEdgeProcedure } from "./procedures/restore-edge";
import { saveLayoutProcedure } from "./procedures/save-layout";
import { atlasStatusProcedure } from "./procedures/status";
import { systemChatProcedure } from "./procedures/system-chat";
import { systemGraphProcedure } from "./procedures/system-graph";
import { saveSystemLayoutProcedure } from "./procedures/system-layout";
import { systemRemapHistoryProcedure } from "./procedures/system-remap-history";
import { updateEdgeProcedure } from "./procedures/update-edge";
import { updateNodeProcedure } from "./procedures/update-node";

/**
 * Atlas router — every procedure is a thin delegate to
 * `AtlasService` (the facade).
 */
export const atlasRouter = {
	listRepositories: listRepositoriesProcedure,
	status: atlasStatusProcedure,
	graph: atlasGraphProcedure,
	node: atlasNodeProcedure,
	describeNode: describeNodeProcedure,
	updateNode: updateNodeProcedure,
	nodeHistory: nodeHistoryProcedure,
	// Editable / manual / soft-deletable connections (solo + System map).
	updateEdge: updateEdgeProcedure,
	createEdge: createEdgeProcedure,
	deleteEdge: deleteEdgeProcedure,
	restoreEdge: restoreEdgeProcedure,
	edgeHistory: edgeHistoryProcedure,
	analyze: analyzeProcedure,
	cancelAnalysis: cancelAnalysisProcedure,
	history: atlasHistoryProcedure,
	saveLayout: saveLayoutProcedure,
	branches: {
		list: listBranchesProcedure,
		setPinned: setPinnedBranchesProcedure,
	},
	chat: atlasChatProcedure,
	conversations: {
		list: listConversationsProcedure,
		create: createConversationProcedure,
		get: getConversationProcedure,
		update: updateConversationProcedure,
		delete: deleteConversationProcedure,
	},
	// Multi-repo "System map"
	systemGraph: systemGraphProcedure,
	linkRepositories: linkRepositoriesProcedure,
	systemChat: systemChatProcedure,
	saveSystemLayout: saveSystemLayoutProcedure,
	// Re-map relationships (force a recompute / regenerate AI references).
	remapSystem: remapSystemProcedure,
	remapSolo: remapSoloProcedure,
	systemRemapHistory: systemRemapHistoryProcedure,
};
