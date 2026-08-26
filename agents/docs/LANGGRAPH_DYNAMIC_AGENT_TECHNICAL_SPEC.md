# LangGraph Dynamic Agent Technical Specification

## 1. Dynamic Agent Factory (Python)

### 1.1 Configuration Model

**File**: `agents/langchain/dynamic-agent-runtime/src/config.py`

```python
from pydantic import BaseModel, Field
from typing import List, Optional, Dict, Any

class PredictiveStateConfig(BaseModel):
    """Configuration for predictive state updates."""
    state_key: str
    tool: str
    tool_argument: str

class AgentConfig(BaseModel):
    """Agent configuration loaded from database."""
    agent_id: str
    name: str
    display_name: str
    description: Optional[str] = None
    
    # LLM Configuration
    model: str = "gpt-4o"
    temperature: float = 0.7
    max_tokens: int = 4096
    
    # Prompt Configuration
    system_prompt_key: Optional[str] = None
    system_prompt_content: Optional[str] = None  # Resolved from Prompt Library
    
    # MCP Configuration
    mcp_servers: List[str] = Field(default_factory=list)
    mcp_tools: List[Dict[str, Any]] = Field(default_factory=list)  # Resolved from MCP Registry
    
    # Additional Tools
    builtin_tools: List[str] = Field(default_factory=list)  # e.g., ["web_search", "code_analysis"]
    
    # AG-UI Configuration
    predictive_states: List[PredictiveStateConfig] = Field(default_factory=list)
    
    # Multi-tenancy
    user_id: str
    organization_id: Optional[str] = None
    
    # Graph Configuration
    recursion_limit: int = 25
    timeout: int = 30000  # milliseconds
    
    class Config:
        extra = "allow"  # Allow additional fields for extensibility
```

### 1.2 Agent State Definition

**File**: `agents/langchain/dynamic-agent-runtime/src/agent.py`

```python
from langgraph.graph import MessagesAnnotation
from typing import Annotated, Optional, List, Dict, Any
from langchain_core.messages import BaseMessage

class DynamicAgentState(MessagesAnnotation):
    """
    State schema for dynamic agents.
    Extends MessagesAnnotation with custom fields.
    """
    # Core state
    messages: Annotated[List[BaseMessage], "Chat messages"]
    
    # Agent metadata
    agent_id: str
    user_id: str
    organization_id: Optional[str] = None
    
    # Execution state
    status: str = "idle"  # idle, thinking, executing, complete, error
    error: Optional[str] = None
    retry_count: int = 0
    
    # Tool state
    available_tools: List[Dict[str, Any]] = []
    tool_results: Dict[str, Any] = {}
    
    # Custom state (extensible)
    custom_state: Dict[str, Any] = {}
```

### 1.3 Graph Generation

**File**: `agents/langchain/dynamic-agent-runtime/src/factory.py`

```python
from langgraph.graph import StateGraph, END, START
from langgraph.prebuilt import ToolNode
from langchain_openai import ChatOpenAI
from langchain_core.messages import SystemMessage
from typing import Dict, Any, List

class DynamicAgentFactory:
    """Factory for creating LangGraph agents from configuration."""
    
    def generate_graph(
        self,
        config: AgentConfig,
        system_prompt: str,
        tools: List[Any]
    ) -> StateGraph:
        """
        Generate a LangGraph workflow from configuration.
        
        Graph structure:
        START → chat_node → [tool_node] → chat_node → END
        
        The chat_node decides whether to:
        1. Call tools (route to tool_node)
        2. Return final response (route to END)
        """
        # Initialize LLM
        llm = ChatOpenAI(
            model=config.model,
            temperature=config.temperature,
            max_tokens=config.max_tokens,
            streaming=True,  # Enable streaming for AG-UI protocol
        )
        
        # Bind tools to LLM
        llm_with_tools = llm.bind_tools(tools)
        
        # Create graph
        workflow = StateGraph(DynamicAgentState)
        
        # Define chat node
        async def chat_node(state: DynamicAgentState, config: RunnableConfig):
            """Main chat node that processes messages and calls tools."""
            # Add system prompt
            messages = [
                SystemMessage(content=system_prompt),
                *state.messages
            ]
            
            # Configure predictive state updates
            if config.metadata is None:
                config.metadata = {}
            config.metadata["predict_state"] = [
                {
                    "state_key": ps.state_key,
                    "tool": ps.tool,
                    "tool_argument": ps.tool_argument
                }
                for ps in config.predictive_states
            ]
            
            # Invoke LLM
            response = await llm_with_tools.ainvoke(messages, config)
            
            # Update state
            return {
                "messages": [response],
                "status": "complete" if not response.tool_calls else "executing"
            }
        
        # Define tool node
        tool_node = ToolNode(tools)
        
        # Add nodes
        workflow.add_node("chat_node", chat_node)
        workflow.add_node("tool_node", tool_node)
        
        # Add edges
        workflow.add_edge(START, "chat_node")
        
        # Conditional edge: if tool calls, go to tool_node, else END
        def should_continue(state: DynamicAgentState):
            last_message = state.messages[-1]
            if hasattr(last_message, "tool_calls") and last_message.tool_calls:
                return "tool_node"
            return END
        
        workflow.add_conditional_edges("chat_node", should_continue)
        workflow.add_edge("tool_node", "chat_node")
        
        return workflow
```

