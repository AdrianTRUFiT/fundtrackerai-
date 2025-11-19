// backend/server.js
import express from "express";
import Stripe from "stripe";
import fs from "fs";
import path from "path";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

// ---------- APP ----------
const app = express();
app.use(express.json());
app.use(cors());

// ---------- ENV VARS ----------
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const FRONTEND_URL = process.env.FRONTEND_URL;
const SOULMARK_SECRET = process.env.SOULMARK_SECRET;

const stripe = new Stripe(STRIPE_SECRET_KEY);

// ---------- REGISTRY PATH ----------
// Render installs your project at /opt/render/project/src/
// So registry.json must sit inside the backend folder next to server.js
const registryFile = path.join(process.cwd(), "src", "backend", "registry.json");

console.log("📁 Using registry file:", registryFile);

// Ensure registry.json exists
if (!fs.existsSync(registryFile)) {
  fs.writeFileSync(registryFile, JSON.stringify({ donations: [] }, null, 2));
  console.log("📄 registry.json created.");
}

// ---------- 0. ROOT PING ----------
app.get("/", (req, res) => {
  res.send("FundTrackerAI backend is running.");
});

// ---------- 1. CREATE CHECKOUT SESSION ----------
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
            unit_amount: 100
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

// ---------- 2. VERIFY PAYMENT + SOULMARK ----------
import crypto from "crypto";

function generateSoulMark(email, timestamp) {
  return crypto
    .createHash("sha256")
    .update(email + timestamp + SOULMARK_SECRET)
    .digest("hex");
}

app.get("/verify-donation/:id", async (req, res) => {
  try {
    const sessionId = req.params.id;
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (!session || session.payment_status !== "paid") {
      return res.json({ verified: false });
    }

    const email = session.customer_details?.email || "unknown";
    const timestamp = new Date().toISOString();
    const soulmark = generateSoulMark(email, timestamp);

    const entry = {
      id: session.id,
      email,
      amount: session.amount_total,
      timestamp,
      soulmark
    };

    // Write to registry.json
    const fileData = JSON.parse(fs.readFileSync(registryFile, "utf8"));
    fileData.donations.push(entry);
    fs.writeFileSync(registryFile, JSON.stringify(fileData, null, 2));

    res.json({ verified: true, entry });

  } catch (err) {
    console.error("VERIFY ERROR:", err);
    res.status(500).json({ error: "Verification failed" });
  }
});

// ---------- 3. LIST ALL DONATIONS (Dashboard) ----------
app.get("/donations", (req, res) => {
  try {
    const json = JSON.parse(fs.readFileSync(registryFile, "utf8"));
    res.json(json);
  } catch (err) {
    console.error("READ ERROR:", err);
    res.status(500).json({ error: "Failed to read registry" });
  }
});

// ---------- 4. START SERVER ----------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`);
});