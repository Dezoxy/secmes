{{- define "secmes.labels" -}}
app.kubernetes.io/name: secmes
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
