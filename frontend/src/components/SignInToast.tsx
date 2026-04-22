import { useEffect, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext";
import "./styles/SignInToast.css";

export default function SignInToast() {
  const { user } = useAuth();
  const [message, setMessage] = useState<string | null>(null);
  const prevUser = useRef<typeof user>(undefined);

  useEffect(() => {
    // Sign in via redirect
    const params = new URLSearchParams(window.location.search);
    if (params.get("signed_in") === "1" && user) {
      params.delete("signed_in");
      const newUrl = window.location.pathname + (params.toString() ? `?${params}` : "");
      window.history.replaceState({}, "", newUrl);
      show(`Signed in as ${user.displayName}`);
    }
  }, [user]);

  useEffect(() => {
    // Sign out — user went from non-null to null
    if (prevUser.current && !user) show("Signed out successfully");
    prevUser.current = user;
  }, [user]);

  function show(msg: string) {
    setMessage(msg);
    setTimeout(() => setMessage(null), 4000);
  }

  if (!message) return null;

  return <div className="signin-toast">{message}</div>;
}
