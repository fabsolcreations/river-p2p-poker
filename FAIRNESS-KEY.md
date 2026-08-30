# RIVER operator signing key

This is the public half of the key RIVER signs seed acknowledgements with.
It is committed here **on purpose**.

## Why this file exists

Every time you sit at a server-dealt table, your browser sends a random seed
that feeds the shuffle. The server signs a statement back:

```
RIVER_SEED_ACK_V1|{handId}|seat_{seat}|{seedHash}
```

— *"for hand H, seat N, I hold a seed hashing to X."* Your browser keeps it
(localStorage, key `river-seed-acks`).

If a hand's published receipt later shows a different seed for your seat,
you are holding the operator's own signature contradicting the operator's own
receipt. That is evidence, not an accusation.

**But that only works if the key can't be swapped after the fact.** An
operator free to rotate keys silently could disown any signature by claiming
it was never theirs. So the key is pinned here, in a public commit with a
timestamp and history, rather than only served from the same machine that
would be doing the disowning.

If `/api/fairness/public-key` ever returns something different from what is
below, and this file has not been updated in a commit you can inspect, treat
signatures verified against the *new* key as worthless.

## The key

Algorithm: **ECDSA P-256 / SHA-256**

```json
{
  "kty": "EC",
  "crv": "P-256",
  "x": "i3kxQT7p-PnHjYvtWfHdPlL5Ak4WsQ7kOFHe130HfnE",
  "y": "zk5wnHyFmyz308Pil6vTVJdzS1Y1ewaqBM6yfMkqUSI",
  "key_ops": ["verify"],
  "ext": true
}
```

First published: 2026-08-25. Served live at
<https://playriver.gg/api/fairness/public-key>.

## Verifying an acknowledgement yourself

Nothing RIVER-specific is required — this is plain WebCrypto, and you can
paste it into any browser console:

```js
const jwk = { kty:"EC", crv:"P-256", x:"i3kxQT7p-PnHjYvtWfHdPlL5Ak4WsQ7kOFHe130HfnE",
              y:"zk5wnHyFmyz308Pil6vTVJdzS1Y1ewaqBM6yfMkqUSI", key_ops:["verify"], ext:true };

// One of your saved acknowledgements.
const ack = JSON.parse(localStorage.getItem("river-seed-acks"))[0];

const key = await crypto.subtle.importKey("jwk", jwk, { name:"ECDSA", namedCurve:"P-256" }, false, ["verify"]);
const payload = new TextEncoder().encode(
  `RIVER_SEED_ACK_V1|${ack.handId}|seat_${ack.seat}|${ack.seedHash}`);
const sig = Uint8Array.from(atob(ack.signature), c => c.charCodeAt(0));

await crypto.subtle.verify({ name:"ECDSA", hash:"SHA-256" }, key, sig, payload);  // true
```

To check a specific hand, compare `ack.seedHash` against
`sha256("RIVER_SEED_ACK_HASH_V1|" + reveals[seat])` from that hand's receipt.
A mismatch on a signature that still verifies means the seed you sent was not
the seed that was used.

## Scope — what this does and does not cover

- **Covers:** the server substituting a different seed for a seat that really
  sent one, on server-dealt tables.
- **Does not cover:** the server seeing your hole cards. On server-dealt
  tables it deals them, so it knows them. That is what trustless heads-up
  tables are for, where the deck is encrypted between the two browsers and
  the server holds no key at all.

See `/fairness` on the site for the full threat register.
