const express = require("express");
const User = require("../models/User");
const { protect, authorize } = require("../middleware/auth");

const router = express.Router();

// The school's admin layer has six role-based accounts, all only ever
// created by the General Admin from this page — none of them is ever
// self-signed-up, and every account is Approved and usable immediately:
//  - "admin"        = General Admin — full access to everything, across
//                      every level of the school.
//  - "juniorAdmin"  = Junior School Admin — the same kind of full CRUD
//                      access, but scoped to Nursery, Primary, and JSS
//                      only. Never sees, creates, or manages SSS.
//  - "principal"     = Oversight-only: Senior Principal, Junior Principal,
//                      Vice Principal, or Proprietor (see `principalTitle`
//                      on the User model for which one). Can view and
//                      message everyone, but can never add, edit, or
//                      delete anything anywhere in the system.
//  - "seniorBursar" / "juniorBursar" = Finance-only. Senior Bursar handles
//                      SSS fees/bank transactions, Junior Bursar handles
//                      Nursery–JSS. Nothing outside Finance is visible.
const ADMIN_ROLES = ["admin", "juniorAdmin", "principal", "seniorBursar", "juniorBursar"];
// Titles a "principal"-role account must pick one of, so the Admins list
// can show which oversight seat it is.
const PRINCIPAL_TITLES = ["Senior Principal", "Junior Principal", "Vice Principal", "Proprietor"];

// GET /api/admins?role=admin|juniorAdmin|principal|seniorBursar|juniorBursar
// General Admin and the oversight tier (Principal/Proprietor) can view this
// list, for oversight purposes — neither the Junior School Admin nor
// either Bursar gets it: a Bursar's access is Finance and nothing else,
// and a Junior School Admin has never had visibility into the admin
// layer either.
router.get(
  "/",
  protect,
  authorize("admin", "principal"),
  async (req, res) => {
    const filter = { role: { $in: ADMIN_ROLES } };
    if (req.query.role && ADMIN_ROLES.includes(req.query.role)) {
      filter.role = req.query.role;
    }
    const admins = await User.find(filter).sort("name");
    res.json({ admins: admins.map((a) => a.toSafeObject()), count: admins.length });
  },
);

// GET /api/admins/:id
router.get(
  "/:id",
  protect,
  authorize("admin", "principal"),
  async (req, res) => {
    const admin = await User.findOne({ _id: req.params.id, role: { $in: ADMIN_ROLES } });
    if (!admin) return res.status(404).json({ message: "Admin not found" });
    res.json({ admin: admin.toSafeObject() });
  },
);

// POST /api/admins - General Admin only. Body.role picks which of the
// admin-layer roles to create; defaults to "admin" (General Admin). When
// role is "principal", body.principalTitle must be one of PRINCIPAL_TITLES.
router.post("/", protect, authorize("admin"), async (req, res) => {
  try {
    const {
      name,
      password,
      role,
      principalTitle,
      phone,
      gender,
      dob,
      address,
      nationality,
      avatarUrl,
    } = req.body;
    const adminRole = ADMIN_ROLES.includes(role) ? role : "admin";
    if (adminRole === "principal" && !PRINCIPAL_TITLES.includes(principalTitle)) {
      return res.status(400).json({
        message: "Pick a title — Senior Principal, Junior Principal, Vice Principal, or Proprietor",
      });
    }
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
      principalTitle: adminRole === "principal" ? principalTitle : "",
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

// PUT /api/admins/:id - General Admin only. Nobody else can edit an
// admin-layer account.
router.put("/:id", protect, authorize("admin"), async (req, res) => {
  try {
    const admin = await User.findOne({ _id: req.params.id, role: { $in: ADMIN_ROLES } });
    if (!admin) return res.status(404).json({ message: "Admin not found" });
    const body = { ...req.body };
    if (!body.password) delete body.password;
    if (!ADMIN_ROLES.includes(body.role)) delete body.role;
    const nextRole = body.role || admin.role;
    if (nextRole === "principal") {
      if (!PRINCIPAL_TITLES.includes(body.principalTitle || admin.principalTitle)) {
        return res.status(400).json({
          message: "Pick a title — Senior Principal, Junior Principal, Vice Principal, or Proprietor",
        });
      }
    } else {
      body.principalTitle = "";
    }
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
