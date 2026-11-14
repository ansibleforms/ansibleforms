// Test certificates, made with openssl : valid from a day ago, so they are valid the moment they
// are made, whatever the clock does.
//
// `openssl req -x509` and `openssl x509 -req` date a certificate from the second it is made. A
// clock stepped back by a second or more (WSL resyncing with its host, an NTP correction) then
// leaves it "not yet valid" for the TLS check that follows at once, and the test fails for a
// reason that has nothing to do with what it tests. `openssl ca` takes a start date : every
// certificate here starts a day before now and ends a few days after.
//
// The keys are EC (P-256) unless RSA is asked : a 2048-bit RSA key takes long enough to make that
// a test making three of them under load ran past its 5 second timeout.
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

// the time a test or a hook making certificates is given : openssl spawned a few times per
// certificate (an RSA key most of all) takes seconds on a loaded machine, past vitest's defaults
export const CERTIFICATE_TIMEOUT_MS = 60000;

// how far before now a certificate starts, and how long after now it ends
const START_BEFORE_MS = 24 * 3600 * 1000;
const END_AFTER_MS = 3 * 24 * 3600 * 1000;

/**
 * A moment as openssl ca takes it : YYYYMMDDHHMMSSZ, in UTC.
 *
 * Args:
 *   date (Date): the moment.
 *
 * Returns:
 *   string: the moment, e.g. 20261113021500Z.
 */
function opensslTime(date) {
  return date.toISOString().replace(/[-:T]/g, "").slice(0, 14) + "Z";
}

/**
 * Runs openssl, its output kept out of the test's.
 *
 * Args:
 *   args (string[]): the arguments.
 *
 * Raises:
 *   Error: openssl failed (its stderr in the message).
 */
function openssl(args) {
  execFileSync("openssl", args, { stdio: ["ignore", "ignore", "pipe"] });
}

/**
 * Makes a private key.
 *
 * Args:
 *   file (string): where it is written (PEM).
 *   keyType (string): "ec" (P-256) or "rsa" (2048 bits).
 */
function makeKey(file, keyType) {
  if (keyType === "rsa") openssl(["genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048", "-out", file]);
  else openssl(["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", file]);
}

/**
 * Makes a certificate valid from a day ago : self-signed, or signed by a test authority.
 *
 * Args:
 *   options (object):
 *     cn (string): its common name.
 *     san (string|undefined): its subjectAltName (DNS:rte.example, IP:127.0.0.1), none if left out.
 *     keyType (string): "ec" (default) or "rsa" (an RSA signature is needed : a JWT RS256).
 *     isCa (boolean): an authority (basicConstraints CA:TRUE) ; by default a self-signed one is,
 *       as `openssl req -x509` makes it, and one an authority signs is not.
 *     ca (object|undefined): the authority that signs it ({ certFile, keyFile } as this returns) ;
 *       self-signed when left out.
 *
 * Returns:
 *   object: { cert, key, certFile, keyFile } : the PEM texts and where they were written.
 *
 * Raises:
 *   Error: openssl is missing or refused.
 */
export function makeCertificate({ cn, san, keyType = "ec", ca, isCa = !ca } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-test-cert-"));
  const keyFile = path.join(dir, "key.pem");
  const csrFile = path.join(dir, "req.csr");
  const certFile = path.join(dir, "cert.pem");
  const configFile = path.join(dir, "ca.cnf");
  // Step 1 : the key and the request
  makeKey(keyFile, keyType);
  openssl(["req", "-new", "-key", keyFile, "-subj", `/CN=${cn}`, "-out", csrFile]);
  // Step 2 : the smallest openssl ca setup : its database, serial and the extensions given
  fs.writeFileSync(path.join(dir, "index.txt"), "");
  fs.writeFileSync(path.join(dir, "serial"), `${Date.now().toString(16).padStart(16, "0")}\n`);
  const extensions = [
    `basicConstraints = critical, CA:${isCa ? "TRUE" : "FALSE"}`,
    ...(isCa ? ["keyUsage = critical, keyCertSign, cRLSign, digitalSignature"] : []),
    ...(san ? [`subjectAltName = ${san}`] : []),
  ];
  fs.writeFileSync(
    configFile,
    [
      "[ca]",
      "default_ca = test_ca",
      "[test_ca]",
      `dir = ${dir}`,
      "database = $dir/index.txt",
      "serial = $dir/serial",
      "new_certs_dir = $dir",
      "default_md = sha256",
      "policy = policy_any",
      "unique_subject = no",
      "copy_extensions = none",
      "[policy_any]",
      "commonName = supplied",
      "[ext]",
      ...extensions,
      "",
    ].join("\n"),
  );
  // Step 3 : signed from a day ago, by its own key or by the authority's
  const now = Date.now();
  const signer = ca ? ["-cert", ca.certFile, "-keyfile", ca.keyFile] : ["-selfsign", "-keyfile", keyFile];
  openssl([
    "ca", "-batch", "-notext", "-config", configFile, "-extensions", "ext",
    "-startdate", opensslTime(new Date(now - START_BEFORE_MS)),
    "-enddate", opensslTime(new Date(now + END_AFTER_MS)),
    ...signer, "-in", csrFile, "-out", certFile,
  ]);
  return { cert: fs.readFileSync(certFile, "utf8"), key: fs.readFileSync(keyFile, "utf8"), certFile, keyFile };
}
