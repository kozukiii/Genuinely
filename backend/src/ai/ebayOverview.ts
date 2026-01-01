import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

export async function analyzeListingWithImages(listing: any) {
  console.log("LISTING KEYS:", Object.keys(listing));
  console.log("listing.image:", listing.image);
  console.log("listing.additionalImages:", listing.additionalImages);
  console.log("listing.imageUrls:", listing.imageUrls);

  console.log("IMAGE URLS:", listing.imageUrls);
  console.log(
    "IMAGE COUNT:",
    Array.isArray(listing.imageUrls) ? listing.imageUrls.length : "not an array"
  );

  const messages: any[] = [
    {
      role: "system",
      content: `
You are an expert AI specializing in evaluating online marketplace listings.

🎯 Your job:
Analyze the listing and produce *numeric scores* for the following categories ONLY:

- priceFairness (0–100) *compare to recent similar listings*
- sellerTrust (0–100) *based on feedback score and number of ratings*
- conditionHonesty (0–100) *does the description match images, and do they both match the stated condition*
- shippingFairness (0–100) *is the shipping price reasonable for the item and location*
- descriptionQuality (0–100) *is the description detailed, accurate, and well-written*

These should follow a reverse bell-curve:  
• Most items → High or low.   
• Rarely 50s unless justified.
IMPORTANT:
If shipping is free, automatically give full points (100) for shippingFairness.  
If the seller has excellent feedback (99%+) and many ratings (1000+), automatically give full points (100) for sellerTrust.

If any field that is undefined or missing due to API limitations that is not absolutely critical, treat that field as NEUTRAL (no deduction, no reward). Only evaluate based on information that IS present.
Missing data should NEVER lower a score, unless it is a critical field such as description or seller ratings.
ALWAYS INCLUDE A DESCRIPTION OF THE IMAGES IN THE OVERVIEW SECTION (unless none were provided, then state that)

🎯 Output Format **MUST ALWAYS BE EXACTLY LIKE THIS**:

{
  "scores": {
    "priceFairness": <number>,
    "sellerTrust": <number>,
    "conditionHonesty": <number>,
    "shippingFairness": <number>,
    "descriptionQuality": <number>
  },
  "overview": "Short reasoning paragraph here."
  
}

After that JSON block, output:

DEBUG INFO:
<Only the raw fields the user sent>

‼️ DO NOT include any scoring numbers inside the overview text.  
‼️ DO NOT add extra fields to the JSON.  
‼️ DO NOT wrap JSON in backticks.  
`,
    },

    {
      role: "user",
      content: [
        { type: "text", text: `Title: ${listing.title}` },
        { type: "text", text: `Price: ${listing.price} ${listing.currency}` },

        { type: "text", text: `Seller: ${listing.seller}` },
        {
          type: "text",
          text: `Feedback: ${listing.feedback}% (${listing.score} ratings)`,
        },

        { type: "text", text: `Condition: ${listing.condition}` },
        {
          type: "text",
          text: `Condition Descriptor: ${listing.conditionDescriptor}`,
        },

        {
          type: "text",
          text: `Item Location: ${listing.itemLocation?.city}, ${listing.itemLocation?.stateOrProvince}, ${listing.itemLocation?.country}`,
        },

        {
          type: "text",
          text: `Buying Options: ${listing.buyingOptions?.join(", ")}`,
        },
        {
          type: "text",
          text: `Shipping Options: ${JSON.stringify(listing.shippingOptions)}`,
        },

        {
          type: "text",
          text: `Original Price: ${
            listing.marketingPrice?.originalPrice ?? "N/A"
          }`,
        },
        {
          type: "text",
          text: `Discount: ${
            listing.marketingPrice?.discountPercentage ?? "N/A"
          }%`,
        },

        { type: "text", text: `Short Description: ${listing.description}` },
        { type: "text", text: `Listing URL: ${listing.link}` },
        {
          type: "text",
          text: `Images Provided: ${
            Array.isArray(listing.imageUrls) ? listing.imageUrls.length : 0
          }`,
        },
      ],
    },
  ];

  // Attach all images (explicit multi-image support)
  if (Array.isArray(listing.imageUrls) && listing.imageUrls.length) {
    for (const url of listing.imageUrls) {
      if (typeof url !== "string" || !url.trim()) continue;

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
    max_tokens: 1000,
    temperature: 0.2,
  });

  return response.choices[0].message.content?.trim() || "No analysis.";
}
