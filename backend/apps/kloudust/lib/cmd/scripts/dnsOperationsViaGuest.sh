#!/bin/bash

# Calls the DNS manager through the DNS VM's guest agent. The service is bound
# to loopback in the guest, so no VM IP address or external network path is used.
# Params: {1} VM name, {2} base64-encoded JSON request body

VM_NAME={1}
PAYLOAD_B64={2}
DNS_API_URL="http://localhost:9090/apps/dnsmanager/dnsoperations"

exitFailed() { echo "$1" >&2; exit 1; }

GUEST_SCRIPT='payload=$(printf "%s" "'"$PAYLOAD_B64"'" | base64 --decode) || exit 1
for attempt in $(seq 1 5); do
  curl --ipv4 --noproxy "*" --fail --silent --show-error --connect-timeout 5 --max-time 15 \
    --header "Content-Type: application/json" --header "Accept: application/json" \
    --data "$payload" "'"$DNS_API_URL"'" && exit 0
  [ "$attempt" = "5" ] || sleep 2
done
echo "DNS API did not return an HTTP response from $DNS_API_URL" >&2
ss -lntp 'sport = :9090' >&2 || true
docker ps --filter name=kd-dns >&2 || true
exit 1'

JSON_PAYLOAD=$(jq -n --arg script "$GUEST_SCRIPT" \
  '{execute: "guest-exec", arguments: {path: "/bin/bash", arg: ["-c", $script], "capture-output": true}}')
PID=$(virsh -c qemu:///system qemu-agent-command "$VM_NAME" "$JSON_PAYLOAD" | jq -r '.return.pid') || exitFailed "Unable to start guest command"

for _ in $(seq 1 100); do
    STATUS=$(virsh -c qemu:///system qemu-agent-command "$VM_NAME" \
        "{\"execute\":\"guest-exec-status\",\"arguments\":{\"pid\":$PID}}") || exitFailed "Unable to get guest command status"
    [ "$(echo "$STATUS" | jq -r '.return.exited // false')" = "true" ] && break
    sleep 1
done

[ "$(echo "$STATUS" | jq -r '.return.exited // false')" = "true" ] || exitFailed "Timed out waiting for DNS operation"
EXIT_CODE=$(echo "$STATUS" | jq -r '.return.exitcode // 1')
[ "$EXIT_CODE" = "0" ] || { echo "$STATUS" | jq -r '.return["err-data"] // empty' | base64 --decode >&2; exit 1; }
echo "$STATUS" | jq -r '.return["out-data"] // empty' | base64 --decode
