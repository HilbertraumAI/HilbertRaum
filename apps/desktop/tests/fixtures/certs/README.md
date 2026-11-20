# Certificate fixtures (#564)

Test certificates for `tests/integration/system-trust.test.ts`, which checks which certificates of the
operating system's store the in-app downloads add to Node's trust (`src/main/services/net/trust.ts`).
Each file isolates one rule of that filter. Certificates only: the private keys were thrown away, and
nothing here is trusted anywhere.

| File | What it is | The filter |
|---|---|---|
| `root-rsa2048.pem` | self-signed CA, RSA 2048 | kept |
| `default-root.pem` | self-signed CA, RSA 2048 (stands in for Node's own list) | kept |
| `root-ec-p256.pem` | self-signed CA, EC P-256 | kept |
| `root-ec-p384.pem` | self-signed CA, EC P-384 | kept |
| `root-ed25519.pem` | self-signed CA, Ed25519 | kept |
| `root-ec-p192.pem` | self-signed CA, EC P-192 | dropped: weak curve |
| `root-expired.pem` | self-signed CA, valid 2020-01-01 to 2021-01-01 | dropped: expired |
| `root-not-yet-valid.pem` | self-signed CA, valid from 2100-01-01 | dropped: not valid yet |
| `root-rsa1024.pem` | self-signed CA, RSA 1024 | dropped: key too short |
| `root-dsa.pem` | self-signed CA, DSA 2048 | dropped: key type |
| `intermediate.pem` | CA issued by `root-rsa2048.pem` | dropped: not self-signed |
| `name-twin.pem` | CA whose issuer name equals its subject, signed by another key | dropped: not self-signed |
| `name-twin-no-key-ids.pem` | the same, with no subject or authority key identifier: `checkIssued` passes it | dropped: its signature does not verify with its own key |
| `own-key-other-issuer.pem` | CA signed by its own key, but its issuer names another CA | dropped: `checkIssued` fails |
| `self-signed-leaf.pem` | self-signed `CN=localhost` server certificate, `CA:FALSE` | dropped: not a CA |

The valid ones run from 2026-01-01 to 2125-12-31. Made 2026-11-20 with OpenSSL 3.5.7 (Git for Windows),
`openssl req -x509 -newkey <key> -not_before … -not_after … -addext basicConstraints=critical,CA:TRUE
-addext keyUsage=critical,keyCertSign,cRLSign` for the roots, `openssl x509 -req -CA … -extfile` with
`subjectKeyIdentifier = hash` and `authorityKeyIdentifier = keyid` for the intermediate and the name
twin (the twin's issuing certificate was not kept), `subjectKeyIdentifier = none` and
`authorityKeyIdentifier = none` for the twin without key identifiers and for
`own-key-other-issuer.pem` (whose issuing certificate, another name over the same key as
`root-rsa2048.pem`, was not kept), and `basicConstraints=critical,CA:FALSE` for the leaf. Review
round 2026-11-20 added the P-192, P-384, no-key-identifier and other-issuer certificates.
