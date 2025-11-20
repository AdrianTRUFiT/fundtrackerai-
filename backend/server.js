// -----------------------------------------------
// FundTrackerAI Backend — With SoulMark Minting
// -----------------------------------------------

import express from "express";
import Stripe from "stripe";
import fs from "fs";
import path from "path";
import cors from "cors";
import dotenv from "dotenv";
import crypto from "crypto";
import { fileURLToPath } from "url";

dotenv.config();

// -----------------------------------------------
// 0. APP SETUP
// -----------------------------------------------
const app = express();
app.use(express.json());
app.use(cors());

// ENV VARS
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const FRONTEND_URL = process.env.FRONTEND_URL;
const SOULMARK_SECRET = process.env.SOULMARK_SECRET;

if (!STRIPE_SECRET_KEY || !FRONTEND_URL || !SOULMARK_SECRET) {
  console.warn("⚠️ Missing env vars: STRIPE_SECRET_KEY, FRONTEND_URL, SOULMARK_SECRET");
}

const stripe = new Stripe(STRIPE_SECRET_KEY);

// PATH RESOLUTION
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const registryFile = path.join(__dirname, "registry.json");
console.log("📁 Registry path:", registryFile);

// Ensure registry exists
function ensureRegistry() {
  try {
    if (!fs.existsSync(registryFile)) {
      console.log("🆕 Creating registry.json");
      fs.writeFileSync(
        registryFile,
        JSON.stringify({ donations: [] }, null, 2),
        "utf8"
      );
    } else {
      JSON.parse(fs.readFileSync(registryFile, "utf8"));
    }
  } catch {
    console.error("⚠️ registry.json invalid — resetting.");
    fs.writeFileSync(
      registryFile,
      JSON.stringify({ donations: [] }, null, 2),
      "utf8"
    );
  }
}

ensureRegistry();

// -----------------------------------------------
// 1. ROOT
// -----------------------------------------------
app.get("/", (req, res) => {
  res.send("FundTrackerAI backend is running.");
});

// -----------------------------------------------
// 2. CREATE CHECKOUT SESSION (NOW STORES NAME)
// -----------------------------------------------
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { name, email, amount } = req.body;

    if (!amount || amount < 1) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: email,

      // ⭐ STORE NAME + EMAIL IN METADATA
      metadata: {
        donor_name: name,
        donor_email: email
      },

      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: "Donation" },
            unit_amount: amount * 100
          },
          quantity: 1
        }
      ],

      success_url: `${FRONTEND_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/index.html`
    });

    res.json({ url: session.url });

  } catch (err) {
    console.error("SESSION ERROR:", err);
    res.status(500).json({ error: "Session creation failed" });
  }
});

// -----------------------------------------------
// 3. VERIFY PAYMENT + MINT SOULMARK
// -----------------------------------------------
app.get("/verify-donation/:id", async (req, res) => {
  try {
    ensureRegistry();

    const session = await stripe.checkout.sessions.retrieve(req.params.id);

    if (!session || session.payment_status !== "paid") {
      return res.json({ verified: false, reason: "unpaid_or_missing" });
    }

    const email = session.customer_details?.email || "unknown";
    const donorName = session.metadata?.donor_name || "Donor";
    const amount = session.amount_total;

    const now = new Date().toISOString();
    const nonce = crypto.randomUUID();

    // Generate SoulMark
    const soulmark = crypto
      .createHash("sha256")
      .update(email + now + SOULMARK_SECRET + nonce)
      .digest("hex");

    // Entry saved into registry
    const entry = {
      id: session.id,
      name: donorName,
      email,
      amount,
      timestamp: now,
      soulmark
    };

    const json = JSON.parse(fs.readFileSync(registryFile, "utf8"));
    json.donations.push(entry);
    fs.writeFileSync(registryFile, JSON.stringify(json, null, 2));

    res.json({ verified: true, entry });

  } catch (err) {
    console.error("VERIFY ERROR:", err);
    res.status(500).json({ error: "Verification failed" });
  }
});

// -----------------------------------------------
// 4. READ ALL DONATIONS
// -----------------------------------------------
app.get("/donations", (req, res) => {
  try {
    ensureRegistry();
    const json = JSON.parse(fs.readFileSync(registryFile, "utf8"));
    res.json(json);
  } catch (err) {
    console.error("READ ERROR:", err);
    res.status(500).json({ error: "Failed to read registry" });
  }
});

// -----------------------------------------------
// 5. START SERVER
// -----------------------------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});