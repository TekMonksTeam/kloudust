/**
 * Automation to create a standalone DNS server VM. Creates a minimal VM whose cloud-init
 * installs docker, downloads and loads the DNS docker image tar and runs it on ports 53, 
 * 9090 and 8443. Attaches it to the project-local dns VNet with a fixed private
 * IP, then assigns an available public IP to the VM unless told not to.
 * 
 * NOTE: the generated cloud-init must not contain double quotes, dollar signs, backticks,
 * percent signs or backslashes as it is embedded into a shell script by createVM.sh.
 * 
 * (C) 2026 TekMonks. All rights reserved.
 * License: See enclosed LICENSE file.
 */

const SAFE_VALUE = /^[^\s'"$`\\%]+$/;
const READY_CHECK_ATTEMPTS = 5, READY_CHECK_WAIT_SECONDS = 60;
const DNS_VNET = "dns", DNS_PRIVATE_IP = "10.10.10.10";

async function exec(params, kdcmd) {
    const [name, size, image, tarurl, dockerimage, adminpass, assignpublicip] = [...params];
    const [cores, memory, disk] = size.split(":");
    for (const value of [name, tarurl, dockerimage, adminpass]) if (!SAFE_VALUE.test(value)) return false;

    const dockerRun = `docker run -d --name kd-dns --restart=always --cap-add=NET_ADMIN `+
        `-p 53:53/udp -p 53:53/tcp -p 9090:9090 -p 8443:8443 ${dockerimage}`;
    const runcmds = [
        "systemctl start qemu-guest-agent",
        "sed -i s/^#*DNSStubListener=.*/DNSStubListener=no/ /etc/systemd/resolved.conf",
        "ln -sf /run/systemd/resolve/resolv.conf /etc/resolv.conf",
        "systemctl restart systemd-resolved",
        "systemctl enable --now docker",
        `curl -fL ${tarurl} -o /root/kd-dns.tar`,
        "docker load -i /root/kd-dns.tar",
        dockerRun
    ].map(cmd => `[bash, -lc, '${cmd}']`).join(", ");

    const cloudinit = `{system_info: {default_user: {name: kdadmin, home: /home/kdadmin, sudo: 'ALL=(ALL) NOPASSWD:ALL'}}, `+
        `password: ${adminpass}, chpasswd: {expire: false}, hostname: ${name}, fqdn: ${name}, ssh_pwauth: true, `+ 
        `package_upgrade: true, packages: [net-tools, qemu-guest-agent, curl, docker.io], runcmd: [${runcmds}]}`;

    const created = (await kdcmd(`createVM "${name}" "DNS server" "${cores}" "${memory}" "${disk}" "${DNS_VNET}" "${image}" "${cloudinit}" "false" "" "" "" "vm" "false" "" ""`)).result;
    if (!created) return false;

    const isVMReady = await _waitForVMReady(name, kdcmd);
    if (!isVMReady) return false;

    const privateIPAssigned = (await kdcmd(`assignVnetIP "${name}" "${DNS_PRIVATE_IP}" "${DNS_VNET}"`)).result;
    if (!privateIPAssigned) return false;

    const shouldAssignPublicIP = assignpublicip != "false";
    if (!shouldAssignPublicIP) return true;

    const publicIPAssigned = (await kdcmd(`assignIPToVM "${name}" "" ""`)).result;
    return publicIPAssigned;
}

async function _waitForVMReady(name, kdcmd) {
    for (let i = 0; i < READY_CHECK_ATTEMPTS; i++) {
        const readiness = await kdcmd(`getVMReadiness "${name}" "${READY_CHECK_WAIT_SECONDS}"`);
        if (readiness.status) return true;
    } return false;
}

export const automations_createdns = {exec};
