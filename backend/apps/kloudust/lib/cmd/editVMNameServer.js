/**
 * editVMNameServer.js - Adds or removes a nameserver in a VM through its
 * qemu guest agent.
 *
 * Params: 0 - VM name, 1 - nameserver IPv4 address, 2 - add or remove
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See enclosed LICENSE file.
 */

const roleman = require(`${KLOUD_CONSTANTS.LIBDIR}/roleenforcer.js`);
const createVM = require(`${KLOUD_CONSTANTS.LIBDIR}/cmd/createVM.js`);
const dbAbstractor = require(`${KLOUD_CONSTANTS.LIBDIR}/dbAbstractor.js`);
const getVMReadiness = require(`${KLOUD_CONSTANTS.LIBDIR}/cmd/getVMReadiness.js`);
const {xforge} = require(`${KLOUD_CONSTANTS.THIRD_PARTY_DIR}/xforge/xforge`);
const CMD_CONSTANTS = require(`${KLOUD_CONSTANTS.LIBDIR}/cmd/cmdconstants.js`);

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

module.exports.exec = async function(params) {
    if (!roleman.checkAccess(roleman.ACTIONS.edit_project_resource)) {
        params.consoleHandlers.LOGUNAUTH(); return CMD_CONSTANTS.FALSE_RESULT();
    }
    const [vmNameRaw, nameserver, operation] = [...params];
    if (!IPV4.test(nameserver || "") || !["add", "remove"].includes(operation))
        return _error(params, "A valid nameserver IPv4 address and add or remove operation are required");

    const vm = await dbAbstractor.getVM(createVM.resolveVMName(vmNameRaw));
    if (!vm) return _error(params, "Bad VM name or VM not found");
    const hostInfo = await dbAbstractor.getHostEntry(vm.hostname);
    if (!hostInfo) return _error(params, "VM host not found");

    const readiness = await getVMReadiness.checkReadiness(vm.name, hostInfo, params.consoleHandlers);
    if (!readiness.status) return _error(params, `VM ${vm.name_raw} is not ready for guest-agent operations`);

    const result = await xforge({
        colors: KLOUD_CONSTANTS.COLORED_OUT,
        file: `${KLOUD_CONSTANTS.THIRD_PARTY_DIR}/xforge/samples/remoteCmd.xf.js`, console: params.consoleHandlers,
        other: [hostInfo.hostaddress, hostInfo.rootid, hostInfo.rootpw, hostInfo.hostkey, hostInfo.port,
            `${KLOUD_CONSTANTS.LIBDIR}/cmd/scripts/editVMNameServer.sh`, vm.name, nameserver, operation]
    });
    return result.result ? {...result, ...CMD_CONSTANTS.TRUE_RESULT()} : result;
};

function _error(params, error) { params.consoleHandlers.LOGERROR(error); return CMD_CONSTANTS.FALSE_RESULT(error); }
