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

router.get("/google/callback",
  passport.authenticate("google", { session: false, failureRedirect: `${process.env.FRONTEND_URL}/` }),
  (req, res) => {
    const user = req.user as { id: number; email: string; displayName: string };
    const token = jwt.sign(
      { id: user.id, email: user.email, displayName: user.displayName },
      process.env.JWT_SECRET!,
      { expiresIn: "7d" },
    );

    const cookieOpts = {
      secure:   process.env.NODE_ENV === "production",
      sameSite: "lax" as const,
      maxAge:   7 * 24 * 60 * 60 * 1000,
    };

    // httpOnly JWT — not readable by JS
    res.cookie("token", token, { ...cookieOpts, httpOnly: true });
    // readable flag so frontend can cheaply detect login state via document.cookie
    res.cookie("auth", "1", cookieOpts);

    res.redirect(`${process.env.FRONTEND_URL}/`);
  },
);

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
  const clearOpts = { secure: process.env.NODE_ENV === "production", sameSite: "lax" as const };
  res.clearCookie("token", { ...clearOpts, httpOnly: true });
  res.clearCookie("auth", clearOpts);
  res.json({ ok: true });
});

export default router;
