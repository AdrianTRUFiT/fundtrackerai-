/**
 * Auto-Fix Script for donations.json
 * -----------------------------------
 * Repairs:
 *  - Missing visibility fields
 *  - Missing username
 *  - Missing showAmount/showName/showUsername flags
 *  - Ensures every donation obeys the 7-state logic
 *
 * Usage:
 *   1. Place this file in same folder as donations.json
 *   2. Run:   node fix-donations.js
 *   3. A repaired file will be saved as donations_fixed.json
 */

const fs = require("fs");

// ---- Load existing donation file ----
const RAW_PATH = "./donations.json";
const FIXED_PATH = "./donations_fixed.json";

if (!fs.existsSync(RAW_PATH)) {
  console.error("❌ No donations.json found in this folder.");
  process.exit(1);
}

let donations = JSON.parse(fs.readFileSync(RAW_PATH, "utf8"));

// ---- Repair each entry ----
const fixed = donations.map((d) => {
  let repaired = { ...d };

  // Create visibility object if missing
  if (!repaired.visibility) {
    repaired.visibility = {
      showName: true,
      showUsername: true,
      showAmount: true
    };
  }

  // Ensure all 3 visibility fields exist
  if (typeof repaired.visibility.showName !== "boolean")
    repaired.visibility.showName = true;

  if (typeof repaired.visibility.showUsername !== "boolean")
    repaired.visibility.showUsername = true;

  if (typeof repaired.visibility.showAmount !== "boolean")
    repaired.visibility.showAmount = true;

  // Fix missing username
  if (!repaired.username || repaired.username.trim() === "") {
    // Derive from email before the @ if possible
    if (repaired.email && repaired.email.includes("@")) {
      repaired.username =
        repaired.email.split("@")[0].replace(/[^a-z0-9._-]/gi, "") +
        "@iascendai";
    } else {
      repaired.username = "user" + Math.floor(Math.random() * 999999) + "@iascendai";
    }
  }

  // Ensure name field exists
  if (!repaired.name || repaired.name.trim() === "") {
    repaired.name = "Anonymous";
  }

  // Enforce Anonymous rule
  const showName = repaired.visibility.showName;
  const showUsername = repaired.visibility.showUsername;

  if (!showName && !showUsername) {
    repaired.visibility.showAmount = true; // forced
  }

  return repaired;
});

// ---- Save repaired file ----
fs.writeFileSync(FIXED_PATH, JSON.stringify(fixed, null, 2));

console.log("✅ Repair complete!");
console.log("📄 Saved as donations_fixed.json");
console.log("➡ Replace the original file only after verifying entries look correct.");