export function mapEbaySummary(item: any) {
  return {
    id: item.itemId,
    title: item.title,
    price: item.price?.value,
    currency: item.price?.currency,

    condition: item.condition,
    conditionDescriptor: item.conditionDescriptor,

    url: item.itemWebUrl,

    image: item.image?.imageUrl,
    additionalImages: item.additionalImages?.map((img: any) => img.imageUrl) || [],

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
    itemLocation: item.itemLocation || {},

    description: item.shortDescription || ""
  };
}
