{{- define "argus.labels" -}}
app.kubernetes.io/name: argus
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
