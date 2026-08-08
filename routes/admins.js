const express = require("express");
const User = require("../models/User");
const { protect, authorize } = require("../middleware/auth");

const router = express.Router();

// The school's admin layer is split into two role-based accounts:
//  - "admin"       = General Admin — full access to everything, exactly
//                     like the Principal (enforced centrally in
//                     middleware/auth.js's authorize()), across every
//                     level of the school.
//  - "juniorAdmin" = Junior School Admin — the same kind of full CRUD
//                     access, but scoped to Nursery, Primary, and JSS
//                     only. A Junior School Admin can never see, create,
//                     or manage anything at the SSS level.
// Both are never a Subject Teacher or Class Master, and neither is ever
// self-signed-up — only the Principal (or a General Admin) creates them,
// and the account is Approved and usable immediately, the same way the
// Principal adds a Teacher directly.
const ADMIN_ROLES = ["admin", "juniorAdmin"];

// GET /api/admins?role=admin|juniorAdmin - principal/General Admin only
router.get("/", protect, authorize("principal"), async (req, res) => {
  const filter = { role: { $in: ADMIN_ROLES } };
  if (req.query.role && ADMIN_ROLES.includes(req.query.role)) {
    filter.role = req.query.role;
  }
  const admins = await User.find(filter).sort("name");
  res.json({ admins: admins.map((a) => a.toSafeObject()), count: admins.length });
});

// GET /api/admins/:id
router.get("/:id", protect, authorize("principal"), async (req, res) => {
  const admin = await User.findOne({ _id: req.params.id, role: { $in: ADMIN_ROLES } });
  if (!admin) return res.status(404).json({ message: "Admin not found" });
  res.json({ admin: admin.toSafeObject() });
});

// POST /api/admins - General Admin only. Body.role picks which of the two
// admin roles to create; defaults to "admin" (General Admin). The Principal
// can view admins but never adds one — only a General Admin can.
router.post("/", protect, authorize("admin"), async (req, res) => {
  try {
    const {
      name,
      password,
      role,
      phone,
      gender,
      dob,
      address,
      nationality,
      avatarUrl,
    } = req.body;
    const adminRole = ADMIN_ROLES.includes(role) ? role : "admin";
    const initials = name
      .split(" ")
      .map((w) => w[0])
      .slice(0, 2)
      .join("")
      .toUpperCase();
    const admin = await User.create({
      name,
      password: password || "admin123",
      role: adminRole,
      phone,
      gender,
      dob,
      address,
      nationality,
      avatarUrl,
      initials,
      color: ["#4f8cff", "#22d3a0", "#fbbf24", "#f87171", "#fb923c", "#f472b6", "#7c5fff"][
        Math.floor(Math.random() * 7)
      ],
      approvalStatus: "Approved",
    });
    res.status(201).json({ admin: admin.toSafeObject() });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// PUT /api/admins/:id - General Admin only. The Principal can view admins
// but never edits one.
router.put("/:id", protect, authorize("admin"), async (req, res) => {
  try {
    const admin = await User.findOne({ _id: req.params.id, role: { $in: ADMIN_ROLES } });
    if (!admin) return res.status(404).json({ message: "Admin not found" });
    const body = { ...req.body };
    if (!body.password) delete body.password;
    if (!ADMIN_ROLES.includes(body.role)) delete body.role;
    Object.assign(admin, body);
    await admin.save();
    res.json({ admin: admin.toSafeObject() });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// DELETE /api/admins/:id - General Admin only. The Principal can view
// admins but never removes one.
router.delete("/:id", protect, authorize("admin"), async (req, res) => {
  const admin = await User.findOneAndDelete({ _id: req.params.id, role: { $in: ADMIN_ROLES } });
  if (!admin) return res.status(404).json({ message: "Admin not found" });
  res.json({ message: "Admin removed" });
});

module.exports = router;
