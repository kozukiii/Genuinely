import fetch from "node-fetch";

const GRAPHQL_URL = "https://www.facebook.com/api/graphql/";

async function getLatLng(location: string) {
  const body = new URLSearchParams({
    variables: JSON.stringify({
      params: {
        caller: "MARKETPLACE",
        page_category: ["CITY", "SUBCITY", "NEIGHBORHOOD", "POSTAL_CODE"],
        query: location,
      },
    }),
    doc_id: "5585904654783609",
  });

  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "user-agent": "Mozilla/5.0",
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const json = await res.json();

  const first =
    json?.data?.city_street_search?.street_results?.edges?.[0]?.node;

  return {
    lat: first?.location?.latitude,
    lng: first?.location?.longitude,
  };
}

function extractMarketplaceImages(listing: any): string[] {
  const urls = new Set<string>();

  const pushIfValid = (url: any) => {
    if (typeof url === "string" && url.trim().startsWith("http")) {
      urls.add(url.trim());
    }
  };

  pushIfValid(listing?.primary_listing_photo?.image?.uri);

  const possibleArrays = [
    listing?.listing_photos,
    listing?.photos,
    listing?.all_photos,
    listing?.additional_photos,
    listing?.media,
    listing?.images,
  ];

  for (const arr of possibleArrays) {
    if (!Array.isArray(arr)) continue;

    for (const item of arr) {
      pushIfValid(item?.image?.uri);
      pushIfValid(item?.uri);
      pushIfValid(item?.url);
    }
  }

  return Array.from(urls);
}

export async function searchMarketplaceListings({
  query,
  location,
  limit = 10,
}: {
  query: string;
  location: string;
  limit?: number;
}) {
  const { lat, lng } = await getLatLng(location);

  if (lat == null || lng == null) {
    throw new Error("Location lookup failed");
  }

  const variables = {
    count: limit,
    params: {
      bqf: {
        callsite: "COMMERCE_MKTPLACE_WWW",
        query,
      },
      browse_request_params: {
        filter_location_latitude: lat,
        filter_location_longitude: lng,
        filter_radius_km: 16,
      },
      custom_request_params: {
        surface: "SEARCH",
      },
    },
  };

  const body = new URLSearchParams({
    variables: JSON.stringify(variables),
    doc_id: "7111939778879383",
  });

  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "user-agent": "Mozilla/5.0",
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const json = await res.json();

  const edges = json?.data?.marketplace_search?.feed_units?.edges ?? [];
  console.dir(edges?.[0]?.node?.listing, { depth: null });

  return edges.map((edge: any) => {
    const listing = edge?.node?.listing;

    return {
      id: String(listing?.id ?? ""),
      source: "marketplace",
      title: listing?.marketplace_listing_title ?? "Untitled listing",
      price: Number(
        String(listing?.listing_price?.formatted_amount ?? "0").replace(
          /[^0-9.]/g,
          ""
        ) || 0
      ),
      currency: "USD",
      url: listing?.id
        ? `https://www.facebook.com/marketplace/item/${listing.id}`
        : "",
      images: extractMarketplaceImages(listing),
      location: [
        listing?.location?.reverse_geocode?.city,
        listing?.location?.reverse_geocode?.state,
      ]
        .filter(Boolean)
        .join(", "),
      is_live: listing?.is_live ?? false,
      is_pending: listing?.is_pending ?? false,
      is_sold: listing?.is_sold ?? false,
      delivery_types: Array.isArray(listing?.delivery_types)
        ? listing.delivery_types
        : [],
      raw: listing,
    };
  });
}

export const searchMarketplaceNormalized = searchMarketplaceListings;