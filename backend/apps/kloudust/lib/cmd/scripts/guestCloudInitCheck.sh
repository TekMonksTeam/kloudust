#!/bin/bash

# Waits for cloud-init to complete in a Linux VM via qemu-guest-agent.
# Params: {1} VM name, {2} maximum wait in seconds

VM_NAME={1}
MAX_WAIT={2}

set -o pipefail
exitFailed() { echo "$1" >&2; exit 1; }
command -v jq >/dev/null || exitFailed "jq is not installed on this Kloudust host"
[[ "$MAX_WAIT" =~ ^[1-9][0-9]*$ ]] || exitFailed "Invalid cloud-init timeout"

# First wait for qemu-guest-agent. Starting a guest command immediately makes
# a just-created VM fail this check instead of consuming the requested wait.
START_TIME=$SECONDS
while (( SECONDS - START_TIME < MAX_WAIT )); do
    if virsh -c qemu:///system qemu-agent-command "$VM_NAME" \
        '{"execute":"guest-ping"}' >/dev/null 2>&1; then break; fi
    sleep 5
done
virsh -c qemu:///system qemu-agent-command "$VM_NAME" \
    '{"execute":"guest-ping"}' >/dev/null 2>&1 || exitFailed "Timed out waiting for QEMU guest agent"

REMAINING_WAIT=$(( MAX_WAIT - (SECONDS - START_TIME) ))
(( REMAINING_WAIT > 0 )) || exitFailed "Timed out before cloud-init could be checked"

# Some cloud-init releases return immediately from `status --wait` in edge
# cases. Poll the reported state explicitly, and succeed only once it says
# `status: done`; otherwise keep waiting until the original deadline.
read -r -d '' GUEST_SCRIPT <<'GUEST_EOF'
command -v cloud-init >/dev/null || { echo 'KD_CLOUD_INIT=not_done'; exit 0; }
max_wait=__MAX_WAIT__
deadline=$((SECONDS + max_wait))
while true; do
    status=$(cloud-init status 2>&1)
    if printf '%s\n' "$status" | grep -Eq '^[[:space:]]*status:[[:space:]]+done[[:space:]]*$'; then
        printf '%s\n' "$status"
        echo 'KD_CLOUD_INIT=done'
        exit 0
    fi
    if printf '%s\n' "$status" | grep -Eq '^[[:space:]]*status:[[:space:]]+error[[:space:]]*$'; then
        printf '%s\n' "$status" >&2
        echo 'KD_CLOUD_INIT=error' >&2
        exit 1
    fi
    if (( SECONDS >= deadline )); then
        printf '%s\n' "$status"
        echo 'KD_CLOUD_INIT=not_done'
        exit 0
    fi
    sleep 5
done
GUEST_EOF
GUEST_SCRIPT="${GUEST_SCRIPT//__MAX_WAIT__/$REMAINING_WAIT}"
JSON_PAYLOAD=$(jq -n --arg script "$GUEST_SCRIPT" \
    '{execute: "guest-exec", arguments: {path: "/bin/bash", arg: ["-c", $script], "capture-output": true}}') || exitFailed "Unable to build guest command"
PID=$(virsh -c qemu:///system qemu-agent-command "$VM_NAME" "$JSON_PAYLOAD" | jq -er '.return.pid') || exitFailed "Unable to start guest command"

# Allow a small grace period after the in-guest timeout for qemu-guest-agent
# to publish the exit status.
for _ in $(seq 1 $((REMAINING_WAIT + 15))); do
    STATUS=$(virsh -c qemu:///system qemu-agent-command "$VM_NAME" \
        "{\"execute\":\"guest-exec-status\",\"arguments\":{\"pid\":$PID}}") || exitFailed "Unable to get guest command status"
    [ "$(echo "$STATUS" | jq -r '.return.exited // false')" = "true" ] && break
    sleep 1
done

[ "$(echo "$STATUS" | jq -r '.return.exited // false')" = "true" ] || exitFailed "Timed out waiting for cloud-init"
[ "$(echo "$STATUS" | jq -r '.return.exitcode // 1')" = "0" ] || {
    echo "$STATUS" | jq -r '.return["err-data"] // empty' | base64 --decode >&2
    echo "$STATUS" | jq -r '.return["out-data"] // empty' | base64 --decode >&2
    exit 1
}
echo "$STATUS" | jq -r '.return["out-data"] // empty' | base64 --decode
