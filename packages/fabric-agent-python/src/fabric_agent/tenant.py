"""
Tenant Context Types

Multi-tenant context types for Python agents. These types define the
tenant context that agents receive with each request, enabling
per-tenant model configuration and isolation.
"""

from typing import Optional
from pydantic import BaseModel, Field


class TenantContext(BaseModel):
    """Tenant context passed to agents with every request."""

    user_id: str = Field(..., description="User ID making the request")
    organization_id: Optional[str] = Field(
        None, description="Organization ID (None for personal context)"
    )
    api_key_id: Optional[str] = Field(
        None, description="API key used to authenticate (for logging/auditing)"
    )
    scopes: list[str] = Field(
        default_factory=list, description="Scopes granted to the API key"
    )

    def has_scope(self, scope: str) -> bool:
        """Check if tenant has a specific scope."""
        return scope in self.scopes or "*" in self.scopes

    def has_any_scope(self, scopes: list[str]) -> bool:
        """Check if tenant has any of the specified scopes."""
        return any(self.has_scope(s) for s in scopes)


class TenantModelConfig(BaseModel):
    """Model configuration resolved for a specific tenant."""

    provider: str = Field(..., description="Provider name (e.g., 'GROQ_DIRECT', 'VERCEL_GATEWAY')")
    provider_model_id: str = Field(
        ..., description="Provider-specific model ID (e.g., 'llama-3.3-70b-versatile')"
    )
    model_string: str = Field(
        ..., description="Full model string for AI SDK (e.g., 'groq/llama-3.3-70b-versatile')"
    )
    api_key: str = Field(..., description="Decrypted API key for the provider")
    temperature: Optional[float] = Field(None, description="Optional temperature override")
    max_tokens: Optional[int] = Field(None, description="Optional max tokens override")
    source: str = Field(
        ...,
        description="Source of the configuration for auditing",
        pattern="^(user_preference|org_preference|org_enforced|system_default)$",
    )
    gateway_base_url: Optional[str] = Field(None, description="Gateway base URL (if using a gateway)")


class ModelResolutionInput(BaseModel):
    """Input for agent model resolution."""

    api_key: str = Field(..., description="API key for authentication")
    task_type: str = Field(
        ...,
        description="Task type for model selection",
        pattern="^(SIMPLE|COMPLEX|REASONING|CHAT|TOOL_CALLING|EMBEDDING|IMAGE|AUDIO)$",
    )
    agent_id: Optional[str] = Field(None, description="Optional agent ID for agent-specific overrides")


class ModelResolutionResult(BaseModel):
    """Result from model resolution."""

    provider: str = Field(..., description="Provider identifier")
    provider_model_id: str = Field(..., description="Provider-specific model ID")
    model_string: str = Field(..., description="Full model string for AI SDK")
    user_id: str = Field(..., description="User ID from API key")
    organization_id: Optional[str] = Field(None, description="Organization ID from API key (if org key)")
    selection_source: str = Field(..., description="How the model was selected")
    cache_ttl_seconds: int = Field(300, description="Cache TTL hint in seconds")

