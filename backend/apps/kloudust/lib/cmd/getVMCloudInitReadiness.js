/**
 * getVMCloudInitReadiness.js - Waits until cloud-init has completed inside a
 * VM. This is intentionally separate from getVMReadiness, which only checks
 * whether qemu-guest-agent is available.
 *
 * Params: 0 - VM name, 1 - maximum wait in seconds (optional)
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See enclosed LICENSE file.
 */

const roleman = require(`${KLOUD_CONSTANTS.LIBDIR}/roleenforcer.js`);
const createVM = require(`${KLOUD_CONSTANTS.LIBDIR}/cmd/createVM.js`);
const dbAbstractor = require(`${KLOUD_CONSTANTS.LIBDIR}/dbAbstractor.js`);
const {xforge} = require(`${KLOUD_CONSTANTS.THIRD_PARTY_DIR}/xforge/xforge`);
const CMD_CONSTANTS = require(`${KLOUD_CONSTANTS.LIBDIR}/cmd/cmdconstants.js`);

module.exports.exec = async function(params) {
    if (!roleman.checkAccess(roleman.ACTIONS.lookup_project_resource)) {
        params.consoleHandlers.LOGUNAUTH(); return {...CMD_CONSTANTS.FALSE_RESULT(), status: false};
    }
    const [vmNameRaw, maxWaitRaw] = [...params], vmName = createVM.resolveVMName(vmNameRaw);
    const maxWait = _getMaxWait(maxWaitRaw);
    if (!vmNameRaw || !maxWait) return _error(params, "A VM name and positive cloud-init timeout are required");

    const vm = await dbAbstractor.getVM(vmName);
    if (!vm) return _error(params, "Bad VM name or VM not found");
    const hostInfo = await dbAbstractor.getHostEntry(vm.hostname);
    if (!hostInfo) return _error(params, "Bad hostname or host not found");

    const result = await xforge({
        colors: KLOUD_CONSTANTS.COLORED_OUT,
        file: `${KLOUD_CONSTANTS.THIRD_PARTY_DIR}/xforge/samples/remoteCmd.xf.js`, console: params.consoleHandlers,
        other: [hostInfo.hostaddress, hostInfo.rootid, hostInfo.rootpw, hostInfo.hostkey, hostInfo.port,
            `${KLOUD_CONSTANTS.LIBDIR}/cmd/scripts/guestCloudInitCheck.sh`, vmName, maxWait]
    });
    const output = `${result.out || ""}\n${result.stdout || ""}\n${result.err || ""}`;
    const cloudInitError = output.includes("KD_CLOUD_INIT=error");
    const status = output.includes("KD_CLOUD_INIT=done");
    const out = status ? "Cloud-init completed successfully." : "Cloud-init has not completed yet.";
    return {...result, result: !cloudInitError, status, out: `${result.out || result.stdout || ""}\n${out}`.trim(), stdout: `${result.stdout || result.out || ""}\n${out}`.trim()};
};

function _getMaxWait(value) {
    if (value === undefined || value === null || value === "") return KLOUD_CONSTANTS.CONF.MAX_GUEST_AGENT_CHECK_WAIT;
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null;
}

function _error(params, error) { params.consoleHandlers.LOGERROR(error); return {...CMD_CONSTANTS.FALSE_RESULT(error), status: false}; }
