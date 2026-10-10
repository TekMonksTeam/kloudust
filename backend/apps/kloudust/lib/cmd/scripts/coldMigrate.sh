#!/bin/bash

# Moves a shut off VM to another host with all its disks, snapshots, metadata and firewall scripts
# Params
# {1} - Domain / VM name
# {2} - The IP for the host to migrate to
# {3} - The host to migrate to admin ID
# {4} - The host to migrate to admin password
# {5} - The host to migrate to SSH port

DOMAIN="{1}"
HOSTTO="{2}"
HOSTTOID="{3}"
HOSTTOPW='{4}'
HOSTTOPORT='{5}'
set -o pipefail

remoteSSH() {
    sshpass -p "$HOSTTOPW" ssh -o StrictHostKeyChecking=accept-new -p "$HOSTTOPORT" "$HOSTTOID@$HOSTTO" "$@"
}

function exitFailed() {
    if [ -n "$CLEANUP_REMOTE" ]; then remoteSSH "virsh undefine $DOMAIN --nvram; rm -rf $FILES" > /dev/null 2>&1; fi
    echo Error: $1 >&2
    echo Failed
    exit 1
}

if [ "$(virsh domstate $DOMAIN | xargs)" != "shut off" ]; then exitFailed "VM $DOMAIN is not shut off"; fi

UUID=$(virsh domuuid $DOMAIN | xargs)
FILES="$(ls -d /kloudust/snapshots/$DOMAIN.* /kloudust/metadata/$DOMAIN.* /kloudust/system/firewall/fw_${DOMAIN}_*.sh /var/lib/libvirt/swtpm/${UUID:-none} 2> /dev/null) $(virsh dumpxml $DOMAIN | grep -oP '<nvram[^>]*>\K[^<]+')"
for DISK in $(virsh domblklist $DOMAIN --details | awk '$1=="file" && $4!="-" {print $4}'); do
    if ! CHAIN=$(qemu-img info --backing-chain "$DISK" | awk '/^image:/ {print $2}'); then exitFailed "Unable to read disk $DISK or its snapshot chain"; fi
    FILES="$FILES $CHAIN"
done
FILES=$(echo $FILES | tr " " "\n" | grep -vE "^/kloudust/(drivers|catalog)/" | sort -u | xargs)   # drivers and catalog are on every host
if [[ "$FILES" != */kloudust/disks/* ]]; then exitFailed "Unable to detect disk files for $DOMAIN"; fi
echo Files to move: $FILES

CONFLICTS=$(remoteSSH "virsh dominfo $DOMAIN > /dev/null 2>&1 && echo $DOMAIN; ls -d $FILES 2> /dev/null; echo checked")
if [ "$CONFLICTS" != "checked" ]; then exitFailed "$HOSTTO is unreachable or already has $CONFLICTS"; fi

CLEANUP_REMOTE=1
echo Copying $DOMAIN to $HOSTTO
if ! tar -cSPf - $FILES | remoteSSH "tar -xpPf -"; then exitFailed "Copying files to $HOSTTO failed"; fi
if ! virsh dumpxml --security-info $DOMAIN | remoteSSH "cat > /kloudust/metadata/$DOMAIN.xml && virsh define /kloudust/metadata/$DOMAIN.xml"; then exitFailed "Unable to define $DOMAIN on $HOSTTO"; fi
if virsh dominfo $DOMAIN | grep -q "^Autostart:.*enable" && ! remoteSSH "virsh autostart $DOMAIN"; then exitFailed "Unable to enable autostart on $HOSTTO"; fi
if [ "$(virsh domstate $DOMAIN | xargs)" != "shut off" ]; then exitFailed "VM $DOMAIN was started during the move"; fi

if ! virsh undefine $DOMAIN --keep-nvram; then exitFailed "Unable to undefine $DOMAIN on this host"; fi
CLEANUP_REMOTE=""
RECYCLEBIN=/kloudust/recyclebin/$DOMAIN.`date +%s`
if ! (mkdir -p $RECYCLEBIN && mv $FILES $RECYCLEBIN/); then echo Warning: Some files of $DOMAIN could not be moved to $RECYCLEBIN; fi

printf "\n\nVM $DOMAIN moved successfully to $HOSTTO\n"
exit 0
