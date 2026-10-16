// Local data keeps US search centers independent of third-party HTTP geocoders.
type Place = { country: string; latitude: number; longitude: number };
type Coordinates = { lat: number; lng: number };
const zipcodes = require("zipcodes") as {
  lookup(zip: string): Place | undefined;
  lookupByName(city: string, state: string): Place[];
};

function validPlace(place: Place | undefined): place is Place {
  return Boolean(place && place.country === "US" && Number.isFinite(place.latitude) &&
    Number.isFinite(place.longitude) && Math.abs(place.latitude) <= 90 &&
    Math.abs(place.longitude) <= 180 && (place.latitude !== 0 || place.longitude !== 0));
}

export function lookupMarketplaceZip(input: string): Coordinates | null {
  const match = input.trim().match(/^(\d{5})(?:-\d{4})?$/);
  if (!match) return null;
  const place = zipcodes.lookup(match[1]);
  return validPlace(place) ? { lat: place.latitude, lng: place.longitude } : null;
}

const cityCache = new Map<string, Coordinates | null>();
export function lookupMarketplaceCity(city: string, state: string): Coordinates | null {
  const key = `${city.trim().toLowerCase()}|${state.trim().toLowerCase()}`;
  if (cityCache.has(key)) return cityCache.get(key) ?? null;
  const places = zipcodes.lookupByName(city.trim(), state.trim()).filter(validPlace);
  const result = places.length ? {
    lat: places.reduce((sum, place) => sum + place.latitude, 0) / places.length,
    lng: places.reduce((sum, place) => sum + place.longitude, 0) / places.length,
  } : null;
  cityCache.set(key, result);
  return result;
}
