import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import db from "../db";

export interface AuthUser {
  id: number;
  email: string;
  displayName: string;
}

// Extend Passport's Express.User so req.user has our shape everywhere
declare global {
  namespace Express {
    interface User extends AuthUser {}
  }
}

export function isAdminUser(user: AuthUser | undefined): boolean {
  if (!user) return false;
  return user.email.toLowerCase() === "zmhigdon@gmail.com";
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user) { res.status(401).json({ error: "Unauthorized" }); return; }
  if (!isAdminUser(req.user)) { res.status(403).json({ error: "Forbidden" }); return; }
  next();
}

// Throttle last_seen writes: at most one UPDATE per user per window, kept in
// memory so the common case is a Map lookup, not a DB hit. Survives only for the
// process lifetime — a restart just means one extra write per active user.
const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000;
const lastSeenBumpedAt = new Map<number, number>();
const bumpLastSeen = db.prepare("UPDATE users SET last_seen = ? WHERE id = ?");

function touchLastSeen(userId: number) {
  const now = Date.now();
  const prev = lastSeenBumpedAt.get(userId);
  if (prev && now - prev < LAST_SEEN_THROTTLE_MS) return;
  lastSeenBumpedAt.set(userId, now);
  try {
    bumpLastSeen.run(Math.floor(now / 1000), userId);
  } catch {
    // Non-critical instrumentation — never let a logging write break auth.
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.token;
  if (!token) { res.status(401).json({ error: "Unauthorized" }); return; }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as AuthUser;
    req.user = payload;
    touchLastSeen(payload.id);
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired session" });
  }
}

export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const token = req.cookies?.token;
  if (token) {
    try {
      req.user = jwt.verify(token, process.env.JWT_SECRET!) as AuthUser;
    } catch { /* ignore */ }
  }
  next();
}
