"""
Model Configuration Resolver

Resolves model configuration for a tenant by calling the Fabric API.
Supports caching for performance optimization.
"""

import os
from typing import Optional
from datetime import datetime, timedelta
import httpx
from loguru import logger

from .tenant import TenantContext, TenantModelConfig, ModelResolutionResult


class ModelResolver:
    """
    Resolves model configuration for tenants via Fabric API.
    
    Supports caching to reduce API calls for repeated requests.
    """

    def __init__(
        self,
        fabric_api_url: Optional[str] = None,
        cache_ttl_seconds: int = 300,
    ):
        """
        Initialize the model resolver.
        
        Args:
            fabric_api_url: URL of the Fabric API (defaults to FABRIC_API_URL env var)
            cache_ttl_seconds: How long to cache resolved configurations
        """
        self.fabric_api_url = fabric_api_url or os.getenv(
            "FABRIC_API_URL", "http://localhost:3001"
        )
        self.cache_ttl_seconds = cache_ttl_seconds
        self._cache: dict[str, tuple[TenantModelConfig, datetime]] = {}

    def _get_cache_key(
        self, tenant: TenantContext, task_type: str, agent_id: Optional[str]
    ) -> str:
        """Generate a cache key for the configuration."""
        org_part = tenant.organization_id or "personal"
        agent_part = agent_id or "default"
        return f"{tenant.user_id}:{org_part}:{task_type}:{agent_part}"

    def _get_cached(self, cache_key: str) -> Optional[TenantModelConfig]:
        """Get cached configuration if still valid."""
        if cache_key in self._cache:
            config, expires_at = self._cache[cache_key]
            if datetime.now() < expires_at:
                return config
            # Expired, remove from cache
            del self._cache[cache_key]
        return None

    def _set_cached(self, cache_key: str, config: TenantModelConfig, ttl_seconds: int):
        """Cache a resolved configuration."""
        expires_at = datetime.now() + timedelta(seconds=ttl_seconds)
        self._cache[cache_key] = (config, expires_at)

    async def resolve_model_config(
        self,
        tenant: TenantContext,
        task_type: str = "TOOL_CALLING",
        agent_id: Optional[str] = None,
        api_key: Optional[str] = None,
    ) -> Optional[TenantModelConfig]:
        """
        Resolve model configuration for a tenant.
        
        Args:
            tenant: Tenant context with user/org info
            task_type: Type of task (SIMPLE, COMPLEX, REASONING, CHAT, TOOL_CALLING, etc.)
            agent_id: Optional agent ID for agent-specific configuration
            api_key: API key for authentication (if not already in tenant context)
            
        Returns:
            TenantModelConfig if resolution successful, None otherwise
        """
        # Check cache first
        cache_key = self._get_cache_key(tenant, task_type, agent_id)
        cached = self._get_cached(cache_key)
        if cached:
            logger.debug(f"Using cached model config for {cache_key}")
            return cached

        # Build request to Fabric API
        url = f"{self.fabric_api_url}/api/ai-config/resolve-for-agent"
        headers = {}
        
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        elif tenant.api_key_id:
            # Use API key from tenant context if available
            headers["X-API-Key-ID"] = tenant.api_key_id

        params = {
            "taskType": task_type,
            "userId": tenant.user_id,
        }
        if tenant.organization_id:
            params["organizationId"] = tenant.organization_id
        if agent_id:
            params["agentId"] = agent_id

        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(url, headers=headers, params=params)
                
                if response.status_code != 200:
                    logger.warning(
                        f"Model resolution failed: {response.status_code} - {response.text}"
                    )
                    return None

                data = response.json()
                result = ModelResolutionResult(**data)
                
                # Note: The API returns the model info but not the API key
                # The API key needs to be retrieved separately or passed in request
                config = TenantModelConfig(
                    provider=result.provider,
                    provider_model_id=result.provider_model_id,
                    model_string=result.model_string,
                    api_key=os.getenv("GROQ_API_KEY", ""),  # Fallback to env var
                    source=result.selection_source,
                )

                # Cache the result
                self._set_cached(cache_key, config, result.cache_ttl_seconds)
                
                return config

        except Exception as e:
            logger.error(f"Error resolving model config: {e}")
            return None

    def clear_cache(self):
        """Clear the configuration cache."""
        self._cache.clear()


# Global resolver instance
_resolver: Optional[ModelResolver] = None


def get_resolver() -> ModelResolver:
    """Get the global model resolver instance."""
    global _resolver
    if _resolver is None:
        _resolver = ModelResolver()
    return _resolver


async def resolve_model_config(
    tenant: TenantContext,
    task_type: str = "TOOL_CALLING",
    agent_id: Optional[str] = None,
    api_key: Optional[str] = None,
) -> Optional[TenantModelConfig]:
    """
    Convenience function to resolve model configuration.
    
    Uses the global resolver instance.
    """
    return await get_resolver().resolve_model_config(tenant, task_type, agent_id, api_key)

