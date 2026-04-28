import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import fetch from "node-fetch";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { HttpsProxyAgent } = require("https-proxy-agent");

dotenv.config({ quiet: true });

const GRAPHQL_URL = "https://www.facebook.com/api/graphql/";
const FB_DESKTOP_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

const MARKETPLACE_PDP_CONTAINER_DOC_ID = "26924013917190310";
const MARKETPLACE_PDP_MEDIA_DOC_ID = "10059604367394414";

const MARKETPLACE_PDP_RELAY_PROVIDERS = {
  "__relay_internal__pv__ShouldUpdateMarketplaceBoostListingBoostedStatusrelayprovider": false,
  "__relay_internal__pv__CometUFISingleLineUFIrelayprovider": false,
  "__relay_internal__pv__CometUFIShareActionMigrationrelayprovider": true,
  "__relay_internal__pv__CometUFIReactionsEnableShortNamerelayprovider": false,
  "__relay_internal__pv__CometUFICommentAutoTranslationTyperelayprovider": "ORIGINAL",
  "__relay_internal__pv__CometUFICommentAvatarStickerAnimatedImagerelayprovider": false,
  "__relay_internal__pv__CometUFICommentActionLinksRewriteEnabledrelayprovider": false,
  "__relay_internal__pv__IsWorkUserrelayprovider": false,
  "__relay_internal__pv__GHLShouldChangeSponsoredDataFieldNamerelayprovider": false,
  "__relay_internal__pv__GHLShouldChangeAdIdFieldNamerelayprovider": false,
  "__relay_internal__pv__CometUFI_dedicated_comment_routable_dialog_gkrelayprovider": true,
};

type GraphqlResult = {
  friendlyName: string;
  docId: string;
  status: number;
  statusText: string;
  json: unknown;
  textPreview?: string;
};

type ImageCandidate = {
  source: "container" | "media";
  path: string;
  key: string;
  url: string;
  urlWithoutQuery: string;
};

type BranchSummary = {
  source: "container" | "media";
  path: string;
  keys: string[];
};

const proxyUrls = process.env.PROXY_URL
  ? process.env.PROXY_URL.split(",").map((s) => s.trim()).filter(Boolean)
  : [];

function parseArgs(argv: string[]) {
  const flags = new Set(argv.filter((arg) => arg.startsWith("--")));
  const listingId = argv.find((arg) => !arg.startsWith("--"));

  return {
    listingId,
    stdout: flags.has("--stdout"),
    withCookies: flags.has("--with-cookies"),
  };
}

function getProxyAgent() {
  if (proxyUrls.length === 0) return undefined;
  const url = proxyUrls[Math.floor(Math.random() * proxyUrls.length)];
  return new HttpsProxyAgent(url);
}

function buildFacebookCookie() {
  const cookieParts = [
    ["c_user", process.env.FB_C_USER],
    ["xs", process.env.FB_XS],
    ["datr", process.env.FB_DATR],
    ["sb", process.env.FB_SB],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));

  return cookieParts.map(([key, value]) => `${key}=${value}`).join("; ");
}

function makeHeaders(listingId: string, friendlyName: string, withCookies: boolean) {
  const headers: Record<string, string> = {
    "user-agent": FB_DESKTOP_USER_AGENT,
    "content-type": "application/x-www-form-urlencoded",
    "accept": "*/*",
    "accept-language": "en-US,en;q=0.9",
    "x-fb-friendly-name": friendlyName,
    "referer": `https://www.facebook.com/marketplace/item/${listingId}/`,
    "origin": "https://www.facebook.com",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
  };

  const cookie = withCookies ? buildFacebookCookie() : "";
  if (cookie) headers.cookie = cookie;

  return headers;
}

async function makeGraphqlRequest(
  listingId: string,
  docId: string,
  friendlyName: string,
  variables: Record<string, unknown>,
  withCookies: boolean,
): Promise<GraphqlResult> {
  const body = new URLSearchParams({
    variables: JSON.stringify(variables),
    doc_id: docId,
    server_timestamps: "true",
    fb_api_caller_class: "RelayModern",
    fb_api_req_friendly_name: friendlyName,
  });

  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: makeHeaders(listingId, friendlyName, withCookies),
    body,
    ...(proxyUrls.length ? { agent: getProxyAgent() } : {}),
  } as any);

  const text = await res.text();
  let json: unknown = null;
  let textPreview: string | undefined;

  try {
    json = JSON.parse(text);
  } catch {
    textPreview = text.slice(0, 1000);
  }

  return {
    friendlyName,
    docId,
    status: res.status,
    statusText: res.statusText,
    json,
    textPreview,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function redact(value: unknown, key = ""): unknown {
  if (/^(cookie|authorization|access_token|token|secret|password|fb_dtsg|lsd|c_user|xs|datr|sb)$/i.test(key)) {
    return "[redacted]";
  }

  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }

  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([childKey, childValue]) => [childKey, redact(childValue, childKey)])
  );
}

function formatPath(parts: Array<string | number>): string {
  return parts.reduce<string>((acc, part) => {
    if (typeof part === "number") return `${acc}[${part}]`;
    return acc ? `${acc}.${part}` : String(part);
  }, "");
}

function decodeUrlishString(value: string) {
  return value
    .replace(/\\u0025/g, "%")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&");
}

