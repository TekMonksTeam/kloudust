#!/bin/bash

# Updates /etc/resolv.conf in a VM through qemu-guest-agent.
# Params: {1} VM name, {2} nameserver IPv4 address, {3} add|remove

VM_NAME={1}
NAMESERVER={2}
OPERATION={3}

set -o pipefail
exitFailed() { echo "$1" >&2; exit 1; }
command -v jq >/dev/null || exitFailed "jq is not installed on this Kloudust host"

read -r -d '' GUEST_SCRIPT <<'GUEST_EOF'
nameserver='__NAMESERVER__'
operation='__OPERATION__'
resolv_conf=/etc/resolv.conf
[ -e "$resolv_conf" ] || { echo "Missing $resolv_conf" >&2; exit 1; }
tmp=$(mktemp) || exit 1
trap 'rm -f "$tmp"' EXIT

case "$operation" in
  add)
    if awk -v nameserver="$nameserver" '$1 == "nameserver" && $2 == nameserver { found=1 } END { exit !found }' "$resolv_conf"; then
      echo "Nameserver $nameserver already present"
      exit 0
    fi
    # Preserve leading comments/options, but put this server ahead of the
    # existing resolver list so it is queried first.
    awk -v nameserver="$nameserver" '
      $1 == "nameserver" && !inserted { print "nameserver " nameserver; inserted=1 }
      { print }
      END { if (!inserted) print "nameserver " nameserver }
    ' "$resolv_conf" > "$tmp" || exit 1
    ;;
  remove)
    # Replace the matching nameserver directive with nothing. This removes
    # only this DNS server and leaves all other resolver configuration intact.
    awk -v nameserver="$nameserver" '$1 == "nameserver" && $2 == nameserver { next } { print }' "$resolv_conf" > "$tmp" || exit 1
    ;;
  *) echo "Invalid operation" >&2; exit 1 ;;
esac

# Redirecting into the existing path preserves a resolv.conf symlink (common
# with systemd-resolved) rather than replacing the symlink with a regular file.
cat "$tmp" > "$resolv_conf" || exit 1
echo "Nameserver $nameserver updated (${operation})"
GUEST_EOF

GUEST_SCRIPT="${GUEST_SCRIPT//__NAMESERVER__/$NAMESERVER}"
GUEST_SCRIPT="${GUEST_SCRIPT//__OPERATION__/$OPERATION}"
JSON_PAYLOAD=$(jq -n --arg script "$GUEST_SCRIPT" \
    '{execute: "guest-exec", arguments: {path: "/bin/bash", arg: ["-c", $script], "capture-output": true}}') || exitFailed "Unable to build guest command"
PID=$(virsh -c qemu:///system qemu-agent-command "$VM_NAME" "$JSON_PAYLOAD" | jq -er '.return.pid') || exitFailed "Unable to start guest command"

for _ in $(seq 1 60); do
    STATUS=$(virsh -c qemu:///system qemu-agent-command "$VM_NAME" \
        "{\"execute\":\"guest-exec-status\",\"arguments\":{\"pid\":$PID}}") || exitFailed "Unable to get guest command status"
    [ "$(echo "$STATUS" | jq -r '.return.exited // false')" = "true" ] && break
    sleep 1
done

[ "$(echo "$STATUS" | jq -r '.return.exited // false')" = "true" ] || exitFailed "Timed out waiting for nameserver update"
[ "$(echo "$STATUS" | jq -r '.return.exitcode // 1')" = "0" ] || {
    echo "$STATUS" | jq -r '.return["err-data"] // empty' | base64 --decode >&2; exit 1;
}
echo "$STATUS" | jq -r '.return["out-data"] // empty' | base64 --decode
