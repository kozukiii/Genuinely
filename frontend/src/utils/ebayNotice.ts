const KEY = "ebay:search:notice";
const EVENT = "ebay:search:notice:changed";

export function setEbayNotice(active: boolean) {
  if (typeof window === "undefined") return;
  sessionStorage.setItem(KEY, active ? "1" : "0");
  window.dispatchEvent(new CustomEvent(EVENT, { detail: active }));
}

export function getEbayNotice() {
  if (typeof window === "undefined") return false;
  return sessionStorage.getItem(KEY) === "1";
}

export function onEbayNoticeChange(handler: (active: boolean) => void) {
  if (typeof window === "undefined") return () => {};

  const onCustom = (event: Event) => {
    handler(Boolean((event as CustomEvent<boolean>).detail));
  };

  const onStorage = () => {
    handler(getEbayNotice());
  };

  window.addEventListener(EVENT, onCustom as EventListener);
  window.addEventListener("storage", onStorage);

  return () => {
    window.removeEventListener(EVENT, onCustom as EventListener);
    window.removeEventListener("storage", onStorage);
  };
}