function collectImageCandidates(
  value: unknown,
  source: "container" | "media",
  parts: Array<string | number> = [],
  out: ImageCandidate[] = [],
) {
  if (typeof value === "string") {
    const url = decodeUrlishString(value.trim());
    if (url.startsWith("http") && /(?:scontent|fbcdn|fbsbx)/i.test(url)) {
      out.push({
        source,
        path: formatPath(parts),
        key: String(parts.length ? parts[parts.length - 1] : ""),
        url,
        urlWithoutQuery: url.split("?")[0],
      });
    }
    return out;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => collectImageCandidates(item, source, [...parts, index], out));
    return out;
  }

  if (isRecord(value)) {
    for (const [childKey, childValue] of Object.entries(value)) {
      collectImageCandidates(childValue, source, [...parts, childKey], out);
    }
  }

  return out;
}

function collectMediaBranches(
  value: unknown,
  source: "container" | "media",
  parts: Array<string | number> = [],
  out: BranchSummary[] = [],
) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectMediaBranches(item, source, [...parts, index], out));
    return out;
  }

  if (!isRecord(value)) {
    return out;
  }

  const currentPath = formatPath(parts);
  if (/(image|photo|media|viewer|gallery|listing_photos|product_item)/i.test(currentPath)) {
    out.push({
      source,
      path: currentPath || "(root)",
      keys: Object.keys(value).slice(0, 40),
    });
  }

  for (const [childKey, childValue] of Object.entries(value)) {
    collectMediaBranches(childValue, source, [...parts, childKey], out);
  }

  return out;
}

function getDetailsPage(json: unknown) {
  return (json as any)?.data?.viewer?.marketplace_product_details_page ?? null;
}

function uniqueByUrl(candidates: ImageCandidate[]) {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.urlWithoutQuery)) return false;
    seen.add(candidate.urlWithoutQuery);
    return true;
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.listingId || !/^\d+$/.test(args.listingId)) {
    console.error("Usage: npm run debug:marketplace -- <facebook-listing-id> [--stdout] [--with-cookies]");
    process.exit(1);
  }

  const containerVars = {
    targetId: args.listingId,
    feedLocation: "MARKETPLACE_MEGAMALL",
    feedbackSource: 56,
    scale: 1,
    useDefaultActor: false,
    enableJobEmployerActionBar: false,
    enableJobSeekerActionBar: false,
    referralCode: null,
    referralSurfaceString: null,
    ...MARKETPLACE_PDP_RELAY_PROVIDERS,
  };

  const [container, media] = await Promise.all([
    makeGraphqlRequest(
      args.listingId,
      MARKETPLACE_PDP_CONTAINER_DOC_ID,
      "MarketplacePDPContainerQuery",
      containerVars,
      args.withCookies,
    ),
    makeGraphqlRequest(
      args.listingId,
      MARKETPLACE_PDP_MEDIA_DOC_ID,
      "MarketplacePDPC2CMediaViewerWithImagesQuery",
      { targetId: args.listingId },
      args.withCookies,
    ),
  ]);

  const candidates = [
    ...collectImageCandidates(container.json, "container"),
    ...collectImageCandidates(media.json, "media"),
  ];
  const uniqueCandidates = uniqueByUrl(candidates);

  const output = {
    listingId: args.listingId,
    generatedAt: new Date().toISOString(),
    proxy: {
      proxyUrlCount: proxyUrls.length,
      usedFacebookCookies: args.withCookies && Boolean(buildFacebookCookie()),
    },
    responses: {
      container: {
        friendlyName: container.friendlyName,
        docId: container.docId,
        status: container.status,
        statusText: container.statusText,
        errors: (container.json as any)?.errors ?? null,
        hasDetailsPage: Boolean(getDetailsPage(container.json)),
        textPreview: container.textPreview,
      },
      media: {
        friendlyName: media.friendlyName,
        docId: media.docId,
        status: media.status,
        statusText: media.statusText,
        errors: (media.json as any)?.errors ?? null,
        hasDetailsPage: Boolean(getDetailsPage(media.json)),
        textPreview: media.textPreview,
      },
    },
    summary: {
      containerTargetKeys: Object.keys(getDetailsPage(container.json)?.target ?? {}),
      mediaTargetKeys: Object.keys(getDetailsPage(media.json)?.target ?? {}),
      imageCandidateCount: candidates.length,
      uniqueImageCandidateCount: uniqueCandidates.length,
    },
    imageCandidates: uniqueCandidates,
    mediaBranches: [
      ...collectMediaBranches(getDetailsPage(container.json), "container"),
      ...collectMediaBranches(getDetailsPage(media.json), "media"),
    ],
    raw: {
      container: redact(container.json),
      media: redact(media.json),
    },
  };

  const json = JSON.stringify(output, null, 2);

  if (args.stdout) {
    console.log(json);
    return;
  }

  const outDir = path.join(process.cwd(), ".cache", "marketplace-graphql");
  fs.mkdirSync(outDir, { recursive: true });

  const outPath = path.join(outDir, `${args.listingId}-${Date.now()}.json`);
  fs.writeFileSync(outPath, json);

  console.log(`Wrote ${outPath}`);
  console.log(`Container: HTTP ${container.status}, details=${Boolean(getDetailsPage(container.json))}`);
  console.log(`Media:     HTTP ${media.status}, details=${Boolean(getDetailsPage(media.json))}`);
  console.log(`Images:    ${uniqueCandidates.length} unique candidate URL(s)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
