// ONE-TIME migration — run this once after deploying the deferred-promotion
// change (Promotion.appliedAt / Promotion.notified), then never again.
//
//   node scripts/backfillPromotionApplied.js
//
// Why this is needed: every Promotion record created under the OLD code
// already had its class move applied immediately (at compute/approve
// time) — there was no "apply at year-rollover" step yet. Those old
// records default to appliedAt: null / notified: false under the new
// schema, which would make them look "not yet applied" to
// applyPromotionsForYear the next time an Admin sets a new academic
// year — a harmless no-op for the classId move (it would just re-set it
// to the same value), but it WOULD make an old, already-long-since-real
// promotion trigger a student's congratulations/encouragement popup out
// of nowhere, for something that already happened. This script stamps
// every EXISTING decided Promotion record (Promoted/Repeat/Graduating) as
// already applied and already notified, so only promotions decided from
// now on go through the new popup flow.
require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const Promotion = require("../models/Promotion");

async function run() {
  await connectDB();

  const result = await Promotion.updateMany(
    {
      status: { $in: ["Promoted", "Repeat", "Graduating"] },
      appliedAt: null,
    },
    [
      {
        $set: {
          appliedAt: { $ifNull: ["$decidedAt", "$updatedAt"] },
          notified: true,
        },
      },
    ],
  );

  console.log(
    `Backfilled ${result.modifiedCount ?? result.nModified} existing promotion record(s) as already applied/notified.`,
  );
  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
