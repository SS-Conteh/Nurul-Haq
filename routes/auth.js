const express = require("express");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Settings = require("../models/Settings");
const { protect } = require("../middleware/auth");

const router = express.Router();

function signToken(id) {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });
}

// Maintenance mode blocks everyone except the Principal (and Admins,
// who have the same full access) from logging in.
async function isBlockedByMaintenance(role) {
  if (["principal", "admin", "juniorAdmin", "seniorBursar", "juniorBursar"].includes(role)) return false;
  const settings = await Settings.findOne();
  return !!settings?.preferences?.maintenanceMode;
}

// A teacher/staff account created through the public sign-up form can't log
// in until the Principal approves it from the Teachers page.
function isAwaitingApproval(user) {
  return user.role === "teacher" && user.approvalStatus === "Pending";
}

// POST /api/auth/login/staff — Principals, Admins, Teachers, and any
// other staff log in with phone + password (students never use this
// endpoint).
router.post("/login/staff", async (req, res) => {
  try {
    const { phone, password } = req.body;
    if (!phone || !password) {
      return res
        .status(400)
        .json({ message: "Phone number and password are required" });
    }
    const user = await User.findOne({
      phone: phone.trim(),
      role: { $in: ["principal", "admin", "juniorAdmin", "seniorBursar", "juniorBursar", "teacher"] },
    }).select("+password");
    if (!user || !(await user.comparePassword(password))) {
      return res
        .status(401)
        .json({ message: "Invalid phone number or password" });
    }
    if (isAwaitingApproval(user)) {
      return res.status(403).json({
        message:
          "Your account is awaiting the Principal's approval. Please check back once it's been approved.",
      });
    }
    if (await isBlockedByMaintenance(user.role)) {
      return res
        .status(503)
        .json({
          message:
            "The system is currently under maintenance. Please try again later.",
        });
    }
    await user.populate([
      { path: "classId", select: "name" },
      { path: "classTeacherOf", select: "name subjects level classGroup" },
      { path: "classesTaught", select: "name level classGroup subjects" },
    ]);
    const token = signToken(user._id);
    res.json({ token, user: user.toSafeObject() });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/auth/login/student — students log in with Full Name + Student ID
// (their Admission No.) instead of a password, since they never set one.
router.post("/login/student", async (req, res) => {
  try {
    const { fullName, studentId } = req.body;
    if (!fullName || !studentId) {
      return res
        .status(400)
        .json({ message: "Full name and Student ID are required" });
    }
    const user = await User.findOne({
      role: "student",
      admissionNo: studentId.trim(),
      name: new RegExp(
        `^${fullName.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
        "i",
      ),
    });
    if (!user) {
      return res
        .status(401)
        .json({
          message: "No student found matching that name and Student ID",
        });
    }
    if (await isBlockedByMaintenance(user.role)) {
      return res
        .status(503)
        .json({
          message:
            "The system is currently under maintenance. Please try again later.",
        });
    }
    await user.populate({ path: "classId", select: "name" });
    const token = signToken(user._id);
    res.json({ token, user: user.toSafeObject() });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/auth/signup/teacher — public self-registration for Teachers/
// Staff only (never Students). Mirrors the exact fields the Principal fills
// in on the "Add Teacher" form (personal info / school info / login info),
// but the account is created as Pending and cannot sign in until the
// Principal approves it from the Teachers page.
router.post("/signup/teacher", async (req, res) => {
  try {
    const {
      name,
      password,
      subjects,
      teacherRole,
      level,
      classTeacherOf,
      classesTaught,
      phone,
      gender,
      dob,
      address,
      nationality,
      shift,
      avatarUrl,
    } = req.body;

    if (!name || !password) {
      return res
        .status(400)
        .json({ message: "Name and password are required" });
    }
    if (!phone) {
      return res
        .status(400)
        .json({
          message: "Phone number is required — it's what you'll log in with",
        });
    }

    const initials = name
      .split(" ")
      .map((w) => w[0])
      .slice(0, 2)
      .join("")
      .toUpperCase();

    // Note: intentionally does NOT touch SchoolClass.classTeacher here even
    // if teacherRole is "Class Master" — that relationship is only synced
    // once the Principal approves the account, so an unapproved signup can
    // never bump a real teacher off their class.
    const teacher = await User.create({
      name,
      password,
      role: "teacher",
      subjects: subjects || [],
      teacherRole,
      level,
      classTeacherOf: classTeacherOf || undefined,
      classesTaught: classesTaught || [],
      phone,
      gender,
      dob,
      address,
      nationality,
      shift,
      avatarUrl,
      initials,
      color: ["#4f8cff", "#22d3a0", "#fbbf24", "#f87171", "#fb923c", "#f472b6"][
        Math.floor(Math.random() * 6)
      ],
      approvalStatus: "Pending",
    });

    res.status(201).json({
      message:
        "Your account has been created. It's now pending approval from the Principal — you'll be able to sign in once it's approved.",
      teacher: teacher.toSafeObject(),
    });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// GET /api/auth/me
router.get("/me", protect, async (req, res) => {
  await req.user.populate([
    { path: "classId", select: "name" },
    { path: "classTeacherOf", select: "name subjects level classGroup" },
    { path: "classesTaught", select: "name level classGroup subjects" },
  ]);
  res.json({ user: req.user.toSafeObject() });
});

// POST /api/auth/change-password
router.post("/change-password", protect, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const user = await User.findById(req.user._id).select("+password");
    if (!(await user.comparePassword(currentPassword))) {
      return res.status(401).json({ message: "Current password is incorrect" });
    }
    user.password = newPassword;
    await user.save();
    res.json({ message: "Password updated successfully" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
