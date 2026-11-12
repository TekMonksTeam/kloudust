/**
 * editDnsRecords.js - Runs DNS record operations inside a project DNS VM.
 *
 * Params: 0 - DNS VM name, 1 - operation (list, create, delete or sync),
 *         2 - record/records JSON. sync reconciles the supplied record list.
 */

const roleman = require(`${KLOUD_CONSTANTS.LIBDIR}/roleenforcer.js`);
const createVM = require(`${KLOUD_CONSTANTS.LIBDIR}/cmd/createVM.js`);
const dbAbstractor = require(`${KLOUD_CONSTANTS.LIBDIR}/dbAbstractor.js`);
const getVMReadiness = require(`${KLOUD_CONSTANTS.LIBDIR}/cmd/getVMReadiness.js`);
const {xforge} = require(`${KLOUD_CONSTANTS.THIRD_PARTY_DIR}/xforge/xforge`);
const CMD_CONSTANTS = require(`${KLOUD_CONSTANTS.LIBDIR}/cmd/cmdconstants.js`);

const DNS_VM_TYPE = "dns";
const RECORD_TYPES = new Set(["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV"]);

module.exports.exec = async function(params) {
    if (!roleman.checkAccess(roleman.ACTIONS.edit_project_resource)) {
        params.consoleHandlers.LOGUNAUTH(); return CMD_CONSTANTS.FALSE_RESULT();
    }

    const [dnsVMRaw, operation, payloadRaw] = params;
    if (!dnsVMRaw || !["list", "create", "delete", "sync"].includes(operation))
        return _error(params, "DNS server and a valid operation are required");

    const dnsVM = await dbAbstractor.getVM(createVM.resolveVMName(dnsVMRaw));
    if (!dnsVM || dnsVM.vmtype !== DNS_VM_TYPE) return _error(params, "DNS server not found");

    const hostInfo = await dbAbstractor.getHostEntry(dnsVM.hostname);
    if (!hostInfo) return _error(params, "DNS server host not found");

    const readiness = await getVMReadiness.checkReadiness(dnsVM.name, hostInfo, params.consoleHandlers);
    if (!readiness.status) return _error(params, "DNS server is not ready for guest-agent operations");

    try {
        if (operation === "list") return await _callDNS(dnsVM, hostInfo, params.consoleHandlers, {operation});
        if (operation === "create") {
            const record = _parseRecord(payloadRaw);
            if (!record) return _error(params, "Invalid DNS record");
            return await _callDNS(dnsVM, hostInfo, params.consoleHandlers, {operation, record});
        }
        if (operation === "delete") {
            const name = _parseDeleteName(payloadRaw);
            if (!name) return _error(params, "A DNS record name is required for delete");
            return await _callDNS(dnsVM, hostInfo, params.consoleHandlers, {operation, name});
        }
        return await _syncRecords(dnsVM, hostInfo, params.consoleHandlers, payloadRaw);
    } catch (err) {
        return _error(params, `DNS operation failed: ${err.message || err}`);
    }
};

async function _callDNS(vm, hostInfo, consoleHandlers, body) {
    const payload = Buffer.from(JSON.stringify(body)).toString("base64");
    const response = await xforge({
        colors: KLOUD_CONSTANTS.COLORED_OUT,
        file: `${KLOUD_CONSTANTS.THIRD_PARTY_DIR}/xforge/samples/remoteCmd.xf.js`, console: consoleHandlers,
        other: [hostInfo.hostaddress, hostInfo.rootid, hostInfo.rootpw, hostInfo.hostkey, hostInfo.port,
            `${KLOUD_CONSTANTS.LIBDIR}/cmd/scripts/dnsOperationsViaGuest.sh`, vm.name, payload]
    });
    if (!response.result) throw new Error(response.err || "Guest DNS operation failed");
    const result = JSON.parse((response.stdout || response.out || "").trim());
    if (!result.result) throw new Error(result.err || "DNS API rejected the operation");
    return {...CMD_CONSTANTS.TRUE_RESULT(), ...result};
}

async function _syncRecords(vm, hostInfo, consoleHandlers, payloadRaw) {
    const desired = _parseRecordList(payloadRaw);
    if (!Array.isArray(desired)) throw new Error("DNS record list must be an array");
    const records = desired.map(_parseRecord);
    if (records.some(record => !record)) throw new Error("Invalid DNS record");

    const current = (await _callDNS(vm, hostInfo, consoleHandlers, {operation: "list"})).records || [];
    const currentByName = _recordsByName(current), desiredByName = _recordsByName(records);
    const names = new Set([...currentByName.keys(), ...desiredByName.keys()]);
    for (const name of names) {
        const currentRecords = currentByName.get(name) || [], desiredRecords = desiredByName.get(name) || [];
        if (_sameRecords(currentRecords, desiredRecords)) continue;
        if (currentRecords.length) await _callDNS(vm, hostInfo, consoleHandlers, {operation: "delete", name});
        for (const record of desiredRecords) await _callDNS(vm, hostInfo, consoleHandlers, {operation: "create", record});
    }
    return {...CMD_CONSTANTS.TRUE_RESULT(), operation: "sync", records};
}

function _parseRecordList(payloadRaw) {
    try {
        let records = JSON.parse(payloadRaw);
        if (typeof records === "string") records = JSON.parse(records);
        return records;
    } catch (_) {
        // Kloudust command lines use double quotes. Support the quote-stripped
        // representation produced when callers supply JSON without escaping it.
        if (typeof payloadRaw !== "string" || !payloadRaw.startsWith("[") || !payloadRaw.endsWith("]")) return null;
        const records = [];
        for (const rawRecord of payloadRaw.matchAll(/\{([^{}]+)\}/g)) {
            const record = {};
            for (const property of rawRecord[1].split(",")) {
                const separator = property.indexOf(":"); if (separator < 1) return null;
                const key = property.slice(0, separator).trim(), value = property.slice(separator + 1).trim();
                if (!["name", "type", "value", "ttl"].includes(key)) return null;
                record[key] = value;
            }
            records.push(record);
        }
        return records.length ? records : [];
    }
}

function _parseRecord(payloadRaw) {
    let record; try { record = typeof payloadRaw === "string" ? JSON.parse(payloadRaw) : payloadRaw; } catch (_) { return null; }
    if (!record || typeof record.name !== "string" || !record.name.trim() || typeof record.value !== "string" || !record.value.trim()) return null;
    const type = (record.type || "A").toUpperCase(), ttl = Number(record.ttl);
    if (!RECORD_TYPES.has(type) || !Number.isSafeInteger(ttl) || ttl < 0) return null;
    return {name: record.name.trim(), type, value: record.value.trim(), ttl};
}

function _parseDeleteName(payloadRaw) {
    try { const value = JSON.parse(payloadRaw); return typeof value.name === "string" && value.name.trim() ? value.name.trim() : null; }
    catch (_) { return null; }
}

const _recordKey = record => JSON.stringify([record.name, record.type, record.value, record.ttl]);
const _recordsByName = records => records.reduce((byName, record) => {
    const recordsForName = byName.get(record.name) || []; recordsForName.push(record); byName.set(record.name, recordsForName); return byName;
}, new Map());
const _sameRecords = (first, second) => first.length === second.length &&
    first.every(record => second.some(other => _recordKey(record) === _recordKey(other)));
function _error(params, err) { params.consoleHandlers.LOGERROR(err); return CMD_CONSTANTS.FALSE_RESULT(err); }
