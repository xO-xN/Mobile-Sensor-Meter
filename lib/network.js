// LAN IPv4 helpers.
//
// Reusable PNDS core: PNDS App injects PNDS_HOST_IP with the LAN address the
// user picked. Standalone debugging falls back to the first non-loopback
// IPv4 address.

const os = require("node:os");

function findLanIpv4Addresses() {
  const addresses = [];
  const interfaces = os.networkInterfaces();

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === "IPv4" && !iface.internal) {
        addresses.push({
          name,
          address: iface.address,
        });
      }
    }
  }

  return addresses;
}

function resolveHostLanIp(preferred) {
  if (preferred && String(preferred).trim() !== "") {
    return String(preferred).trim();
  }

  const addresses = findLanIpv4Addresses();

  return addresses[0]?.address || "127.0.0.1";
}

module.exports = {
  findLanIpv4Addresses,
  resolveHostLanIp,
};
