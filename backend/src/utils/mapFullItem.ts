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
    fullImages: item.additionalImages?.map((img: any) => img.imageUrl) || [],
    rating: item.rating || null
  };
}
