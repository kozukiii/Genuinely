import ListingCard from "../components/ListingCard";
import type { Listing } from "../types/Listing";
import "../pages/styles/HomePage.css";

const DEMO_LISTINGS: Listing[] = [
  {
    // GREAT — price below market low
    id: "demo-1", source: "ebay", title: "Sony WH-1000XM5 Wireless Noise Canceling Headphones", price: 279,
    currency: "USD", condition: "Like New", url: "#", seller: "audio_depot_us", feedback: "99.8",
    images: ["https://placehold.co/900x900/0b1020/0b1020"],
    aiScore: 100, shippingPrice: 0, priceLow: 320, priceHigh: 410,
    aiScores: { priceFairness: 100, sellerTrust: 100, conditionHonesty: 100, shippingFairness: 100, descriptionQuality: 100 },
    highlights: [
      { label: "Original carrying case included", positive: true },
      { label: "All original accessories present", positive: true },
      { label: "No visible wear on ear cushions", positive: true },
      { label: "Charging cable included", positive: true },
      { label: "Noise canceling tested and working", positive: true },
    ],
  },
  {
    // GOOD — at or below midpoint
    id: "demo-2", source: "marketplace", title: "Apple MacBook Pro 14\" M3 Pro — Space Black", price: 1649,
    currency: "USD", condition: "Excellent", url: "#", location: "Austin, TX",
    delivery_types: ["LOCAL_PICKUP", "SHIPPING"],
    images: ["https://placehold.co/900x900/101826/101826"],
    aiScore: 100, priceLow: 1500, priceHigh: 2100,
    aiScores: { priceFairness: 88, sellerTrust: 100, conditionHonesty: 100, shippingFairness: 100, descriptionQuality: 100 },
    highlights: [
      { label: "Original box and charger included", positive: true },
      { label: "No scratches on screen or body", positive: true },
      { label: "Battery health at 97%", positive: true },
      { label: "AppleCare+ transferable until 2026", positive: true },
      { label: "Never used for gaming or heavy rendering", positive: true },
    ],
  },
  {
    // FAIR — above midpoint, within range
    id: "demo-3", source: "ebay", title: "Lego Technic Bugatti Chiron 42083 — Complete, Retired", price: 319,
    currency: "USD", condition: "Used", url: "#", seller: "brickmaster_shop", feedback: "100",
    images: ["https://placehold.co/900x900/162033/162033"],
    aiScore: 100, shippingPrice: 0, priceLow: 240, priceHigh: 380,
    aiScores: { priceFairness: 72, sellerTrust: 100, conditionHonesty: 100, shippingFairness: 100, descriptionQuality: 100 },
    highlights: [
      { label: "All pieces accounted for", positive: true },
      { label: "Original instructions included", positive: true },
      { label: "Original box included", positive: true },
      { label: "No broken or discolored bricks", positive: true },
      { label: "Retired set — no longer in production", positive: true },
    ],
  },
  {
    // HIGH — above market high
    id: "demo-4", source: "marketplace", title: "Nike Air Jordan 1 Retro High OG 'Chicago' sz 11", price: 290,
    currency: "USD", condition: "Good", url: "#", location: "Chicago, IL",
    delivery_types: ["LOCAL_PICKUP"],
    images: ["https://placehold.co/900x900/1a1a2e/1a1a2e"],
    aiScore: 100, priceLow: 190, priceHigh: 270,
    aiScores: { priceFairness: 38, sellerTrust: 100, conditionHonesty: 100, shippingFairness: 100, descriptionQuality: 100 },
    highlights: [
      { label: "Original box included", positive: true },
      { label: "Soles show light wear only", positive: true },
      { label: "No creasing on toe box", positive: true },
      { label: "Laces replaced with clean pair", positive: true },
      { label: "Authentication tag intact", positive: true },
    ],
  },
  {
    // RISKY — price < 50% of market low (699 < 1500*0.5=750) ✓
    id: "demo-5", source: "ebay", title: "NVIDIA RTX 4070 Ti Super Founders Edition 16GB", price: 699,
    currency: "USD", condition: "New", url: "#", seller: "techgear_direct", feedback: "99.4",
    images: ["https://placehold.co/900x900/0f2040/0f2040"],
    aiScore: 100, shippingPrice: 0, priceLow: 1500, priceHigh: 1850,
    aiScores: { priceFairness: 0, sellerTrust: 100, conditionHonesty: 100, shippingFairness: 100, descriptionQuality: 100 },
    highlights: [
      { label: "Factory sealed in original box", positive: true },
      { label: "Full manufacturer warranty active", positive: true },
      { label: "Never installed or benchmarked", positive: true },
      { label: "All accessories and adapters included", positive: true },
    ],
  },
  {
    // GREAT — price below market low
    id: "demo-6", source: "marketplace", title: "Patagonia Down Sweater Jacket Men's Large — Navy", price: 89,
    currency: "USD", condition: "Good", url: "#", location: "Denver, CO",
    delivery_types: ["SHIPPING"],
    images: ["https://placehold.co/900x900/0a1628/0a1628"],
    aiScore: 100, priceLow: 120, priceHigh: 175,
    aiScores: { priceFairness: 100, sellerTrust: 100, conditionHonesty: 100, shippingFairness: 100, descriptionQuality: 100 },
    highlights: [
      { label: "Small snag on left sleeve", positive: false },
      { label: "No rips, tears, or bald spots", positive: true },
      { label: "Zipper and snaps fully functional", positive: true },
      { label: "Professionally cleaned before listing", positive: true },
    ],
  },
  {
    // GOOD — at or below midpoint (low:11500, high:15000 → mid:13250, price:12800 ≤ 13250) ✓
    id: "demo-7", source: "ebay", title: "Rolex Submariner Date 116610LN Stainless Steel", price: 12800,
    currency: "USD", condition: "Very Good", url: "#", seller: "prestige_timepieces", feedback: "99.9",
    images: ["https://placehold.co/900x900/111827/111827"],
    aiScore: 100, shippingPrice: 0, priceLow: 11500, priceHigh: 15000,
    aiScores: { priceFairness: 85, sellerTrust: 100, conditionHonesty: 100, shippingFairness: 100, descriptionQuality: 100 },
    highlights: [
      { label: "Original box and papers included", positive: true },
      { label: "Serviced by Rolex AD in 2023", positive: true },
      { label: "Crystal scratch-free", positive: true },
      { label: "Bracelet links and clasp tight", positive: true },
      { label: "Verified authentic — serial confirmed", positive: true },
    ],
  },
  {
    // GREAT — price below market low
    id: "demo-8", source: "marketplace", title: "Nintendo Switch OLED — White + 4 Games Bundle", price: 245,
    currency: "USD", condition: "Like New", url: "#", location: "Seattle, WA",
    delivery_types: ["LOCAL_PICKUP", "SHIPPING"],
    images: ["https://placehold.co/900x900/161d2d/161d2d"],
    aiScore: 100, priceLow: 290, priceHigh: 360,
    aiScores: { priceFairness: 100, sellerTrust: 100, conditionHonesty: 100, shippingFairness: 100, descriptionQuality: 100 },
    highlights: [
      { label: "Original box and dock included", positive: true },
      { label: "Screen protector applied since day one", positive: true },
      { label: "No Joy-Con drift", positive: true },
      { label: "4 physical game cartridges included", positive: true },
      { label: "Charger and HDMI cable included", positive: true },
    ],
  },
  {
    // FAIR — above midpoint, within range (low:1800, high:2400 → mid:2100, price:2149 > 2100 ≤ 2400) ✓
    id: "demo-9", source: "ebay", title: "Canon EOS R6 Mark II Body Only — Low Shutter Count", price: 2149,
    currency: "USD", condition: "Used", url: "#", seller: "lens_legends_usa", feedback: "99.6",
    images: ["https://placehold.co/900x900/0c1a30/0c1a30"],
    aiScore: 100, shippingPrice: 0, priceLow: 1800, priceHigh: 2400,
    aiScores: { priceFairness: 68, sellerTrust: 100, conditionHonesty: 100, shippingFairness: 100, descriptionQuality: 100 },
    highlights: [
      { label: "Minor wear on grip rubber", positive: false },
      { label: "Shutter count under 3,000", positive: true },
      { label: "Sensor clean — no dust spots", positive: true },
      { label: "Original box and strap included", positive: true },
      { label: "Two batteries and dual charger included", positive: true },
    ],
  },
  {
    // HIGH — above market high
    id: "demo-10", source: "marketplace", title: "Peloton Bike+ with Weights, Mat & Shoes — Barely Used", price: 1100,
    currency: "USD", condition: "Excellent", url: "#", location: "Brooklyn, NY",
    delivery_types: ["LOCAL_PICKUP"],
    images: ["https://placehold.co/900x900/12202e/12202e"],
    aiScore: 100, priceLow: 700, priceHigh: 1000,
    aiScores: { priceFairness: 30, sellerTrust: 100, conditionHonesty: 100, shippingFairness: 100, descriptionQuality: 100 },
    highlights: [
      { label: "Subscription not included", positive: false },
      { label: "Under 50 total rides logged", positive: true },
      { label: "Weights, mat, and shoes included", positive: true },
      { label: "Belt drive and resistance smooth", positive: true },
    ],
  },
  {
    // GREAT — price below market low
    id: "demo-11", source: "ebay", title: "Pokemon 1st Edition Base Set Charizard PSA 9", price: 4750,
    currency: "USD", condition: "Very Good", url: "#", seller: "graded_cards_co", feedback: "100",
    images: ["https://placehold.co/900x900/0e1c2e/0e1c2e"],
    aiScore: 100, shippingPrice: 0, priceLow: 5200, priceHigh: 6800,
    aiScores: { priceFairness: 100, sellerTrust: 100, conditionHonesty: 100, shippingFairness: 100, descriptionQuality: 100 },
    highlights: [
      { label: "PSA 9 — Mint grade", positive: true },
      { label: "1st Edition stamp confirmed authentic", positive: true },
      { label: "Slab in perfect condition — no cracks", positive: true },
      { label: "Cert number verified on PSA registry", positive: true },
    ],
  },
  {
    // GOOD — at or below midpoint (low:600, high:950 → mid:775, price:699 ≤ 775) ✓
    id: "demo-12", source: "marketplace", title: "Herman Miller Aeron Chair Size B — Fully Loaded", price: 699,
    currency: "USD", condition: "Good", url: "#", location: "San Francisco, CA",
    delivery_types: ["LOCAL_PICKUP"],
    images: ["https://placehold.co/900x900/141f30/141f30"],
    aiScore: 100, priceLow: 600, priceHigh: 950,
    aiScores: { priceFairness: 82, sellerTrust: 100, conditionHonesty: 100, shippingFairness: 100, descriptionQuality: 100 },
    highlights: [
      { label: "Armrests show light surface scuffs", positive: false },
      { label: "Mesh in excellent condition — no sagging", positive: true },
      { label: "All adjustments fully functional", positive: true },
      { label: "PostureFit SL lumbar support included", positive: true },
      { label: "Disassembles for easy transport", positive: true },
    ],
  },
  {
    // RISKY — price < 50% of market low (199 < 420*0.5=210) ✓
    id: "demo-13", source: "ebay", title: "Yeti Tundra 45 Cooler — Desert Tan, Barely Used", price: 199,
    currency: "USD", condition: "Like New", url: "#", seller: "outdoor_finds_us", feedback: "99.7",
    images: ["https://placehold.co/900x900/0d1a28/0d1a28"],
    aiScore: 100, shippingPrice: 0, priceLow: 420, priceHigh: 540,
    aiScores: { priceFairness: 0, sellerTrust: 100, conditionHonesty: 100, shippingFairness: 100, descriptionQuality: 100 },
    highlights: [
      { label: "No dents, scratches, or fading", positive: true },
      { label: "Lid gasket seals perfectly", positive: true },
      { label: "Dry ice compatible", positive: true },
      { label: "Tie-down slots intact", positive: true },
    ],
  },
  {
    // FAIR — above midpoint, within range
    id: "demo-14", source: "marketplace", title: "DJI Mini 4 Pro Fly More Combo + RC 2 Controller", price: 749,
    currency: "USD", condition: "Like New", url: "#", location: "Los Angeles, CA",
    delivery_types: ["SHIPPING", "LOCAL_PICKUP"],
    images: ["https://placehold.co/900x900/101826/101826"],
    aiScore: 100, priceLow: 600, priceHigh: 860,
    aiScores: { priceFairness: 70, sellerTrust: 100, conditionHonesty: 100, shippingFairness: 100, descriptionQuality: 100 },
    highlights: [
      { label: "Under 10 flights logged", positive: true },
      { label: "All propellers unmarked", positive: true },
      { label: "3 batteries included", positive: true },
      { label: "RC 2 controller with screen included", positive: true },
      { label: "Original box and carrying bag included", positive: true },
    ],
  },
  {
    // GOOD — at or below midpoint (low:520, high:800 → mid:660, price:589 ≤ 660) ✓
    id: "demo-15", source: "ebay", title: "Callaway Apex Pro 21 Iron Set 4-PW — Stiff", price: 589,
    currency: "USD", condition: "Very Good", url: "#", seller: "fairway_pro_shop", feedback: "99.5",
    images: ["https://placehold.co/900x900/0b1520/0b1520"],
    aiScore: 100, shippingPrice: 0, priceLow: 520, priceHigh: 800,
    aiScores: { priceFairness: 80, sellerTrust: 100, conditionHonesty: 100, shippingFairness: 100, descriptionQuality: 100 },
    highlights: [
      { label: "Headcovers not included", positive: false },
      { label: "Grips replaced recently", positive: true },
      { label: "Faces show normal wear — no deep grooves", positive: true },
      { label: "Stock True Temper shafts in good shape", positive: true },
      { label: "Full set 4 through PW", positive: true },
    ],
  },
  {
    // FAIR — above midpoint, within range
    id: "demo-16", source: "marketplace", title: "Sonos Arc Soundbar — Black, Original Box", price: 479,
    currency: "USD", condition: "Excellent", url: "#", location: "Portland, OR",
    delivery_types: ["LOCAL_PICKUP", "SHIPPING"],
    images: ["https://placehold.co/900x900/0f1d2c/0f1d2c"],
    aiScore: 100, priceLow: 360, priceHigh: 560,
    aiScores: { priceFairness: 66, sellerTrust: 100, conditionHonesty: 100, shippingFairness: 100, descriptionQuality: 100 },
    highlights: [
      { label: "Original box, remote, and HDMI cable included", positive: true },
      { label: "No fabric tears or discoloration", positive: true },
      { label: "Dolby Atmos working perfectly", positive: true },
      { label: "Linked to Sonos app — easy to reset", positive: true },
    ],
  },
];

export default function SearchPageDemo() {
  return (
    <div className="home-page">
      <div style={{ padding: "2rem 2rem 0.5rem", display: "flex", alignItems: "baseline", gap: "0.75rem" }}>
        <h1 style={{ fontSize: "1.25rem", fontWeight: 700, color: "var(--text-primary)", margin: 0 }}>
          Search Page Demo
        </h1>
        <span style={{ fontSize: "0.85rem", color: "var(--muted)" }}>16 results — all scored 100</span>
      </div>
      <div className="results-container" style={{ margin: "1rem 0.5rem", gap: "1rem", gridTemplateColumns: "repeat(auto-fill, minmax(290px, 1fr))", gridAutoRows: "1fr" }}>
        {DEMO_LISTINGS.map((listing) => (
          <ListingCard key={listing.id} data={listing} />
        ))}
      </div>
    </div>
  );
}
