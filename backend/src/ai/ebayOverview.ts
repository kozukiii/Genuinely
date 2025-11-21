import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

// ------------------------------------------------------
// ANALYZE LISTING WITH IMAGES — optimized for fast pipeline
// ------------------------------------------------------
export async function analyzeListingWithImage(listing: {
  title: string;
  price: string;
  currency: string;
  link: string;

  seller?: string;
  feedback?: string;
  score?: string;

  condition?: string;
  conditionDescriptor?: string;

  itemLocation?: {
    city?: string;
    stateOrProvince?: string;
    country?: string;
  };

  buyingOptions?: string[];
  shippingOptions?: any[];
  marketingPrice?: {
    originalPrice?: string;
    discountPercentage?: string;
  };

  description?: string;
  fullDescription?: string;

  imageUrl?: string | string[];
}) {
  const messages: any[] = [
    {
      role: "system",
      content: `You are an expert AI specializing in evaluating online marketplace listings.

Evaluate:
- price fairness
- seller trustworthiness
- condition honesty
- location risk
- shipping fairness
- whether the listing is likely a good deal overall

Output MUST follow this exact format:

(rating)/100 your reasoning text here...

At the bottom, include a small "DEBUG INFO" section containing ONLY the fields you were given.`,
    },

    {
      role: "user",
      content: [
        { type: "text", text: `Title: ${listing.title}` },
        { type: "text", text: `Price: ${listing.price} ${listing.currency}` },

        // Seller trust
        { type: "text", text: `Seller: ${listing.seller}` },
        { type: "text", text: `Feedback: ${listing.feedback}% (${listing.score} ratings)` },

        // Condition
        { type: "text", text: `Condition: ${listing.condition}` },
        { type: "text", text: `Condition Descriptor: ${listing.conditionDescriptor}` },

        // Location
        { type: "text", text: `Item Location: ${listing.itemLocation?.city || ""}, ${listing.itemLocation?.stateOrProvince || ""}, ${listing.itemLocation?.country || ""}` },

        // Buying & shipping
        { type: "text", text: `Buying Options: ${listing.buyingOptions?.join(", ")}` },
        { type: "text", text: `Shipping Options: ${JSON.stringify(listing.shippingOptions)}` },

        // Price metadata
        { type: "text", text: `Original Price: ${listing.marketingPrice?.originalPrice || "N/A"}` },
        { type: "text", text: `Discount: ${listing.marketingPrice?.discountPercentage || "N/A"}%` },

        // Descriptions
        { type: "text", text: `Short Description: ${listing.description}` },
        { type: "text", text: `Full Description: ${listing.fullDescription}` },

        // Link
        { type: "text", text: `Listing URL: ${listing.link}` },
      ],
    },
  ];

  // Attach images (all available images)
  if (listing.imageUrl) {
    const imgs = Array.isArray(listing.imageUrl)
      ? listing.imageUrl
      : [listing.imageUrl];

    for (const url of imgs) {
      messages[1].content.push({
        type: "image_url",
        image_url: { url },
      });
    }
  }

  // GPT call
  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages,
    max_tokens: 550,
    temperature: 0.2,
  });

  return response.choices[0].message.content?.trim() || "No analysis.";
}
