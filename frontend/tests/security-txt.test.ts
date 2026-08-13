import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const securityTxt = readFileSync(
  resolve(process.cwd(), "public/.well-known/security.txt"),
  "utf8",
);
const headers = readFileSync(resolve(process.cwd(), "public/_headers"), "utf8");

describe("security.txt", () => {
  it("publishes the disclosure contact, expiry, and canonical URL", () => {
    expect(securityTxt).toContain(
      "Contact: https://github.com/genisis-lab/securesend/security/advisories/new",
    );
    expect(securityTxt).toContain("Expires: 2027-08-13T00:00:00Z");
    expect(securityTxt).toContain(
      "Canonical: https://send.builtwai.com/.well-known/security.txt",
    );
  });

  it("forces the well-known static asset to text/plain", () => {
    expect(headers).toMatch(
      /\/\.well-known\/security\.txt\s+Content-Type: text\/plain; charset=utf-8/,
    );
  });
});
