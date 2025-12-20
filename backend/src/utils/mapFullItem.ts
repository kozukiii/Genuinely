export function mapFullItem(item: any) {
  return {
    fullDescription: item.description || "",
    itemSpecifics: item.localizedAspects || [],
    authenticity: item.authenticityGuarantee || null,
    returnPolicy: item.returnTerms || null,
    fullShippingOptions: item.shippingOptions || [],
    deliveryOptions: item.deliveryOptions || [],
    paymentMethods: item.paymentMethods || [],
    pickupOptions: item.pickupOptions || [],
    handlingTime: item.handlingTime || null,

    images: [
      item.image?.imageUrl,
      ...(item.additionalImages?.map((img: any) => img.imageUrl) || [])
    ].filter(Boolean),

    rating: item.rating || null
  };
}
