#!/bin/bash

# Calls the DNS manager through the DNS VM's guest agent. The service is bound
# to loopback in the guest, so no VM IP address or external network path is used.
# Params: {1} VM name, {2} base64-encoded JSON request body, {3} base64-encoded x-api-key or - if the
# DNS server is not key protected (the header is then not sent), {4} base64-encoded API URL, {5} base64-encoded
# NEW x-api-key or -. If a new key is given then this script instead waits for the DNS container, replaces the
# current key with the new key in the container's dnsmanager folders, restarts the container and verifies the new
# key works by running the request body ({2}) with it. Failures before anything was changed print NOCHANGE.

VM_NAME={1}
PAYLOAD_B64={2}
API_KEY_B64={3}
API_URL_B64={4}
NEW_KEY_B64={5}

set -o pipefail
exitFailed() { echo "$1" >&2; exit 1; }
command -v jq >/dev/null || exitFailed "jq is not installed on this Kloudust host"

# Scripts run inside the guest. The quoted heredocs avoid any quoting issues, the
# placeholders are replaced below. Nothing is expanded on the host.
read -r -d '' GUEST_CALL_SCRIPT <<'GUEST_EOF'
payload=$(printf '%s' '__PAYLOAD_B64__' | base64 --decode) || exit 1
url=$(printf '%s' '__API_URL_B64__' | base64 --decode) || exit 1
keyargs=(); if [ '__API_KEY_B64__' != '-' ]; then
  apikey=$(printf '%s' '__API_KEY_B64__' | base64 --decode) || exit 1
  keyargs=(--header "x-api-key: $apikey")
fi
for attempt in 1 2 3 4 5; do
  curl --ipv4 --noproxy '*' --fail --silent --show-error --connect-timeout 5 --max-time 15 \
    --header 'Content-Type: application/json' --header 'Accept: application/json' "${keyargs[@]}" \
    --data "$payload" "$url" && exit 0
  [ "$attempt" = "5" ] || sleep 2
done
echo "DNS API did not return an HTTP response from $url" >&2
ss -lntp 'sport = :9090' >&2 || true
docker ps --filter name=kd-dns >&2 || true
exit 1
GUEST_EOF

read -r -d '' GUEST_UPDATE_SCRIPT <<'GUEST_EOF'
old=$(printf '%s' '__API_KEY_B64__' | base64 --decode) || exit 1
new=$(printf '%s' '__NEW_KEY_B64__' | base64 --decode) || exit 1
payload=$(printf '%s' '__PAYLOAD_B64__' | base64 --decode) || exit 1
url=$(printf '%s' '__API_URL_B64__' | base64 --decode) || exit 1
nochange() { echo "NOCHANGE: $1" >&2; exit 1; }
# keys go into sed expressions, so only plain characters are allowed
printf '%s%s' "$old" "$new" | grep -Eq '^[A-Za-z0-9_-]+$' || nochange "keys can only have letters, digits, _ and -"

for _ in $(seq 1 150); do   # the container starts after docker installs and the image downloads, so wait for it
  [ -n "$(docker ps -q --filter name=kd-dns --filter status=running 2>/dev/null)" ] && break; sleep 5
done
[ -n "$(docker ps -q --filter name=kd-dns --filter status=running 2>/dev/null)" ] || nochange "DNS container is not running"

dirs=$(docker exec kd-dns find / -type d -name dnsmanager -not -path '/proc/*' 2>/dev/null)
[ -n "$dirs" ] || nochange "dnsmanager folder not found in the DNS container"
files=$(docker exec kd-dns sh -c 'old=$1; shift; grep -rlF -e "$old" "$@"' sh "$old" $dirs)
[ -n "$files" ] || nochange "current key not found in the DNS container's dnsmanager folders"

docker exec kd-dns sh -c 'old=$1; new=$2; shift 2; grep -rlF -e "$old" "$@" | xargs sed -i "s/$old/$new/g"' sh "$old" "$new" $dirs || { echo "Updating the key failed part way" >&2; exit 1; }
docker restart kd-dns >/dev/null || { echo "Restarting the DNS container failed" >&2; exit 1; }

for _ in $(seq 1 60); do    # verify the new key works
  curl --ipv4 --noproxy '*' --fail --silent --connect-timeout 5 --max-time 15 \
    --header 'Content-Type: application/json' --header 'Accept: application/json' --header "x-api-key: $new" \
    --data "$payload" "$url" && exit 0
  sleep 3
done
echo "DNS API did not accept the new key after restart" >&2
exit 1
GUEST_EOF

GUEST_SCRIPT="$GUEST_CALL_SCRIPT"; MAX_WAIT=100
if [ "$NEW_KEY_B64" != "-" ]; then GUEST_SCRIPT="$GUEST_UPDATE_SCRIPT"; MAX_WAIT=1500; fi
GUEST_SCRIPT="${GUEST_SCRIPT//__PAYLOAD_B64__/$PAYLOAD_B64}"
GUEST_SCRIPT="${GUEST_SCRIPT//__API_URL_B64__/$API_URL_B64}"
GUEST_SCRIPT="${GUEST_SCRIPT//__API_KEY_B64__/$API_KEY_B64}"
GUEST_SCRIPT="${GUEST_SCRIPT//__NEW_KEY_B64__/$NEW_KEY_B64}"

JSON_PAYLOAD=$(jq -n --arg script "$GUEST_SCRIPT" \
  '{execute: "guest-exec", arguments: {path: "/bin/bash", arg: ["-c", $script], "capture-output": true}}') || exitFailed "Unable to build guest command"
PID=$(virsh -c qemu:///system qemu-agent-command "$VM_NAME" "$JSON_PAYLOAD" | jq -er '.return.pid') || exitFailed "Unable to start guest command"

for _ in $(seq 1 $MAX_WAIT); do
    STATUS=$(virsh -c qemu:///system qemu-agent-command "$VM_NAME" \
        "{\"execute\":\"guest-exec-status\",\"arguments\":{\"pid\":$PID}}") || exitFailed "Unable to get guest command status"
    [ "$(echo "$STATUS" | jq -r '.return.exited // false')" = "true" ] && break
    sleep 1
done

[ "$(echo "$STATUS" | jq -r '.return.exited // false')" = "true" ] || exitFailed "Timed out waiting for DNS operation"
EXIT_CODE=$(echo "$STATUS" | jq -r '.return.exitcode // 1')
[ "$EXIT_CODE" = "0" ] || { echo "$STATUS" | jq -r '.return["err-data"] // empty' | base64 --decode >&2; exit 1; }
echo "$STATUS" | jq -r '.return["out-data"] // empty' | base64 --decode
