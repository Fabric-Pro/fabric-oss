# Fabric Agent Python Library

Multi-tenant runtime utilities for Fabric Python agents (CUGA and others).

## Features

- **Multi-tenant Model Configuration**: Resolve model configuration based on user/organization preferences
- **Automatic Caching**: Cache resolved configurations to reduce API calls
- **LangChain Integration**: Create LangChain models from resolved configurations
- **Fallback Support**: Graceful fallback to default models when tenant config unavailable

## Installation

```bash
# Using pip
pip install -e packages/fabric-agent-python

# Using uv
uv pip install -e packages/fabric-agent-python
```

## Usage

### Basic Usage

```python
from fabric_agent import TenantContext, get_agent_model

# Create tenant context from request
tenant = TenantContext(
    user_id="user_123",
    organization_id="org_456",  # Optional
)

# Get a model configured for this tenant
model = await get_agent_model(
    tenant=tenant,
    task_type="TOOL_CALLING",
    temperature=0.3,
)

# Use the model
result = await model.ainvoke([...])
```

### With Pre-resolved Configuration

```python
from fabric_agent import TenantModelConfig, create_model_from_config

# If you already have the configuration
config = TenantModelConfig(
    provider="GROQ_DIRECT",
    provider_model_id="llama-3.3-70b-versatile",
    model_string="groq/llama-3.3-70b-versatile",
    api_key="your-api-key",
    source="user_preference",
)

model = create_model_from_config(config, temperature=0.3)
```

### In CUGA Agent

```python
# In your CUGA backend code
from fabric_agent import TenantContext, get_agent_model

async def get_model_for_request(request):
    # Extract tenant info from request headers or params
    tenant = TenantContext(
        user_id=request.headers.get("X-User-ID"),
        organization_id=request.headers.get("X-Organization-ID"),
    )
    
    return await get_agent_model(
        tenant=tenant,
        task_type="TOOL_CALLING",
    )
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `FABRIC_API_URL` | URL of the Fabric API | `http://localhost:3001` |
| `GROQ_API_KEY` | Default Groq API key (fallback) | Required |
| `DEFAULT_MODEL_ID` | Default model ID | `llama-3.3-70b-versatile` |

## API Reference

### TenantContext

Tenant context passed to agents with every request.

```python
class TenantContext:
    user_id: str          # User ID making the request
    organization_id: str  # Organization ID (optional)
    api_key_id: str       # API key used to authenticate (optional)
    scopes: list[str]     # Scopes granted to the API key
```

### TenantModelConfig

Model configuration resolved for a specific tenant.

```python
class TenantModelConfig:
    provider: str           # Provider name
    provider_model_id: str  # Provider-specific model ID
    model_string: str       # Full model string for AI SDK
    api_key: str           # Decrypted API key
    temperature: float     # Optional temperature override
    max_tokens: int        # Optional max tokens override
    source: str            # Configuration source
    gateway_base_url: str  # Gateway URL (optional)
```

### Functions

- `get_agent_model(tenant, task_type, ...)` - Get a model for agent execution
- `create_model_from_config(config, ...)` - Create model from pre-resolved config
- `resolve_model_config(tenant, task_type, ...)` - Resolve config from Fabric API

