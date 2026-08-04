/**
 * Educore seed script
 *
 * Sets the system up EMPTY except for the one Principal account and default
 * settings — every class, teacher, student, grade, notice, etc. is meant to
 * be entered afterwards through the system's own interfaces, not pre-loaded.
 *
 * Run with: npm run seed
 */
require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../config/db");

const User = require("../models/User");
const SchoolClass = require("../models/SchoolClass");
const Grade = require("../models/Grade");
const Attendance = require("../models/Attendance");
const Notice = require("../models/Notice");
const Event = require("../models/Event");
const Assignment = require("../models/Assignment");
const Fee = require("../models/Fee");
const Exam = require("../models/Exam");
const Book = require("../models/Book");
const Message = require("../models/Message");
const Behavior = require("../models/Behavior");
const Timetable = require("../models/Timetable");
const Settings = require("../models/Settings");
const TeacherAttendance = require("../models/TeacherAttendance");
const DailyQRCode = require("../models/DailyQRCode");
const Borrower = require("../models/Borrower");

const C = { accent: "#4f8cff" };

async function run() {
  await connectDB();

  console.log("Clearing all collections...");
  await Promise.all([
    User.deleteMany({}),
    SchoolClass.deleteMany({}),
    Grade.deleteMany({}),
    Attendance.deleteMany({}),
    Notice.deleteMany({}),
    Event.deleteMany({}),
    Assignment.deleteMany({}),
    Fee.deleteMany({}),
    Exam.deleteMany({}),
    Book.deleteMany({}),
    Message.deleteMany({}),
    Behavior.deleteMany({}),
    Timetable.deleteMany({}),
    Settings.deleteMany({}),
    TeacherAttendance.deleteMany({}),
    DailyQRCode.deleteMany({}),
    Borrower.deleteMany({}),
  ]);

  console.log("Creating principal account...");
  const principal = await User.create({
    name: "Santos Simon Conteh",
    email: "contehsantos1@hotmail.com",
    password: "Santos0039",
    role: "principal",
    phone: "033230039",
    initials: "SSC",
    color: C.accent,
    gender: "Male",
  });

  console.log("Creating default settings...");
  await Settings.create({});

  console.log("\n✅ System is empty and ready.\n");
  console.log("Principal login:");
  console.log(`  Email    : ${principal.email}`);
  console.log(`  Password : password123`);
  console.log(
    "\nEverything else — classes, teachers, students, notices, etc. —",
  );
  console.log("should now be added through the app itself.\n");

  await mongoose.connection.close();
  process.exit(0);
}

run().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
