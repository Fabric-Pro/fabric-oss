{{- define "fabric.deployment" }}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .name }}
  labels:
{{- include "fabric.labels" (dict "name" .name "Release" .Release "component" (.component | default "platform")) | nindent 4 }}
spec:
  replicas: {{ .replicas | default 1 }}
  selector:
    matchLabels:
{{- include "fabric.selectorLabels" (dict "name" .name "Release" .Release) | nindent 6 }}
  template:
    metadata:
      annotations:
        # Roll pods when chart values change so ConfigMap-sourced env (e.g.
        # NEXT_PUBLIC_SITE_URL via envFrom) actually propagates — editing a
        # ConfigMap does not change a Deployment's pod spec, so without this the
        # running pods keep the stale env until manually restarted.
        checksum/config: {{ .Values | toYaml | sha256sum }}
      labels:
{{- include "fabric.selectorLabels" (dict "name" .name "Release" .Release) | nindent 8 }}
        app.kubernetes.io/component: {{ .component | default "platform" }}
    spec:
      serviceAccountName: {{ include "fabric.serviceAccountName" (dict "Values" .Values) }}
{{- if .securityContext }}
      securityContext:
{{- toYaml .securityContext | nindent 8 }}
{{- end }}
      containers:
        - name: {{ .name }}
          image: {{ .image | quote }}
          imagePullPolicy: IfNotPresent
          # Baseline container hardening — applies to EVERY service regardless of
          # whether a pod-level securityContext is passed. runAsNonRoot is asserted
          # per-service via the pod-level securityContext (all Fabric images now run
          # as a known non-root numeric uid 1001: web, the 12 agents, temporal-worker,
          # and mcp-stdio-wrapper). It is not forced at this container baseline so the
          # macro stays usable by any future service before its image is made
          # non-root. The only remaining root-capable pods are the THIRD-PARTY
          # dependencies (qdrant, otel-collector, fluent-bit), which carry their own
          # upstream security posture and are out of scope for Fabric image hardening.
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
{{- if .port }}
          ports:
            - name: http
              containerPort: {{ .port }}
              protocol: TCP
{{- end }}
          envFrom:
            - configMapRef:
                name: {{ .Release.Name }}-config
            - secretRef:
                name: fabric-app-secrets
          env:
            - name: NODE_IP
              valueFrom:
                fieldRef:
                  fieldPath: status.hostIP
            - name: OTEL_EXPORTER_OTLP_ENDPOINT
              value: "http://$(NODE_IP):4317"
{{- if .extraEnv }}
{{- toYaml .extraEnv | nindent 12 }}
{{- end }}
{{- if .probes }}
{{- toYaml .probes | nindent 10 }}
{{- end }}
{{- if .resources }}
          resources:
{{- toYaml .resources | nindent 12 }}
{{- end }}
{{- end }}
