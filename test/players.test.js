// PlayerRegistry (lib/players.js): the stable-device-identity contract.
// A claim survives the socket's disconnect, a returning token recovers
// its id, a live device's id is never handed away, and claims are
// bounded by the id space via LRU eviction of DISCONNECTED claims only.

const assert = require("node:assert/strict");
const test = require("node:test");

const { PlayerRegistry, isClaimToken } = require("../lib/players");

test("a fresh join gets an id and a token; the same socket re-joins idempotently", () => {
  const registry = new PlayerRegistry();

  const first = registry.allocate({ socketId: "s1", claimToken: null });

  assert.equal(first.status, "accepted");
  assert.equal(first.id, 1);
  assert.ok(isClaimToken(first.token));

  const again = registry.allocate({ socketId: "s1", claimToken: first.token });
  assert.equal(again.status, "accepted");
  assert.equal(again.id, 1);
  assert.equal(again.token, first.token);
});

test("a claim survives disconnect: the token recovers the same id", () => {
  const registry = new PlayerRegistry();

  const first = registry.allocate({ socketId: "s1", claimToken: null });
  const released = registry.releaseBySocket("s1");

  assert.equal(released.id, 1);
  assert.equal(released.claimToken, first.token);

  // A different device may join while 1 is claimed — it gets id 2.
  const other = registry.allocate({ socketId: "s2", claimToken: null });
  assert.equal(other.id, 2);

  // The dropped phone returns with its token: id 1, recovered.
  const back = registry.allocate({ socketId: "s3", claimToken: first.token });
  assert.equal(back.status, "recovered");
  assert.equal(back.id, 1);
  assert.equal(back.token, first.token);
  assert.equal(registry.findIdBySocket("s3"), 1);
});

test("a live device's id is never given away", () => {
  const registry = new PlayerRegistry({ maxClients: 2 });

  registry.allocate({ socketId: "s1", claimToken: null });
  registry.allocate({ socketId: "s2", claimToken: null });

  // Full with live devices: rejected, no eviction of the living.
  const third = registry.allocate({ socketId: "s3", claimToken: null });
  assert.equal(third.status, "rejected");
  assert.match(third.message, /full/);
});

test("claims are bounded: the OLDEST disconnected claim yields to a newcomer", () => {
  const registry = new PlayerRegistry({ maxClients: 2 });

  const a = registry.allocate({ socketId: "s1", claimToken: null });
  registry.allocate({ socketId: "s2", claimToken: null });
  registry.releaseBySocket("s1"); // id 1 claimed but disconnected

  // All ids claimed/bound; the newcomer evicts a's (disconnected) claim.
  const c = registry.allocate({ socketId: "s3", claimToken: null });
  assert.equal(c.status, "accepted");
  assert.equal(c.id, 1);

  // The second device leaves (its socket goes; its claim stands until
  // needed). a's token no longer holds id 1, so a returns as a fresh
  // device — into the next free id.
  registry.releaseBySocket("s2");
  const aBack = registry.allocate({ socketId: "s4", claimToken: a.token });
  assert.equal(aBack.status, "accepted");
  assert.equal(aBack.id, 2);
});

test("an unknown token joins as a fresh device (no cross-device leakage)", () => {
  const registry = new PlayerRegistry();

  registry.allocate({ socketId: "s1", claimToken: null });
  const stranger = registry.allocate({
    socketId: "s2",
    claimToken: "x".repeat(48),
  });

  assert.equal(stranger.status, "accepted");
  assert.equal(stranger.id, 2);
  assert.equal(stranger.token, "x".repeat(48)); // its own token kept
});

test("claim-token shape is enforced", () => {
  assert.equal(isClaimToken(null), false);
  assert.equal(isClaimToken("short"), false);
  assert.equal(isClaimToken("x".repeat(200)), false);
  assert.equal(isClaimToken("x".repeat(24)), true);
});
