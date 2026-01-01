export function mapEbaySummary(item: any) {
  const primary = item.image?.imageUrl || null;

  const additional =
    item.additionalImages?.map((img: any) => img?.imageUrl).filter(Boolean) || [];

  const imageUrls = [primary, ...additional].filter(Boolean);

  return {
    id: item.itemId,
    title: item.title,
    price: item.price?.value,
    currency: item.price?.currency,

    condition: item.condition,

    url: item.itemWebUrl,

    // keep existing fields (UI)
    image: primary,
    additionalImages: additional,

    // ✅ add what your AI expects
    imageUrls,

    seller: item.seller?.username,
    feedback: item.seller?.feedbackPercentage,
    score: item.seller?.feedbackScore,

    sellerAccountType: item.seller?.sellerAccountType,

    marketingPrice: {
      originalPrice: item.marketingPrice?.originalPrice?.value,
      discountPercentage: item.marketingPrice?.discountPercentage,
    },

    shippingOptions: item.shippingOptions || [],
    buyingOptions: item.buyingOptions || [],

    description: item.shortDescription || "",
  };
}
