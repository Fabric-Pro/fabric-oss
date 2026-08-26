# =============================================================================
# OpenTelemetry Collector Docker Image for Fabric
# =============================================================================
# Custom image with configuration baked in
# Build: docker build -t fabric/otel-collector:latest .
# =============================================================================

FROM otel/opentelemetry-collector-contrib:0.96.0

# Copy the configuration file
COPY otel-collector-config.yaml /etc/otelcol/config.yaml

# Matches the upstream image's own default (`USER 10001`), so this changes no
# behaviour — it states the non-root posture in our Dockerfile instead of
# inheriting it invisibly, which is what a scanner (and a reader) can check.
USER 10001

# Set the config file path
CMD ["--config=/etc/otelcol/config.yaml"]
