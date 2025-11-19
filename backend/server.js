import express from "express";
import Stripe from "stripe";
import fs from "fs";
import path from "path";
import cors from "cors";
import dotenv from "dotenv";
import crypto from "crypto";

dotenv.config();

// ------------------------------------
// APP + MIDDLEWARE
// ------------------------------------
const app = express();
app.use(express.json());
app.use(cors());

// ------------------------------------
// ENV VARS
// ------------------------------------
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const FRONTEND_URL = process.env.FRONTEND_URL; // e.g. https://fundtrackerai.vercel.app
const SOULMARK_SECRET = process.env.SOULMARK_SECRET || "dev-only-secret";

if (!STRIPE_SECRET_KEY) {
  console.error("❌ Missing STRIPE_SECRET_KEY in environment!");
}
if (!FRONTEND_URL) {
  console.error("❌ Missing FRONTEND_URL in environment!");
}

const stripe = new Stripe(STRIPE_SECRET_KEY);

// registry.json is inside /backend/registry.json in GitHub
const registryFile = path.join(process.cwd(), "backend", "registry.json");

// Ensure registry.json exists with basic structure
function ensureRegistryFile() {
  try {
    if (!fs.existsSync(registryFile)) {
      const initial = { donations: [] };
      fs.writeFileSync(registryFile, JSON.stringify(initial, null, 2));
      console.log("📁 Created new registry.json");
    }
  } catch (err) {
    console.error("REGISTRY INIT ERROR:", err);
  }
}
ensureRegistryFile();

console.log("📁 Registry path:", registryFile);

// ------------------------------------
// HELPERS
// ------------------------------------
function generateSoulMark(email, sessionId) {
  const timestamp = new Date().toISOString();
  const raw = `${email}|${sessionId}|${timestamp}|${SOULMARK_SECRET}`;
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  return { soulmark: hash, timestamp };
}

// ------------------------------------
// ROOT PING
// ------------------------------------
app.get("/", (req, res) => {
  res.send("FundTrackerAI backend is running.");
});

// ------------------------------------
// 1. CREATE CHECKOUT SESSION
// ------------------------------------
app.post("/create-checkout-session", async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: "Donation" },
            unit_amount: 100, // $1 test
          },
          quantity: 1,
        },
      ],
      success_url: `${FRONTEND_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/index.html`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("SESSION ERROR:", err);
    res.status(500).json({ error: "Session creation failed" });
  }
});

// ------------------------------------
// 2. VERIFY PAYMENT + WRITE REGISTRY
// ------------------------------------
app.get("/verify-donation/:id", async (req, res) => {
  try {
    const sessionId = req.params.id;
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (!session || session.payment_status !== "paid") {
      return res.json({ verified: false });
    }

    const email = session.customer_details?.email || "unknown";
    const amount = session.amount_total || 0;

    const { soulmark, timestamp } = generateSoulMark(email, sessionId);

    const entry = {
      id: session.id,
      amount,
      email,
      soulmark,
      timestamp,
    };

    // Read current registry
    const json = JSON.parse(fs.readFileSync(registryFile, "utf8"));
    if (!Array.isArray(json.donations)) {
      json.donations = [];
    }

    json.donations.push(entry);
    fs.writeFileSync(registryFile, JSON.stringify(json, null, 2));

    res.json({ verified: true, entry });
  } catch (err) {
    console.error("VERIFY ERROR:", err);
    res.status(500).json({ error: "Verification failed" });
  }
});

// ------------------------------------
// 3. READ ALL DONATIONS (DASHBOARD)
// ------------------------------------
app.get("/donations", (req, res) => {
  try {
    const json = JSON.parse(fs.readFileSync(registryFile, "utf8"));
    if (!Array.isArray(json.donations)) {
      json.donations = [];
    }
    res.json(json);
  } catch (err) {
    console.error("READ ERROR:", err);
    res.status(500).json({ error: "Failed to read registry" });
  }
});

// ------------------------------------
// START SERVER
// ------------------------------------
app.listen(10000, () => {
  console.log("Backend running on port 10000");
});