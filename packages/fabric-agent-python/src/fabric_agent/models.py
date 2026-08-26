"""
Model Factory

Creates LangChain model instances using tenant-specific configuration.
"""

import os
from typing import Optional, Union

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_groq import ChatGroq
from langchain_openai import ChatOpenAI
from loguru import logger

from .tenant import TenantContext, TenantModelConfig
from .resolver import resolve_model_config


def create_model_from_config(
    config: TenantModelConfig,
    temperature: Optional[float] = None,
    max_tokens: Optional[int] = None,
) -> BaseChatModel:
    """
    Create a LangChain model from a tenant configuration.
    
    Args:
        config: Tenant model configuration
        temperature: Optional temperature override
        max_tokens: Optional max tokens override
        
    Returns:
        ChatGroq or ChatOpenAI instance
    """
    temp = temperature if temperature is not None else (config.temperature or 0.3)
    tokens = max_tokens if max_tokens is not None else (config.max_tokens or 4000)
    
    provider = config.provider.upper()
    
    # For Groq-based providers
    if "GROQ" in provider:
        return ChatGroq(
            model=config.provider_model_id,
            api_key=config.api_key,
            temperature=temp,
            max_tokens=tokens,
        )
    
    # For OpenAI-based providers (including gateway)
    if "OPENAI" in provider or "GATEWAY" in provider or "AZURE" in provider:
        kwargs = {
            "model": config.provider_model_id,
            "api_key": config.api_key,
            "temperature": temp,
            "max_tokens": tokens,
        }
        
        if config.gateway_base_url:
            kwargs["base_url"] = config.gateway_base_url
            
        return ChatOpenAI(**kwargs)
    
    # Default to Groq for unknown providers
    logger.warning(f"Unknown provider {provider}, defaulting to Groq")
    return ChatGroq(
        model=config.provider_model_id,
        api_key=config.api_key,
        temperature=temp,
        max_tokens=tokens,
    )


def create_default_model(
    temperature: float = 0.3,
    max_tokens: int = 4000,
) -> BaseChatModel:
    """
    Create a default model using environment variables.
    
    Falls back to Groq with llama-3.3-70b-versatile.
    """
    api_key = os.getenv("GROQ_API_KEY")
    model_id = os.getenv("DEFAULT_MODEL_ID", "llama-3.3-70b-versatile")
    
    if not api_key:
        raise ValueError("GROQ_API_KEY environment variable is required for default model")
    
    return ChatGroq(
        model=model_id,
        api_key=api_key,
        temperature=temperature,
        max_tokens=max_tokens,
    )


async def get_agent_model(
    tenant: Optional[TenantContext] = None,
    pre_resolved_config: Optional[TenantModelConfig] = None,
    task_type: str = "TOOL_CALLING",
    temperature: float = 0.3,
    max_tokens: int = 4000,
    api_key: Optional[str] = None,
) -> BaseChatModel:
    """
    Get a model for agent execution.
    
    This is the primary entry point for getting a model in Python agents.
    It tries tenant-based configuration first, then falls back to default.
    
    Args:
        tenant: Optional tenant context
        pre_resolved_config: Optional pre-resolved model config
        task_type: Task type for model selection
        temperature: Temperature for LLM responses
        max_tokens: Max tokens for response
        api_key: Optional API key for authentication
        
    Returns:
        BaseChatModel instance
    """
    # If config is pre-resolved, use it directly
    if pre_resolved_config:
        return create_model_from_config(
            pre_resolved_config,
            temperature=temperature,
            max_tokens=max_tokens,
        )
    
    # If tenant context is provided, try to resolve config
    if tenant:
        try:
            config = await resolve_model_config(
                tenant,
                task_type=task_type,
                api_key=api_key,
            )
            if config:
                return create_model_from_config(
                    config,
                    temperature=temperature,
                    max_tokens=max_tokens,
                )
        except Exception as e:
            logger.warning(f"Failed to resolve tenant model config: {e}")
    
    # Fall back to default model
    logger.info("Using default model (no tenant config available)")
    return create_default_model(temperature=temperature, max_tokens=max_tokens)

