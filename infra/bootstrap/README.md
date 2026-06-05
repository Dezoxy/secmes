# Cluster bootstrap (one-time, after `terraform apply`)

Installs the platform add-ons that the app depends on. Run after fetching kubeconfig:

```bash
az aks get-credentials --resource-group argus-rg --name argus-aks
```

Then either run `./install.sh` or the steps below.

## 1. ingress-nginx
```bash
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace platform --create-namespace
```

## 2. cert-manager (+ Let's Encrypt issuer)
```bash
helm repo add jetstack https://charts.jetstack.io
helm upgrade --install cert-manager jetstack/cert-manager \
  --namespace platform --set crds.enabled=true
# then apply a ClusterIssuer named letsencrypt-prod (see clusterissuer.yaml)
kubectl apply -f clusterissuer.yaml
```

## 3. Argo CD
```bash
helm repo add argo https://argoproj.github.io/argo-helm
helm upgrade --install argocd argo/argo-cd \
  --namespace argocd --create-namespace
kubectl apply -f ../../gitops/apps/argus.yaml
```

> Phase 1+: replace manual helm installs with the **AKS GitOps (Flux) extension**
> or have Argo CD manage these add-ons too (app-of-apps). Add Secrets Store CSI +
> Key Vault and Entra Workload ID federation here.
