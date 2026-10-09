#!/bin/bash
#########################################################################################################
# End-to-end test for a cluster built by the Kloudust Kubernetes automation.
# Run it from your own machine (needs kubectl, curl, openssl; nc is optional).
#
# Usage: ./k8s_cluster_test.sh <pool IP> <admin user> [expected worker count] [kubeconfig path]
#   e.g. ./k8s_cluster_test.sh 148.251.144.126 tekmonks 2
# If no kubeconfig path is given, it is downloaded with scp from <admin>@<pool IP>:kubeconfig.yaml
# Everything it creates lives in namespace kd-k8s-test, which is deleted at the end.
#########################################################################################################

POOL_IP=$1; ADMIN=$2; WORKERS=${3:-}; KUBECONFIG_PATH=${4:-}
if [ -z "$POOL_IP" ] || [ -z "$ADMIN" ]; then echo "Usage: $0 <pool IP> <admin user> [expected workers] [kubeconfig]"; exit 2; fi
for tool in kubectl curl openssl; do command -v $tool >/dev/null || { echo "Missing $tool"; exit 2; }; done

NS=kd-k8s-test; LB_PORT=18080; PASSED=0; FAILED=0
pass() { echo "  PASS  $1"; PASSED=$((PASSED+1)); }
fail() { echo "  FAIL  $1"; FAILED=$((FAILED+1)); }
check() { if [ "$2" = "0" ]; then pass "$1"; else fail "$1"; fi; }
k() { kubectl --kubeconfig "$KUBECONFIG_PATH" "$@"; }
run_pod() {     # name, overrides JSON or "", script: run a busybox pod to completion and print its logs once
    local extra=(); [ -n "$2" ] && extra=(--overrides="$2")
    k run "$1" -n $NS --image=busybox:1.36 --restart=Never "${extra[@]}" --command -- sh -c "$3" >/dev/null 2>&1
    k wait pod/"$1" -n $NS --for=jsonpath='{.status.phase}'=Succeeded --timeout=180s >/dev/null 2>&1
    k logs "$1" -n $NS 2>/dev/null
}
cleanup() { [ -n "$KUBECONFIG_PATH" ] && k delete namespace $NS --ignore-not-found --wait=false >/dev/null 2>&1; }
trap cleanup EXIT

echo "1. API endpoint https://$POOL_IP:6443"
CODE=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 https://$POOL_IP:6443/version)
[ "$CODE" = "200" ] || [ "$CODE" = "401" ]; check "API answers (HTTP $CODE)" $?
SAN=$(openssl s_client -connect $POOL_IP:6443 </dev/null 2>/dev/null | openssl x509 -noout -ext subjectAltName 2>/dev/null)
echo "$SAN" | grep -q "IP Address:$POOL_IP"; check "API certificate is valid for $POOL_IP (tls-san)" $?

echo "2. Kubeconfig"
if [ -z "$KUBECONFIG_PATH" ]; then
    KUBECONFIG_PATH=$(mktemp); scp -q -o StrictHostKeyChecking=accept-new $ADMIN@$POOL_IP:kubeconfig.yaml "$KUBECONFIG_PATH"
    check "downloaded kubeconfig from $ADMIN@$POOL_IP" $?
fi
grep -q "server: https://$POOL_IP:6443" "$KUBECONFIG_PATH"; check "kubeconfig points at https://$POOL_IP:6443" $?
k get --raw /version >/dev/null 2>&1; check "kubectl authenticates with the kubeconfig (no TLS errors)" $?

echo "3. Nodes"
NODES=$(k get nodes --no-headers 2>/dev/null)
TOTAL=$(echo "$NODES" | grep -c .); READY=$(echo "$NODES" | awk '$2=="Ready"' | grep -c .)
echo "$NODES" | sed 's/^/        /'
[ "$TOTAL" -gt 0 ] && [ "$READY" = "$TOTAL" ]; check "all $TOTAL nodes Ready" $?
if [ -n "$WORKERS" ]; then [ "$TOTAL" = "$((WORKERS+1))" ]; check "node count is 1 master + $WORKERS workers" $?; fi
BAD_IPS=$(k get nodes -o jsonpath='{range .items[*]}{.status.addresses[?(@.type=="InternalIP")].address}{"\n"}{end}' | grep -vc '^10\.100\.0\.')
[ "$BAD_IPS" = "0" ]; check "every node's internal IP is on the cluster network 10.100.0.x" $?
k get nodes -o jsonpath='{range .items[*]}{.status.addresses[?(@.type=="ExternalIP")].address}{"\n"}{end}' | grep -qx "$POOL_IP"
check "master's external IP is $POOL_IP (node-external-ip)" $?

echo "4. Workload on every node"
SCHEDULABLE=$(k get nodes -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.spec.taints[*].effect}{"\n"}{end}' | grep -vc NoSchedule)
k create namespace $NS >/dev/null
cat <<EOF | k apply -n $NS -f - >/dev/null
apiVersion: apps/v1
kind: Deployment
metadata: {name: hello-web}
spec:
  replicas: $SCHEDULABLE
  selector: {matchLabels: {app: hello-web}}
  template:
    metadata: {labels: {app: hello-web}}
    spec:
      topologySpreadConstraints:
      - {maxSkew: 1, topologyKey: kubernetes.io/hostname, whenUnsatisfiable: DoNotSchedule, labelSelector: {matchLabels: {app: hello-web}}}
      containers:
      - {name: hello, image: nginxdemos/hello, ports: [{containerPort: 80}]}
