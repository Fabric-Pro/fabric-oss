export interface Env {
	PARTYKIT_ENV?: string;
	FABRIC_API_URL?: string;
	AGENT_SERVICE_SECRET?: string;
	// Workers AI: Parlume transcribes meeting audio with Deepgram Flux.
	AI: Ai;
	Main: DurableObjectNamespace;
	Orchestrator: DurableObjectNamespace;
	TaskAgent: DurableObjectNamespace;
	Health: DurableObjectNamespace;
	Parlume: DurableObjectNamespace;
}
