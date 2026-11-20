/**
 * Reverses the project-VM networking performed by automations_createdns,
 * then removes the DNS server's now-empty VNet.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See enclosed LICENSE file.
 */

async function exec(params, kdcmd) {
    const [dnsVMName] = [...params];
    const dnsNetwork = await _getDNSNetwork(dnsVMName, kdcmd);
    if (!dnsNetwork) return false;

    // Snapshot complete. The normal VM deletion removes this VM's network
    // relationships, so it must happen after the network was discovered.
    if (!(await kdcmd(`deleteVM "${dnsVMName}"`)).result) return false;

    const vmList = await kdcmd(`listVMsForOrgOrProject "" "" "${APP_CONSTANTS.VM_TYPE_VM}"`);
    if (!vmList.result) return false;
    for (const vm of vmList.vms || []) {
        // VMs created after DNS setup do not have this VNet. Leave them intact.
        if (!(vm.vnets || []).includes(dnsNetwork.vnet)) continue;

        if (!(await kdcmd(`editVMNameServer "${vm.name_raw}" "${dnsNetwork.ip}" "remove"`)).result) return false;
        const privateIPs = await _getVMVnetIPs(vm.name_raw, dnsNetwork.vnet, kdcmd);
        if (!privateIPs) return false;
        for (const privateIP of privateIPs) {
            if (!(await kdcmd(`unassignVnetIP "${vm.name_raw}" "${privateIP}" "${dnsNetwork.vnet}"`)).result) return false;
        }
        if (!(await kdcmd(`deleteVMVnet "${vm.name_raw}" "${dnsNetwork.vnet}"`)).result) return false;
    }
    return (await kdcmd(`deleteVnet "${dnsNetwork.vnet}"`)).result;
}

async function _getDNSNetwork(dnsVMName, kdcmd) {
    const result = await kdcmd(`listVMsForOrgOrProject "" "" "${APP_CONSTANTS.VM_TYPE_DNS}"`);
    if (!result.result) return null;
    const dnsVM = (result.vms || []).find(vm => vm.name_raw === dnsVMName);
    if (!dnsVM) return null;

    const networks = [];
    for (const vnet of dnsVM.vnets || []) {
        const ips = await _getVMVnetIPs(dnsVMName, vnet, kdcmd);
        if (ips?.length) for (const ip of ips) networks.push({vnet, ip});
    }
    return networks.length === 1 ? networks[0] : null;
}

async function _getVMVnetIPs(vmName, vnetName, kdcmd) {
    const result = await kdcmd(`getVMVnetIPs "${vmName}" "${vnetName}"`);
    return result.result ? result.ips : null;
}

export const automations_deletedns = {exec};
