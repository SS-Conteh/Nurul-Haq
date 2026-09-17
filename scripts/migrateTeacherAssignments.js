const mongoose = require("mongoose");
const User = require("../models/User");
const Settings = require("../models/Settings");
require("dotenv").config();

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.DATABASE_URL;
  if (!uri) throw new Error("Missing MONGO_URI/MONGODB_URI/DATABASE_URL");
  await mongoose.connect(uri);

  const teachers = await User.find({ role: "teacher" });
  let updated = 0;
  for (const teacher of teachers) {
    const masterIds = (teacher.classMasterOf || []).map(String);
    if (!masterIds.length && teacher.classTeacherOf) masterIds.push(String(teacher.classTeacherOf));
    const classIds = (teacher.classesTaught || []).map(String);
    const levelSet = new Set((teacher.levelsTaught || []).filter(Boolean));

    const assignedIds = [...new Set([...classIds, ...masterIds])];
    if (assignedIds.length) {
      const SchoolClass = require("../models/SchoolClass");
      const classes = await SchoolClass.find({ _id: { $in: assignedIds } }).select("level").lean();
      classes.forEach((c) => levelSet.add(c.level));
    }
    if (!levelSet.size && teacher.level) levelSet.add(teacher.level);

    teacher.classMasterOf = [...new Set(masterIds)];
    teacher.classTeacherOf = teacher.classMasterOf[0] || null;
    teacher.classesTaught = [...new Set(classIds)];
    teacher.levelsTaught = [...levelSet].filter((l) => ["Nursery", "Primary", "JSS", "SSS"].includes(l));
    if (!teacher.level && teacher.levelsTaught[0]) teacher.level = teacher.levelsTaught[0];
    await teacher.save();
    updated += 1;
  }

  // Remove the retired level-default fee configuration. Existing per-class
  // fees remain untouched and continue to be the only fee source.
  await Settings.updateMany({}, { $unset: { feeAmounts: "" } });
  console.log(`Migrated ${updated} teacher records and removed level-default fees.`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
