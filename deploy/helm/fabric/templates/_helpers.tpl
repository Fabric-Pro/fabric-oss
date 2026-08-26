{{/*
Common labels applied to every Fabric resource.
Usage: `{{- include "fabric.labels" (dict "name" "web" "Release" .Release) | nindent 4 }}`
*/}}
{{- define "fabric.labels" -}}
app.kubernetes.io/name: {{ .name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: fabric
{{- if .component }}
app.kubernetes.io/component: {{ .component }}
{{- end }}
{{- end -}}

{{/*
Selector labels (subset of fabric.labels — only the stable identifying ones).
A Deployment's selector MUST match the labels in its pod template; these labels
are immutable so we exclude managed-by/part-of which can change between Helm
revisions and would invalidate the selector.
Usage: `{{- include "fabric.selectorLabels" (dict "name" "web" "Release" .Release) | nindent 6 }}`
*/}}
{{- define "fabric.selectorLabels" -}}
app.kubernetes.io/name: {{ .name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
Fully qualified image reference: registry/repo:tag.
Usage: `{{ include "fabric.image" (dict "repo" "fabric-web" "Values" .Values) }}`
*/}}
{{- define "fabric.image" -}}
{{- printf "%s/%s:%s" .Values.global.imageRegistry .repo .Values.global.imageTag -}}
{{- end -}}

{{/*
ServiceAccount name to use on every pod. Falls back to "default" if creation is disabled.
*/}}
{{- define "fabric.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{ .Values.serviceAccount.name }}
{{- else -}}
default
{{- end -}}
{{- end -}}
