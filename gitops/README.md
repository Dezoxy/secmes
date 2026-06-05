# GitOps (Argo CD)

`apps/secmes.yaml` is the Argo CD `Application` that deploys `charts/secmes`.

After Argo CD is installed (see `../infra/bootstrap/`) and you've pushed this repo:

```bash
# point the Application at your repo first (edit repoURL in apps/secmes.yaml)
kubectl apply -f apps/secmes.yaml
```

Argo CD then continuously reconciles the cluster to match `charts/secmes` on `main`.
CD updates the image tag in `charts/secmes/values.yaml`; Argo syncs the rollout.

> Phase 1+: convert this to an **app-of-apps** (one root Application referencing
> per-component Applications) as more workloads are added.
