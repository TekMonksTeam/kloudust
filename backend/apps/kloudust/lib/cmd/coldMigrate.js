/**
 * coldMigrate.js - Moves a stopped VM to another host with all its disks, snapshots,
 * metadata and firewall scripts. Only cloud admins can run this command.
 *
 * Params - 0 - vm_name, 1 - hostname for the host to move to
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See enclosed LICENSE file.
 */
const vnet = require(`${KLOUD_CONSTANTS.LIBDIR}/vnet.js`);
const roleman = require(`${KLOUD_CONSTANTS.LIBDIR}/roleenforcer.js`);
const addVMVnet = require(`${KLOUD_CONSTANTS.LIBDIR}/cmd/addVMVnet.js`);
const dbAbstractor = require(`${KLOUD_CONSTANTS.LIBDIR}/dbAbstractor.js`);
const {xforge} = require(`${KLOUD_CONSTANTS.THIRD_PARTY_DIR}/xforge/xforge`);
const CMD_CONSTANTS = require(`${KLOUD_CONSTANTS.LIBDIR}/cmd/cmdconstants.js`);
const liveMigrateHostHelper = require(`${KLOUD_CONSTANTS.LIBDIR}/cmd/liveMigrateHostHelper.js`);

/**
 * Cold migrates a stopped VM
 * @param {array} params The incoming params, see above
 */
module.exports.exec = async function(params) {
    if (!roleman.checkAccess(roleman.ACTIONS.edit_cloud_resource)) {params.consoleHandlers.LOGUNAUTH(); return CMD_CONSTANTS.FALSE_RESULT();}
    const {error, vm, sourceHost, hosts} = await liveMigrateHostHelper.getCompatibleHostsForLiveMigration(params[0]);
    const hostTo = hosts?.find(host => host.hostname.toLowerCase() == String(params[1]).toLowerCase());
    if (!hostTo) return _logError(error || `Host ${params[1]} is not a compatible destination for VM ${params[0]}`, params);

    for (const vm_vnet of await addVMVnet.getVMVnets(vm.name_raw))
        await vnet.expandVnetToHost((await dbAbstractor.getVnetName(vm_vnet)).name, hostTo, params.consoleHandlers, true);

    const results = await xforge({
        colors: KLOUD_CONSTANTS.COLORED_OUT,
        file: `${KLOUD_CONSTANTS.THIRD_PARTY_DIR}/xforge/samples/remoteCmd.xf.js`,
        console: params.consoleHandlers,
        other: [
            sourceHost.hostaddress, sourceHost.rootid, sourceHost.rootpw, sourceHost.hostkey, sourceHost.port,
            `${KLOUD_CONSTANTS.LIBDIR}/cmd/scripts/coldMigrate.sh`,
            vm.name, hostTo.hostaddress, hostTo.rootid, hostTo.rootpw, hostTo.port
        ]
    });
    if (results.result && !await dbAbstractor.updateVMHost(vm.id, hostTo.hostname)) return _logError(
        `VM ${params[0]} was moved to ${hostTo.hostname} but the DB update failed, fix its host in the DB`, params);
    return results;
}

function _logError(error, params) {params.consoleHandlers.LOGERROR(error); return CMD_CONSTANTS.FALSE_RESULT(error);}
