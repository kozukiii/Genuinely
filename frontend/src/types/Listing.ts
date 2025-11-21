export interface Listing {
  id: string;
  title: string;
  price: string;
  condition: string;
  url: string;
  image?: string;
  seller?: string;
  feedback?: string;
  score?: number;
  aiScore?: number;
  overview?: string;
}
