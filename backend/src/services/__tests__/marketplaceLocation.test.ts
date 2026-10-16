import { describe, expect, it } from "vitest";
import { lookupMarketplaceCity, lookupMarketplaceZip } from "../marketplaceLocation";

describe("local US Marketplace locations", () => {
  it("resolves the reported Eau Claire ZIP without an HTTP geocoder", () => {
    expect(lookupMarketplaceZip("54701")).toEqual({ lat: 44.784, lng: -91.4877 });
  });
  it("preserves leading zeroes and normalizes ZIP+4", () => {
    expect(lookupMarketplaceZip("02108")).toMatchObject({ lat: expect.any(Number), lng: expect.any(Number) });
    expect(lookupMarketplaceZip(" 54701-1234 ")).toEqual(lookupMarketplaceZip("54701"));
  });
  it("rejects unsupported or unknown input without guessing another location", () => {
    for (const zip of ["00000", "99999", "5470", "547010", "Eau Claire", "A1A 1A1", "", "54701-extra"]) {
      expect(lookupMarketplaceZip(zip)).toBeNull();
    }
  });
  it("accepts state names and abbreviations for approximate city centers", () => {
    const city = lookupMarketplaceCity("Eau Claire", "Wisconsin");
    expect(city?.lat).toBeCloseTo(44.81, 1);
    expect(city?.lng).toBeCloseTo(-91.5, 1);
    expect(lookupMarketplaceCity("eau claire", "WI")).toEqual(city);
    expect(lookupMarketplaceCity("not a known city", "WI")).toBeNull();
  });
});
