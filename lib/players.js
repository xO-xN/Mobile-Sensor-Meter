// Client identity registry.
//
// PNDS core, adapted for this project's stable-device-identity contract
// (#142: a reconnect must never become another device). Allocates a
// numeric device id for every joined performer and lets a client
// recover its id after a reconnect via a claim token.
//
// The adaptation vs. the shared PNDS core: the token→id CLAIM SURVIVES
// the socket's disconnect. A dropped phone that comes back — seconds or
// minutes later, same origin, same localStorage token — recovers its id
// and (with the sensor hub) its record; a device's row is never given
// away while its claim stands. Claims are bounded by the id space: when
// every id is claimed and a NEW device joins, the OLDEST disconnected
// claim is evicted (never a live one).

const crypto = require("node:crypto");

const TOKEN_MIN_LENGTH = 24;
const TOKEN_MAX_LENGTH = 128;

function isClaimToken(value) {
  return (
    typeof value === "string" &&
    value.length >= TOKEN_MIN_LENGTH &&
    value.length <= TOKEN_MAX_LENGTH
  );
}

function generateClaimToken() {
  return crypto.randomBytes(24).toString("hex");
}

class PlayerRegistry {
  constructor({ maxClients = 16 } = {}) {
    this.maxClients = maxClients;
    this.assignments = new Map(); // id -> { socketId, claimToken } (live)
    // id -> claimToken, INSERTION-ORDERED (oldest claim first). Survives
    // disconnects; bounds the id space; drives LRU eviction.
    this.claims = new Map();
  }

  get size() {
    return this.assignments.size;
  }

  // Returns { status: "accepted" | "recovered" | "rejected", id?, token? }.
  // "recovered" means the client reconnected with a claim this registry
  // still honors and reclaimed its previous id.
  allocate({ socketId, claimToken }) {
    if (isClaimToken(claimToken)) {
      const claimedId = this.idOfClaim(claimToken);

      if (claimedId !== null) {
        const current = this.assignments.get(claimedId);

        if (!current || current.socketId !== socketId) {
          // (Re)bind the socket: a reconnect, or a takeover when the old
          // socket is somehow still bound. The id and the record stay
          // with the token.
          this.assignments.set(claimedId, { socketId, claimToken });
          this.touchClaim(claimedId);
          return { status: "recovered", id: claimedId, token: claimToken };
        }

        return { status: "accepted", id: claimedId, token: claimToken };
      }
    }

    const id = this.nextFreeId();

    if (id === null) {
      return {
        status: "rejected",
        message: `Server is full (max ${this.maxClients} clients).`,
      };
    }

    const token = isClaimToken(claimToken)
      ? claimToken
      : generateClaimToken();

    this.assignments.set(id, { socketId, claimToken: token });
    this.claims.set(id, token);

    return { status: "accepted", id, token };
  }

  release(id) {
    const assignment = this.assignments.get(id);

    if (!assignment) {
      return null;
    }

    // The socket binding goes; the claim stays for the reconnect.
    this.assignments.delete(id);

    return assignment;
  }

  // Returns the id bound to a socket, or null.
  findIdBySocket(socketId) {
    for (const [id, assignment] of this.assignments) {
      if (assignment.socketId === socketId) {
        return id;
      }
    }

    return null;
  }

  // Returns { id, claimToken } bound to a socket, or null, and unbinds
  // the socket. The claim (and the id it holds) survives.
  releaseBySocket(socketId) {
    for (const [id, assignment] of this.assignments) {
      if (assignment.socketId === socketId) {
        this.assignments.delete(id);
        return { id, claimToken: assignment.claimToken };
      }
    }

    return null;
  }

  // Returns the claim token bound to a socket, or null.
  getTokenBySocket(socketId) {
    for (const assignment of this.assignments.values()) {
      if (assignment.socketId === socketId) {
        return assignment.claimToken;
      }
    }

    return null;
  }

  // The id a claim currently holds, or null.
  idOfClaim(claimToken) {
    for (const [id, token] of this.claims) {
      if (token === claimToken) {
        return id;
      }
    }

    return null;
  }

  nextFreeId() {
    for (let id = 1; id <= this.maxClients; id += 1) {
      if (!this.assignments.has(id) && !this.claims.has(id)) {
        return id;
      }
    }

    // Every id is bound or claimed. A newcomer may still join by evicting
    // the OLDEST claim whose socket is gone — a live device's claim is
    // never taken away.
    for (const [id] of this.claims) {
      if (!this.assignments.has(id)) {
        this.claims.delete(id);
        return id;
      }
    }

    return null;
  }

  // Refresh a claim's LRU position (a returning device is the most
  // recently used identity).
  touchClaim(id) {
    const token = this.claims.get(id);

    if (token !== undefined) {
      this.claims.delete(id);
      this.claims.set(id, token);
    }
  }

  list() {
    return [...this.assignments.entries()].map(([id, assignment]) => ({
      id,
      socketId: assignment.socketId,
    }));
  }
}

module.exports = {
  PlayerRegistry,
  isClaimToken,
  generateClaimToken,
};
