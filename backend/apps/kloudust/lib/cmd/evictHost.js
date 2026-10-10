/**
 * evictHost.js - Moves all VMs off a host, across all orgs and projects. Running VMs
 * are live migrated, stopped ones are cold migrated with their disks and snapshots.
 * Only cloud admins can run this command. A failed VM doesn't stop the eviction,
 * all failures are reported at the end for manual checking.
 *
 * Params - 0 - hostname for the host to evict
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See enclosed LICENSE file.
 */
const roleman = require(`${KLOUD_CONSTANTS.LIBDIR}/roleenforcer.js`);
const liveMigrate = require(`${KLOUD_CONSTANTS.LIBDIR}/cmd/liveMigrate.js`);
const coldMigrate = require(`${KLOUD_CONSTANTS.LIBDIR}/cmd/coldMigrate.js`);
const dbAbstractor = require(`${KLOUD_CONSTANTS.LIBDIR}/dbAbstractor.js`);
const CMD_CONSTANTS = require(`${KLOUD_CONSTANTS.LIBDIR}/cmd/cmdconstants.js`);
const liveMigrateHostHelper = require(`${KLOUD_CONSTANTS.LIBDIR}/cmd/liveMigrateHostHelper.js`);
const STOPPED = CMD_CONSTANTS.VM_POWER_STATES.STOPPED;

/**
 * Evicts all VMs from the host
 * @param {array} params The incoming params, see above
 */
module.exports.exec = async function(params) {
    if (!roleman.checkAccess(roleman.ACTIONS.edit_cloud_resource)) {params.consoleHandlers.LOGUNAUTH(); return CMD_CONSTANTS.FALSE_RESULT();}

    const hostInfo = params[0] ? await dbAbstractor.getHostEntry(params[0]) : null;
    if (!hostInfo) {const error = "Bad hostname or host not found"; params.consoleHandlers.LOGERROR(error); return CMD_CONSTANTS.FALSE_RESULT(error);}

    const vms = (await dbAbstractor.listVMsForCloudAdmin(["*"], hostInfo.hostname)) || [];
    vms.sort((vm1, vm2) => (vm1.powerstate == STOPPED) - (vm2.powerstate == STOPPED));    // running VMs first

    const evicted = [], failed = [];
    for (const [i, vm] of vms.entries()) {
        const project = vm.projectid.slice(0, -(vm.org.length+1)), vmLabel = `${vm.name_raw} (${vm.org}/${project})`;  // projectid is <project>_<org>
        params.consoleHandlers.LOGINFO(`Evicting VM ${i+1} of ${vms.length}: ${vmLabel}`);
        let lastError = ""; const consoleHandlers = {...params.consoleHandlers,
            LOGERROR: err => {lastError = err; params.consoleHandlers.LOGERROR(err);}};
        try {
            const result = await KLOUD_CONSTANTS.env.runAs({org: vm.org, project}, _ => _evictVM(vm, hostInfo.hostname, consoleHandlers));
            if (result.result) evicted.push(`${vmLabel} -> ${result.to}`);
            else failed.push(`${vmLabel}: ${String(lastError||result.err||"see logs").replace(/\s+/g, " ").slice(-300)}`);
        } catch (err) {failed.push(`${vmLabel}: ${err}`);}
    }

    let report = [`Evicted ${evicted.length} of ${vms.length} VMs from host ${hostInfo.hostname}.`, ...evicted].join("\n");
    if (!failed.length) {params.consoleHandlers.LOGINFO(report); return CMD_CONSTANTS.TRUE_RESULT(report);}
    report += `\nThese VMs were NOT evicted and need manual checking:\n${failed.join("\n")}`;
    params.consoleHandlers.LOGERROR(report); return CMD_CONSTANTS.FALSE_RESULT(report, report);
}

async function _evictVM(vm, hostname, consoleHandlers) {
    const {error, vm: vmNow, hosts} = await liveMigrateHostHelper.getCompatibleHostsForLiveMigration(vm.name_raw);
    if (!vmNow) return CMD_CONSTANTS.FALSE_RESULT(error);
    if (vmNow.hostname.toLowerCase() != hostname.toLowerCase()) return {result: true, to: `${vmNow.hostname} (already moved)`};
    if (!hosts.length) return CMD_CONSTANTS.FALSE_RESULT("No compatible host with enough free capacity");

    const hostTo = hosts[0].hostname, migrateParams = [vm.name_raw, hostTo];
    migrateParams.consoleHandlers = consoleHandlers;
    const liveResult = await liveMigrate.exec(migrateParams);
    if (liveResult.result) return {result: true, to: hostTo};
    if ((await dbAbstractor.getVM(vm.name))?.powerstate != STOPPED) return liveResult;    // liveMigrate's readiness check just refreshed it
    const coldResult = await coldMigrate.exec(migrateParams);
    return coldResult.result ? {result: true, to: `${hostTo} (cold, was stopped)`} : coldResult;
}
