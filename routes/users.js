const express = require("express");
const User = require("../models/User");
const { protect } = require("../middleware/auth");

const router = express.Router();

// GET /api/users/profile - current logged in user's profile
router.get("/profile", protect, async (req, res) => {
  const user = await User.findById(req.user._id)
    .populate("classId", "name")
    .populate("classTeacherOf", "name subjects level classGroup")
    .populate("classesTaught", "name level classGroup subjects");
  res.json({ user: user.toSafeObject() });
});

// PUT /api/users/profile - edit own profile. Every role except a student
// may edit their own profile here — a student's info is enrollment/
// admin-office data, not something the student themself should change.
router.put("/profile", protect, async (req, res) => {
  if (req.user.role === "student") {
    return res
      .status(403)
      .json({ message: "Students cannot edit their own profile." });
  }
  try {
    const allowed = [
      "name",
      "phone",
      "address",
      "dob",
      "gender",
      "nationality",
      "bloodGroup",
      "avatarUrl",
    ];
    const updates = {};
    allowed.forEach((f) => {
      if (req.body[f] !== undefined) updates[f] = req.body[f];
    });

    const user = await User.findByIdAndUpdate(req.user._id, updates, {
      new: true,
      runValidators: true,
    });
    res.json({ user: user.toSafeObject() });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// PUT /api/users/preferences
router.put("/preferences", protect, async (req, res) => {
  const user = await User.findById(req.user._id);
  user.preferences = { ...user.preferences.toObject(), ...req.body };
  await user.save();
  res.json({ preferences: user.preferences });
});

module.exports = router;
