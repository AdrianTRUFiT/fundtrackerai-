// backend/server.js
import express from "express";
import Stripe from "stripe";
import fs from "fs";
import path from "path";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

// ------------------------------------
// APP INIT
// ------------------------------------
const app = express();
app.use(express.json());
app.use(cors());

// ------------------------------------
// ENV VARS
// ------------------------------------
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const FRONTEND_URL = process.env.FRONTEND_URL;
const SOULMARK_SECRET = process.env.SOULMARK_SECRET;

const stripe = new Stripe(STRIPE_SECRET_KEY);

// ------------------------------------
// CORRECT Registry Path (Render-safe)
// ------------------------------------
const registryFile = path.join(process.cwd(), "registry.json");

// Debug log (this MUST show correctly on Render)
console.log("📁 Registry path:", registryFile);

// Ensure registry exists on first run
if (!fs.existsSync(registryFile)) {
  fs.writeFileSync(registryFile, JSON.stringify({ donations: [] }, null, 2));
}

// ------------------------------------
// SoulMark Generator
// ------------------------------------
import crypto from "crypto";
function generateSoulMark(email) {
  const timestamp = Date.now().toString();
  const nonce = crypto.randomBytes(16).toString("hex");

  return crypto
    .createHash("sha256")
    .update(email + timestamp + SOULMARK_SECRET + nonce)
    .digest("hex");
}

// ------------------------------------
// ROOT
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
            unit_amount: 100, // $1 donation
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
// 2. VERIFY DONATION + MINT SOULMARK
// ------------------------------------
app.get("/verify-donation/:id", async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.retrieve(req.params.id);

    // must exist + be paid
    if (!session || session.payment_status !== "paid") {
      return res.json({ verified: false });
    }

    const email = session.customer_details?.email || "unknown";
    const amount = session.amount_total;

    // Read registry
    const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));

    // Mint SoulMark
    const soulmark = generateSoulMark(email);

    const entry = {
      id: session.id,
      email,
      amount,
      soulmark,
      timestamp: new Date().toISOString(),
    };

    registry.donations.push(entry);

    fs.writeFileSync(registryFile, JSON.stringify(registry, null, 2));

    return res.json({
      verified: true,
      entry,
    });
  } catch (err) {
    console.error("VERIFY ERROR:", err);
    res.status(500).json({ error: "Verification failed" });
  }
});

// ------------------------------------
// 3. READ ALL DONATIONS
// ------------------------------------
app.get("/donations", (req, res) => {
  try {
    const json = JSON.parse(fs.readFileSync(registryFile, "utf8"));
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
  console.log("🚀 Backend running on port 10000");
});