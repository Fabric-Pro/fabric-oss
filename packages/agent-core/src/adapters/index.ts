/**
 * Agent adapters
 *
 * Framework-specific adapter implementations
 */

export {
	AGUINativeAgentAdapter,
	type AGUINativeAgentConfig,
} from "./agui-native-adapter";
export {
	LangGraphAgentAdapter,
	type LangGraphAgentConfig,
} from "./langgraph-adapter";
export {
	MicrosoftAgentAdapter,
	type MicrosoftAgentAdapterConfig,
} from "./microsoft-agent-adapter";
export {
	PydanticAIAdapter,
	type PydanticAIAdapterConfig,
} from "./pydantic-ai-adapter";

// Future adapters will be exported here:
// export { CrewAIAgentAdapter } from "./crewai-agent-adapter";
