import { Router } from "express";
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

router.get("/google",
  passport.authenticate("google", { scope: ["profile", "email"], session: false }),
);

router.get("/google/callback", (req, res, next) => {
  console.log("[auth/callback] hit", req.url);
  try {
    passport.authenticate("google", { session: false }, (err: any, user: any) => {
      console.log("[auth/callback] passport cb fired, err:", err?.message, "user:", !!user);
      if (err || !user) { res.redirect(`${process.env.FRONTEND_URL}/`); return; }

      const { id, email, displayName } = user as { id: number; email: string; displayName: string };
      const token = jwt.sign({ id, email, displayName }, process.env.JWT_SECRET!, { expiresIn: "7d" });

      const isProd = process.env.NODE_ENV === "production";
      res.cookie("token", token, {
        httpOnly: true,
        secure:   isProd,
        sameSite: isProd ? "none" : "lax",
        maxAge:   7 * 24 * 60 * 60 * 1000,
      });

      console.log("[auth/callback] redirecting to", process.env.FRONTEND_URL);
      res.redirect(`${process.env.FRONTEND_URL}/`);
    })(req, res, next);
  } catch (e: any) {
    console.error("[auth/callback] sync throw:", e?.message);
    res.redirect(`${process.env.FRONTEND_URL}/`);
  }
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

router.post("/logout", (_req, res) => {
  const isProd = process.env.NODE_ENV === "production";
  res.clearCookie("token", { httpOnly: true, secure: isProd, sameSite: isProd ? "none" : "lax" });
  res.json({ ok: true });
});

export default router;
