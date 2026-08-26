{{- define "fabric.service" }}
apiVersion: v1
kind: Service
metadata:
  name: {{ .name }}
  labels:
{{- include "fabric.labels" (dict "name" .name "Release" .Release "component" (.component | default "platform")) | nindent 4 }}
spec:
  type: ClusterIP
  selector:
{{- include "fabric.selectorLabels" (dict "name" .name "Release" .Release) | nindent 4 }}
  ports:
    - name: http
      port: {{ .port }}
      targetPort: {{ .port }}
      protocol: TCP
{{- end }}
