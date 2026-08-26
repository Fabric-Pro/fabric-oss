{{- define "fabric.envFrom" -}}
envFrom:
  - configMapRef:
      name: {{ .Release.Name }}-config
  - secretRef:
      name: fabric-app-secrets
{{- end -}}
