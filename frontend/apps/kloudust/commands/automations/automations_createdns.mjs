/**
 * Automation to create a standalone DNS server VM. Creates a minimal VM whose cloud-init
 * installs docker, downloads and loads the DNS docker image tar and runs it on ports 53, 
 * 9090 and 8443, then sets the DNS server's API key. Attaches it to the project-local dns VNet with a fixed private
 * IP selected by the user, then assigns an available public IP to the VM unless told not to.
 * 
 * NOTE: the generated cloud-init must not contain double quotes, dollar signs, backticks,
 * percent signs or backslashes as it is embedded into a shell script by createVM.sh.
 * 
 * (C) 2026 TekMonks. All rights reserved.
 * License: See enclosed LICENSE file.
 */

const SAFE_VALUE = /^[^\s'"$`\\%]+$/;
const SAFE_VNET_NAME = /^[A-Za-z0-9]+$/;
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const READY_CHECK_ATTEMPTS = 10, READY_CHECK_WAIT_SECONDS = 120;
const DEFAULT_DNS_API_URL = "http://localhost:9090/apps/dnsmanager/dnsoperations";
const DEFAULT_DNS_API_KEY = "Gifjxv09348ikjfg9034zdewjidw834284hwqdnejwr79389";

async function exec(params, kdcmd) {
    const [name, vnetName, dnsPrivateIP, size, image, tarurl, dockerimage, adminpass, assignpublicip, updatekey] = [...params];
    const [cores, memory, disk] = size.split(":");
    for (const value of [name, tarurl, dockerimage, adminpass]) if (!SAFE_VALUE.test(value)) return false;
    if (!SAFE_VNET_NAME.test(vnetName) || !IPV4.test(dnsPrivateIP) || !_nextPrivateIP(dnsPrivateIP)) return false;

    const dockerRun = `docker run -d --name kd-dns --restart=always --cap-add=NET_ADMIN `+
        `-p 53:53/udp -p 53:53/tcp -p 9090:9090 -p 8443:8443 ${dockerimage}`;
    const runcmds = [   // the guest agent decides when KD considers the VM ready, so it is stopped here and only started at the end
        "systemctl stop qemu-guest-agent",
        "sed -i s/^#*DNSStubListener=.*/DNSStubListener=no/ /etc/systemd/resolved.conf",
        "ln -sf /run/systemd/resolve/resolv.conf /etc/resolv.conf",
        "systemctl restart systemd-resolved",
        "systemctl enable --now docker",
        `curl -fL ${tarurl} -o /root/kd-dns.tar`,
        "docker load -i /root/kd-dns.tar",
        dockerRun,
        "sleep 5 && docker ps -q --filter name=kd-dns --filter status=running | grep -q . && systemctl start qemu-guest-agent"
    ].map(cmd => `[bash, -lc, '${cmd}']`).join(", ");

    const cloudinit = `{system_info: {default_user: {name: kdadmin, home: /home/kdadmin, sudo: 'ALL=(ALL) NOPASSWD:ALL'}}, `+
        `password: ${adminpass}, chpasswd: {expire: false}, hostname: ${name}, fqdn: ${name}, ssh_pwauth: true, `+ 
        `package_upgrade: true, packages: [net-tools, curl, docker.io, qemu-guest-agent], runcmd: [${runcmds}]}`;

    const created = (await kdcmd(`createVM "${name}" "DNS server" "${cores}" "${memory}" "${disk}" "${vnetName}" "${image}" "${cloudinit}" "false" "" "" "" "${APP_CONSTANTS.VM_TYPE_DNS}" "false" "" ""`)).result;
    if (!created) return false;

    const isVMReady = await _waitForVMReady(name, kdcmd);
    if (!isVMReady) return false;

    // stores the DNS server's API URL and key against the VM, and unless told not to, replaces the default key 
    // inside the DNS server with a newly generated one (the backend waits for the DNS container to be up)
    const keySet = (await kdcmd(`editDnsRecords "${name}" "setkey" "${updatekey != "false"}" "${DEFAULT_DNS_API_KEY}" "${DEFAULT_DNS_API_URL}"`)).result;
    if (!keySet) return false;

    const privateIPAssigned = (await kdcmd(`assignVnetIP "${name}" "${dnsPrivateIP}" "${vnetName}"`)).result;
    if (!privateIPAssigned) return false;

    // Put every regular VM in this project on the selected DNS network. Their
    // addresses start immediately after the DNS server address.
    const vmList = await kdcmd(`listVMsForOrgOrProject "" "" "vm"`);
    if (!vmList.result) return false;
    let privateIP = _nextPrivateIP(dnsPrivateIP);
    for (const vm of vmList.vms || []) {
        if (!privateIP) return false;  // do not roll over into another subnet
        if (!(await kdcmd(`addVMVnet "${vm.name_raw}" "${vnetName}" "false"`)).result) return false;
        if (!(await kdcmd(`assignVnetIP "${vm.name_raw}" "${privateIP}" "${vnetName}"`)).result) return false;
        if (!(await kdcmd(`editVMNameServer "${vm.name_raw}" "${dnsPrivateIP}" "add"`)).result) return false;
        privateIP = _nextPrivateIP(privateIP);
    }

    const shouldAssignPublicIP = assignpublicip != "false";
    if (!shouldAssignPublicIP) return true;

    const publicIPAssigned = (await kdcmd(`assignIPToVM "${name}" "" ""`)).result;
    return publicIPAssigned;
}

function _nextPrivateIP(ip) {
    const octets = ip.split(".").map(Number);
    if (octets.length !== 4 || octets[3] >= 254) return null;
    octets[3]++;
    return octets.join(".");
}

async function _waitForVMReady(name, kdcmd) {
    for (let i = 0; i < READY_CHECK_ATTEMPTS; i++) {
        const readiness = await kdcmd(`getVMCloudInitReadiness "${name}" "${READY_CHECK_WAIT_SECONDS}"`);
        if (readiness.status) return true;
    } return false;
}

export const automations_createdns = {exec};
