import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

type ListingLocation = {
  city?: string;
  stateOrProvince?: string;
  country?: string;
};

type ListingForAnalysis = {
  id: string;
  title: string;
  price: string | number;
  currency: string;
  link: string;

  seller?: string;
  feedback?: string;
  score?: string;

  condition?: string;
  conditionDescriptor?: string;

  itemLocation?: ListingLocation;

  buyingOptions?: string[];
  shippingOptions?: any[];
  marketingPrice?: {
    originalPrice?: string | number;
    discountPercentage?: string | number;
  };

  description?: string;
  fullDescription?: string;

  imageUrl?: string | string[];
};

type ListingAnalysisResult = {
  id: string;
  rating: number;
  reason: string;
  debugInfo: Record<string, unknown>;
};

function buildUserContent(listings: ListingForAnalysis[]) {
  const content: any[] = [];

  listings.forEach((listing, index) => {
    content.push({ type: "text", text: `Listing ${index + 1} (id: ${listing.id})` });
    content.push({ type: "text", text: `Title: ${listing.title}` });
    content.push({ type: "text", text: `Price: ${listing.price} ${listing.currency}` });

    // Seller trust
    content.push({ type: "text", text: `Seller: ${listing.seller}` });
    content.push({
      type: "text",
      text: `Feedback: ${listing.feedback}% (${listing.score} ratings)`,
    });

    // Condition
    content.push({ type: "text", text: `Condition: ${listing.condition}` });
    content.push({
      type: "text",
      text: `Condition Descriptor: ${listing.conditionDescriptor}`,
    });

    // Location
    content.push({
      type: "text",
      text: `Item Location: ${listing.itemLocation?.city || ""}, ${listing.itemLocation?.stateOrProvince || ""}, ${listing.itemLocation?.country || ""}`,
    });

    // Buying & shipping
    content.push({ type: "text", text: `Buying Options: ${listing.buyingOptions?.join(", ")}` });
    content.push({
      type: "text",
      text: `Shipping Options: ${JSON.stringify(listing.shippingOptions)}`,
    });

    // Price metadata
    content.push({
      type: "text",
      text: `Original Price: ${listing.marketingPrice?.originalPrice || "N/A"}`,
    });
    content.push({
      type: "text",
      text: `Discount: ${listing.marketingPrice?.discountPercentage || "N/A"}%`,
    });

    // Descriptions
    content.push({ type: "text", text: `Short Description: ${listing.description}` });
    content.push({ type: "text", text: `Full Description: ${listing.fullDescription}` });

    // Link
    content.push({ type: "text", text: `Listing URL: ${listing.link}` });

    if (listing.imageUrl) {
      const imgs = Array.isArray(listing.imageUrl) ? listing.imageUrl : [listing.imageUrl];
      for (const url of imgs) {
        content.push({
          type: "image_url",
          image_url: { url },
        });
      }
    }
  });

  return content;
}

function buildSystemPrompt(listingsCount: number) {
  return `You are an expert AI specializing in evaluating online marketplace listings.

Evaluate:
- price fairness
- seller trustworthiness
- condition honesty
- location risk
- shipping fairness
- whether the listing is likely a good deal overall

If the listing is going to be rated above 80/100, check to see if they have >99% positive feedback and a high volume of ratings (1000+). If they do, promote to 100/100.
Follow a bell curve type of rating system where most listings are average (50-70) and only a few are excellent (>90) or terrible (<30).

Return ONLY a JSON array with ${listingsCount} objects. Each object must include:
- "id": the listing id that was provided
- "rating": a number from 0-100
- "reason": brief reasoning for the score
- "debugInfo": the fields you were given for that listing

Do not include any additional commentary or formatting outside of the JSON array.`;
}

// ------------------------------------------------------
// ANALYZE MULTIPLE LISTINGS WITH IMAGES
// ------------------------------------------------------
export async function analyzeListingsWithImages(
  listings: ListingForAnalysis[]
): Promise<ListingAnalysisResult[]> {
  if (!listings.length) return [];

  const messages: any[] = [
    {
      role: "system",
      content: buildSystemPrompt(listings.length),
    },
    {
      role: "user",
      content: buildUserContent(listings),
    },
  ];

  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages,
    max_tokens: 600 * listings.length,
    temperature: 0.2,
  });

  const raw = response.choices[0].message.content?.trim() || "[]";

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed as ListingAnalysisResult[];
    }
  } catch (err) {
    console.error("Failed to parse AI response", err);
  }

  return [];
}

// ------------------------------------------------------
// Legacy single-listing wrapper for compatibility
// ------------------------------------------------------
export async function analyzeListingWithImage(listing: ListingForAnalysis) {
  const [result] = await analyzeListingsWithImages([listing]);
  return result;
}

