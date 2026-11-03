import { runtimeCustomEventName } from "./runtime-custom-events";

export const DATA_ANALYST_AGENT_ID = "data-analyst";
export const DATA_ANALYST_REGISTRY_AGENT_ID = "data_analyst";
export const DATA_ANALYST_EVENT = {
	chart: runtimeCustomEventName(DATA_ANALYST_AGENT_ID, "chart"),
	model: runtimeCustomEventName(DATA_ANALYST_AGENT_ID, "model"),
} as const;