---

## 2. MCP Integration

### 2.1 MCP Client Loader

**File**: `agents/langchain/dynamic-agent-runtime/src/mcp_integration.py`

```python
import httpx
from typing import List, Dict, Any, Optional
from langchain_core.tools import Tool

class MCPClientLoader:
    """Loads MCP tools for dynamic agents."""
    
    def __init__(self, api_base_url: str, api_key: str):
        self.api_base_url = api_base_url
        self.api_key = api_key
        self.http_client = httpx.AsyncClient(
            headers={"Authorization": f"Bearer {api_key}"}
        )
    
    async def load_mcp_tools(
        self,
        mcp_server_keys: List[str],
        user_id: str,
        organization_id: Optional[str] = None
    ) -> List[Tool]:
        """
        Load MCP tools from configured servers.
        
        Steps:
        1. Fetch MCP configurations for user/org
        2. For each server, get available tools
        3. Convert MCP tools to LangChain Tool format
        4. Return list of tools
        """
        tools = []
        
        for server_key in mcp_server_keys:
            # Fetch MCP config
            config = await self.fetch_mcp_config(server_key, user_id, organization_id)
            
            if not config or not config.get("enabled"):
                continue
            
            # Get tools from MCP server
            server_tools = await self.fetch_mcp_server_tools(config)
            
            # Convert to LangChain tools
            for tool_def in server_tools:
                tool = self.convert_mcp_tool_to_langchain(tool_def, config)
                tools.append(tool)
        
        return tools
    
    async def fetch_mcp_config(
        self,
        server_key: str,
        user_id: str,
        organization_id: Optional[str]
    ) -> Optional[Dict[str, Any]]:
        """Fetch MCP configuration from Next.js API."""
        params = {
            "serverKey": server_key,
            "userId": user_id,
        }
        if organization_id:
            params["organizationId"] = organization_id
        
        response = await self.http_client.get(
            f"{self.api_base_url}/api/mcp/config",
            params=params
        )
        
        if response.status_code == 200:
            return response.json()
        return None
```

---

## 3. Prompt Library Integration

### 3.1 Prompt Loader

**File**: `agents/langchain/dynamic-agent-runtime/src/prompt_loader.py`

```python
import httpx
from typing import Optional, Dict, Any

class PromptLoader:
    """Loads prompts from Prompt Library."""
    
    def __init__(self, api_base_url: str, api_key: str):
        self.api_base_url = api_base_url
        self.api_key = api_key
        self.http_client = httpx.AsyncClient(
            headers={"Authorization": f"Bearer {api_key}"}
        )
    
    async def load_prompt(
        self,
        prompt_key: str,
        user_id: str,
        organization_id: Optional[str] = None,
        variables: Optional[Dict[str, Any]] = None
    ) -> str:
        """
        Load and render prompt from Prompt Library.
        
        Steps:
        1. Fetch bound prompt version for agent
        2. Render template with variables
        3. Return rendered prompt
        """
        # Fetch prompt version
        response = await self.http_client.get(
            f"{self.api_base_url}/api/prompts/render",
            params={
                "key": prompt_key,
                "userId": user_id,
                "organizationId": organization_id,
                "targetType": "AGENT",
                "targetKey": prompt_key,
            },
            json={"variables": variables or {}}
        )
        
        if response.status_code == 200:
            data = response.json()
            return data.get("content", "")
        
        # Fallback to default prompt
        return self.get_default_prompt()
    
    def get_default_prompt(self) -> str:
        """Default system prompt if none configured."""
        return """You are a helpful AI assistant. 
        
You have access to various tools to help users accomplish their tasks.
Use the tools when appropriate and provide clear, helpful responses."""
```

---

## 4. Next Steps

Continue to `LANGGRAPH_DYNAMIC_AGENT_API_SPEC.md` for API endpoint specifications.

