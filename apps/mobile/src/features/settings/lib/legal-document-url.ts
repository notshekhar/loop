// loop has no marketing site; its policies live with the code.
const DEFAULT_MARKETING_SITE_URL = "https://github.com/notshekhar/loop/blob/main/";

function resolveMarketingSiteUrl(override: string | undefined): URL {
  try {
    const url = new URL(override?.trim() || DEFAULT_MARKETING_SITE_URL);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return new URL(DEFAULT_MARKETING_SITE_URL);
    }

    url.search = "";
    url.hash = "";
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
    return url;
  } catch {
    return new URL(DEFAULT_MARKETING_SITE_URL);
  }
}

const MARKETING_SITE_URL = resolveMarketingSiteUrl(process.env.EXPO_PUBLIC_MARKETING_SITE_URL);

function marketingSiteDocumentUrl(path: string): string {
  return new URL(path, MARKETING_SITE_URL).toString();
}

// loop publishes no privacy policy or terms — it is software you run, with no
// service behind it — so those point at the README rather than at a page that
// would claim otherwise. The app only shows LEGAL_URL.
export const PRIVACY_POLICY_URL = marketingSiteDocumentUrl("README.md");
export const SECURITY_POLICY_URL = marketingSiteDocumentUrl("SECURITY.md");
export const TERMS_OF_SERVICE_URL = marketingSiteDocumentUrl("README.md");
export const LEGAL_URL = marketingSiteDocumentUrl("THIRD_PARTY_NOTICES.md");

export const ALLOWED_LEGAL_DOCUMENT_URLS = [
  LEGAL_URL,
  PRIVACY_POLICY_URL,
  TERMS_OF_SERVICE_URL,
  SECURITY_POLICY_URL,
] as const;

function webDocumentIdentity(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;

    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    return `${url.origin}${pathname}`;
  } catch {
    return null;
  }
}

const ALLOWED_LEGAL_DOCUMENT_IDENTITIES = new Set(
  ALLOWED_LEGAL_DOCUMENT_URLS.map(webDocumentIdentity).filter(
    (value): value is string => value !== null,
  ),
);

export function isLegalDocumentUrl(value: string): boolean {
  const identity = webDocumentIdentity(value);
  return identity !== null && ALLOWED_LEGAL_DOCUMENT_IDENTITIES.has(identity);
}
