TEST-ONLY TLS material for scout-core's guarded-fetch end-to-end test
(src/fetch/guardedFetch.e2e.test.ts). Self-signed, valid for
scout-pinned.invalid only, trusted nowhere but that test. Never use it
for anything else.

Regenerate (valid 20 years):
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
    -keyout key.pem -out cert.pem -days 7300 -subj "/CN=scout-pinned.invalid" \
    -addext "subjectAltName=DNS:scout-pinned.invalid" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,digitalSignature,keyCertSign"
