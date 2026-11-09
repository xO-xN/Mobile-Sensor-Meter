const fs = require("node:fs");
const path = require("node:path");

// The Host retains these listeners through spawn. Never probe or rebind them.
function runtimePorts(environment) {
  if (!environment.PNDS_RUNTIME_PORTS) return null;
  const value = JSON.parse(environment.PNDS_RUNTIME_PORTS);
  const roles = ["performer", "monitor"];
  if (value?.version !== 1 || typeof value.runId !== "string" || !value.runId ||
      typeof value.reportPath !== "string" || !path.isAbsolute(value.reportPath) ||
      !Array.isArray(value.services) || value.services.length !== 2 ||
      !roles.every(role => value.services.filter(service => service?.role === role &&
        Number.isInteger(service.fd) && service.fd >= 3 &&
        Number.isInteger(service.port) && service.port > 0 && service.port <= 65535).length === 1) ||
      new Set(value.services.map(service => service.fd)).size !== 2 ||
      new Set(value.services.map(service => service.port)).size !== 2) {
    throw new Error("Invalid PNDS runtime listener assignment");
  }
  return value;
}

function bindingReporter(assignment) {
  const bound = new Set();
  return (role, server, error) => {
    if (!assignment) return;
    const service = assignment.services.find(item => item.role === role);
    if (!error && server.address()?.port !== service.port)
      error = new Error(`Inherited ${role} listener does not match its assigned port`);
    if (!error) bound.add(role);
    if (!error && bound.size !== 2) return;
    const report = {
      version: 1, runId: assignment.runId, status: error ? "error" : "bound",
      services: error ? [] : assignment.services.map(({role, port}) => ({role, port})),
      ...(error ? {error: error.message} : {}),
    };
    const temporary = `${assignment.reportPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(report), {mode: 0o600});
    fs.renameSync(temporary, assignment.reportPath);
  };
}

module.exports = { runtimePorts, bindingReporter };
