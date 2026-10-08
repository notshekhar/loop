import { describe, expect, it } from "vite-plus/test";

import { isLegalDocumentUrl } from "./legal-document-url";

describe("isLegalDocumentUrl", () => {
  it.each([
    "https://github.com/notshekhar/loop/blob/main/THIRD_PARTY_NOTICES.md",
    "https://github.com/notshekhar/loop/blob/main/THIRD_PARTY_NOTICES.md/",
    "https://github.com/notshekhar/loop/blob/main/SECURITY.md?source=app",
    "https://github.com/notshekhar/loop/blob/main/README.md#updates",
  ])("allows a configured legal document: %s", (url) => {
    expect(isLegalDocumentUrl(url)).toBe(true);
  });

  it.each([
    "https://github.com/notshekhar/loop/blob/main/install.sh",
    "https://t3.codes/legal",
    "https://example.com/legal",
    "javascript:alert(1)",
    "not-a-url",
  ])("rejects a URL outside the legal-document allowlist: %s", (url) => {
    expect(isLegalDocumentUrl(url)).toBe(false);
  });
});
