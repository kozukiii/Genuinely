import { Router } from "express";
import type { CookieOptions, Request } from "express";
import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import jwt from "jsonwebtoken";
import db from "../db";

const router = Router();

// ── Passport setup ────────────────────────────────────────────────────────────

passport.use(new GoogleStrategy(
  {
    clientID:     process.env.GOOGLE_CLIENT_ID!,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    callbackURL:  process.env.GOOGLE_CALLBACK_URL!,
  },
  (_accessToken, _refreshToken, profile, done) => {
    const email       = profile.emails?.[0]?.value ?? "";
    const displayName = profile.displayName ?? email;

    const existing = db.prepare("SELECT id FROM users WHERE google_id = ?").get(profile.id) as { id: number } | undefined;

    if (existing) {
      db.prepare("UPDATE users SET email = ?, display_name = ? WHERE id = ?")
        .run(email, displayName, existing.id);
      return done(null, { id: existing.id, email, displayName });
    }

    const result = db.prepare(
      "INSERT INTO users (google_id, email, display_name) VALUES (?, ?, ?)"
    ).run(profile.id, email, displayName);

    return done(null, { id: Number(result.lastInsertRowid), email, displayName });
  },
));

// ── Routes ────────────────────────────────────────────────────────────────────


function getCookieOptions(req: Request): CookieOptions {
  const frontendUrl = process.env.FRONTEND_URL ?? "";
  const frontendIsHttps = frontendUrl.startsWith("https://");
  const forwardedProto = req.headers["x-forwarded-proto"];
  const requestIsHttps = req.secure
    || (typeof forwardedProto === "string" && forwardedProto.split(",")[0]?.trim() === "https");

  // SameSite=None is required when frontend and API live on different sites.
  // Browsers only accept SameSite=None when cookies are Secure.
  const secure = frontendIsHttps || requestIsHttps;

  return {
    httpOnly: true,
    secure,
    sameSite: secure ? "none" : "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/",
  };
}


router.get("/google",
  passport.authenticate("google", { scope: ["profile", "email"], session: false }),
);

router.get("/google/callback", (req, res, next) => {
  passport.authenticate("google", { session: false }, (err: any, user: any) => {
    if (err || !user) { res.redirect(`${process.env.FRONTEND_URL}/`); return; }

    const { id, email, displayName } = user as { id: number; email: string; displayName: string };
    const token = jwt.sign({ id, email, displayName }, process.env.JWT_SECRET!, { expiresIn: "7d" });

    res.cookie("token", token, getCookieOptions(req));

    res.redirect(`${process.env.FRONTEND_URL}/?signed_in=1`);
  })(req, res, next);
});

router.get("/me", (req, res) => {
  const token = req.cookies?.token;
  if (!token) { res.status(401).json({ user: null }); return; }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as { id: number; email: string; displayName: string };
    res.json({ user: { id: payload.id, email: payload.email, displayName: payload.displayName } });
  } catch {
    res.status(401).json({ user: null });
  }
});

router.post("/logout", (req, res) => {
  const { maxAge, ...cookieOptions } = getCookieOptions(req);
  res.clearCookie("token", cookieOptions);
  res.json({ ok: true });
});

export default router;
