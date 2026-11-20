/**
 * getVMVnetIPs.js - Lists private IP addresses assigned to one VM/VNet pair.
 *
 * Params: 0 - VM name, 1 - VNet name
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See enclosed LICENSE file.
 */

const roleman = require(`${KLOUD_CONSTANTS.LIBDIR}/roleenforcer.js`);
const createVM = require(`${KLOUD_CONSTANTS.LIBDIR}/cmd/createVM.js`);
const createVnet = require(`${KLOUD_CONSTANTS.LIBDIR}/cmd/createVnet.js`);
const dbAbstractor = require(`${KLOUD_CONSTANTS.LIBDIR}/dbAbstractor.js`);
const CMD_CONSTANTS = require(`${KLOUD_CONSTANTS.LIBDIR}/cmd/cmdconstants.js`);

module.exports.exec = async function(params) {
    if (!roleman.checkAccess(roleman.ACTIONS.lookup_project_resource)) {
        params.consoleHandlers.LOGUNAUTH(); return CMD_CONSTANTS.FALSE_RESULT();
    }
    const [vmNameRaw, vnetNameRaw] = [...params];
    const vmName = createVM.resolveVMName(vmNameRaw), vnetName = createVnet.resolveVnetName(vnetNameRaw);
    if (!vmName || !vnetName) return _error(params, "A VM name and VNet name are required");
    if (!await dbAbstractor.getVM(vmName)) return _error(params, "Bad VM name or VM not found");
    if (!await dbAbstractor.getVnet(vnetName)) return _error(params, "Bad VNet name or VNet not found");

    const ips = await dbAbstractor.getVMVnetIP(vmName, vnetName);
    const out = JSON.stringify(ips || []);
    return {...CMD_CONSTANTS.TRUE_RESULT(out), stdout: out, ips: ips || []};
};

function _error(params, error) { params.consoleHandlers.LOGERROR(error); return CMD_CONSTANTS.FALSE_RESULT(error); }
