export interface Env {
	PARTYKIT_ENV?: string;
	FABRIC_API_URL?: string;
	AGENT_SERVICE_SECRET?: string;
	Main: DurableObjectNamespace;
	Orchestrator: DurableObjectNamespace;
	TaskAgent: DurableObjectNamespace;
	Health: DurableObjectNamespace;
}
