// Scout setup: the extension signing key and the Chrome extension ID derived from it.
//
// Chrome's unpacked-extension ID is SHA-256 of the DER SubjectPublicKeyInfo,
// first 16 bytes (32 hex digits), each hex digit 0-f mapped to a-p.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";

export const EXTENSION_ID_RE = /^[a-p]{32}$/;

/** A new 2048-bit RSA private key as PKCS#8 PEM. */
export function generateKeyPem() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs8", format: "pem" });
}

/** DER SubjectPublicKeyInfo of the public half of a private-key PEM. */
export function publicKeyDer(pem) {
  return createPublicKey(createPrivateKey(pem)).export({ type: "spki", format: "der" });
}

/** The manifest `key` value: base64 DER SPKI. */
export function manifestKey(pem) {
  return publicKeyDer(pem).toString("base64");
}

/** Chrome's ID for arbitrary bytes (id_util::GenerateId). */
export function idFromBytes(bytes) {
  const hex = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

export function extensionIdFromPem(pem) {
  return idFromBytes(publicKeyDer(pem));
}

export function extensionIdFromManifestKey(b64) {
  return idFromBytes(Buffer.from(b64, "base64"));
}
