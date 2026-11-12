/* DNS record editor. All DNS API calls are proxied through editDnsRecords. */
import {util} from "/framework/js/util.mjs";
import {monkshu_component} from "/framework/js/monkshu_component.mjs";

const COMPONENT_PATH = util.getModulePath(import.meta);

function elementConnected(host) {
    Object.defineProperty(host, "value", {get: _ => _getValue(host), set: value => _setValue(host, value)});
    let dnsServers = []; try { dnsServers = JSON.parse(host.getAttribute("value") || "{}").dnsServers || []; } catch (_) {}
    dns_records.setDataByHost(host, {dnsServers});
}

function elementRendered(host) {
    const root = dns_records.getShadowRootByHost(host);
    const select = root.querySelector("#dns_server");
    if (!select.value && select.options.length > 1) select.selectedIndex = 1;
    const server = select.value;
    if (server) loadRecords(root.querySelector("#dns_server"));
    else _addRow(root);
}

async function loadRecords(select) {
    const root = dns_records.getShadowRootByContainedElement(select), server = select.value;
    const container = root.querySelector("#records"), status = root.querySelector("#status");
    container.innerHTML = ""; status.textContent = "";
    if (!server) return _addRow(root);
    const {cmdmanager} = await import(`${APP_CONSTANTS.LIB_PATH}/cmdmanager.mjs`);
    const project = $$.libsession.get(APP_CONSTANTS.ACTIVE_PROJECT);
    const response = await cmdmanager.kdcmd("editDnsRecords", ["dns_server", "operation"],
        {dns_server: server, operation: "list"}, project, true);
    if (!response?.result) {
        status.textContent = response?.err || "Unable to load DNS records.";
        return _addRow(root);
    }
    for (const record of response.records || []) _addRow(root, record);
    if (!(response.records || []).length) _addRow(root);
}

function addRow(button) { _addRow(dns_records.getShadowRootByContainedElement(button)); }
function removeRow(button) {
    const root = dns_records.getShadowRootByContainedElement(button), container = root.querySelector("#records");
    button.closest(".record-row").remove(); if (!container.children.length) _addRow(root);
}

function _addRow(root, record={type: "A", ttl: 60}) {
    const node = root.querySelector("template").content.cloneNode(true);
    node.querySelector(".name").value = record.name || "";
    node.querySelector(".type").value = record.type || "A";
    node.querySelector(".value").value = record.value || "";
    node.querySelector(".ttl").value = record.ttl ?? 60;
    root.querySelector("#records").appendChild(node);
}

function _getValue(host) {
    const root = dns_records.getShadowRootByHost(host);
    const records = [...root.querySelectorAll(".record-row")].map(row => ({
        name: row.querySelector(".name").value.trim(), type: row.querySelector(".type").value,
        value: row.querySelector(".value").value.trim(), ttl: Number(row.querySelector(".ttl").value)
    })).filter(record => record.name || record.value);
    return {dns_server: root.querySelector("#dns_server").value, records};
}

function _setValue(host, value) {
    const root = dns_records.getShadowRootByHost(host), data = typeof value === "string" ? JSON.parse(value) : value;
    if (data.dns_server) root.querySelector("#dns_server").value = data.dns_server;
    const container = root.querySelector("#records"); container.innerHTML = "";
    for (const record of data.records || []) _addRow(root, record);
    if (!container.children.length) _addRow(root);
}

export const dns_records = {trueWebComponentMode: true, elementConnected, elementRendered, loadRecords, addRow, removeRow};
monkshu_component.register("dns-records", `${COMPONENT_PATH}/dns-records.html`, dns_records);
