/**
 * Discovery run procedures (plan Slice 4).
 * Mounted as `projects.discovery.{start,list,get,cancel,markContractComplete}`.
 */

export { cancelDiscoveryProcedure } from "./cancel-discovery";
export {
	getDiscoveryRunProcedure,
	listDiscoveryRunsProcedure,
} from "./list-discovery-runs";
export { markContractCompleteProcedure } from "./mark-contract-complete";
export { startDiscoveryProcedure } from "./start-discovery";
