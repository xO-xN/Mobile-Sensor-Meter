// PNDS runtime health endpoint (/__pnds/health).
//
// Reusable PNDS core: PNDS App treats status === "ready" in the JSON body as
// the signal that the project can be displayed.

class HealthTracker {
  constructor({ projectId, audioMode, performerPort, monitorPort }) {
    this.projectId = projectId;
    this.audioMode = audioMode;
    this.performerPort = performerPort;
    this.monitorPort = monitorPort;
    this.status = "starting";
    this.audioStatus = "starting";
    this.oscTarget = null;
    this.error = null;
  }

  setAudioStarting() {
    this.status = "starting";
    this.audioStatus = "starting";
  }

  // No-audio projects (audioMode "none"): the runtime contract requires
  // audio.status "disabled" with a null target.
  setAudioDisabled() {
    this.status = "ready";
    this.audioStatus = "disabled";
    this.oscTarget = null;
    this.error = null;
  }

  setAudioReady(oscTarget) {
    this.status = "ready";
    this.audioStatus = "ready";
    this.oscTarget = oscTarget || null;
    this.error = null;
  }

  setError(error) {
    this.status = "error";
    this.audioStatus = "error";
    this.error = error instanceof Error ? error : new Error(String(error));
  }

  setStopping() {
    this.status = "stopping";
  }

  payload() {
    const payload = {
      status: this.status,
      projectId: this.projectId,
      audioMode: this.audioMode,
      audio: {
        status: this.audioStatus,
        target: this.oscTarget,
      },
      scoreServer: {
        performerPort: this.performerPort,
        monitorPort: this.monitorPort,
      },
    };

    if (this.error) {
      payload.error = this.error.message;
    }

    return payload;
  }

  handler() {
    return (request, response) => {
      response.json(this.payload());
    };
  }
}

module.exports = {
  HealthTracker,
};