EOF
k rollout status deployment/hello-web -n $NS --timeout=300s >/dev/null 2>&1
check "deployment with $SCHEDULABLE replicas is running (images pulled from the internet)" $?
POD_NODES=$(k get pods -n $NS -l app=hello-web -o jsonpath='{range .items[*]}{.spec.nodeName}{"\n"}{end}' | sort -u | grep -c .)
[ "$POD_NODES" = "$SCHEDULABLE" ]; check "one pod on each of the $SCHEDULABLE schedulable nodes" $?

echo "5. Networking inside the cluster"
POD_IPS=$(k get pods -n $NS -l app=hello-web -o jsonpath='{.items[*].status.podIP}')
NET_OUT=$(run_pod nettest "" "
    for ip in $POD_IPS; do wget -qO- -T 5 http://\$ip >/dev/null && echo POD_OK \$ip || echo POD_FAIL \$ip; done
    nslookup kubernetes.default.svc.cluster.local >/dev/null 2>&1 && echo DNS_OK || echo DNS_FAIL
    wget -qO- -T 5 http://example.com >/dev/null 2>&1 && echo NET_OK || echo NET_FAIL
    echo MTU \$(cat /sys/class/net/eth0/mtu)")
NIC_MTU=$(run_pod nicmtu '{"spec":{"hostNetwork":true}}' \
    'IF=$(ip -o -4 addr show | awk "/ 10\.100\.0\./ {print \$2}" | head -1); cat /sys/class/net/$IF/mtu')
POD_FAILS=$(echo "$NET_OUT" | grep -c POD_FAIL); POD_OKS=$(echo "$NET_OUT" | grep -c POD_OK)
[ "$POD_OKS" = "$SCHEDULABLE" ] && [ "$POD_FAILS" = "0" ]; check "a pod reaches the pods on every node ($POD_OKS ok, $POD_FAILS failed)" $?
echo "$NET_OUT" | grep -q DNS_OK; check "cluster DNS resolves kubernetes.default" $?
echo "$NET_OUT" | grep -q NET_OK; check "pods reach the internet" $?
MTU=$(echo "$NET_OUT" | awk '/^MTU/ {print $2}')
[ -n "$MTU" ] && [ -n "$NIC_MTU" ] && [ "$MTU" = "$((NIC_MTU-50))" ]
check "pod MTU ${MTU:-none} = cluster NIC MTU ${NIC_MTU:-none} minus 50 for flannel's VXLAN" $?

echo "6. LoadBalancer on the pool IP (port $LB_PORT)"
k expose deployment hello-web -n $NS --type=LoadBalancer --port=$LB_PORT --target-port=80 >/dev/null
for i in $(seq 90); do LB=$(k get svc hello-web -n $NS --no-headers 2>/dev/null | awk '{print $4}'); echo "$LB" | grep -qw "$POOL_IP" && break; sleep 2; done
echo "$LB" | grep -qw "$POOL_IP"; LB_OK=$?; check "service EXTERNAL-IP includes $POOL_IP (got ${LB:-none})" $LB_OK
[ "$LB_OK" = "0" ] || { echo "        Other LoadBalancer services on port $LB_PORT (k3s allows one per port):"
    k get svc -A --no-headers | awk -v ns=$NS -v p="^$LB_PORT:" '$1!=ns && $3=="LoadBalancer" && $6 ~ p' | sed 's/^/          /'; }
SEEN=""; TIMEOUTS=0
REQUESTS=$((SCHEDULABLE*15))
for i in $(seq $REQUESTS); do
    NAME=$(curl -s --max-time 3 http://$POOL_IP:$LB_PORT | grep -io 'hello-web-[a-z0-9-]*' | head -1)
    if [ -n "$NAME" ]; then SEEN="$SEEN $NAME"; else TIMEOUTS=$((TIMEOUTS+1)); fi
done
OWN_PODS=$(k get pods -n $NS -l app=hello-web -o jsonpath='{.items[*].metadata.name}')
DISTINCT=$(echo $SEEN | tr ' ' '\n' | sort -u | grep -cxF -f <(echo $OWN_PODS | tr ' ' '\n'))
[ "$TIMEOUTS" = "0" ]; check "$REQUESTS requests to http://$POOL_IP:$LB_PORT, $TIMEOUTS timed out" $?
[ "$DISTINCT" = "$SCHEDULABLE" ]; check "answers came from all $SCHEDULABLE pods (got $DISTINCT)" $?

echo "7. Firewall on the pool IP"
if command -v nc >/dev/null; then
    ! nc -z -w 3 $POOL_IP 10250 2>/dev/null; check "kubelet port 10250 is blocked from outside" $?
else echo "  SKIP  nc not installed, firewall not checked"; fi

echo
echo "Result: $PASSED passed, $FAILED failed"
[ "$FAILED" = "0" ]
