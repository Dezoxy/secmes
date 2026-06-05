# GitOps (Argo CD)

`apps/argus.yaml` is the Argo CD `Application` that deploys `charts/argus`.

After Argo CD is installed (see `../infra/bootstrap/`) and you've pushed this repo:

```bash
# point the Application at your repo first (edit repoURL in apps/argus.yaml)
kubectl apply -f apps/argus.yaml
```

Argo CD then continuously reconciles the cluster to match `charts/argus` on `main`.
CD updates the image tag in `charts/argus/values.yaml`; Argo syncs the rollout.

> Phase 1+: convert this to an **app-of-apps** (one root Application referencing
> per-component Applications) as more workloads are added.
