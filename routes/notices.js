const express = require("express");
const Notice = require("../models/Notice");
const Settings = require("../models/Settings");
const { protect, authorize } = require("../middleware/auth");
const { yearFilter, currentTermString } = require("../utils/academicYear");
const router = express.Router();

// GET /api/notices?ay=&term= — category-gated by role:
//   - student:  only "students" notices
//   - teacher:  "teachers" AND "students" notices (never locked out of
//               what's been posted for their own students)
//   - principal/admin/juniorAdmin: everything, since they're the ones
//     managing/posting notices in the first place
router.get("/", protect, async (req, res) => {
  const settings = await Settings.findOne();
  const filter = {
    clearedBy: { $ne: req.user._id },
    ...yearFilter(settings?.academicYear, req.query.ay),
  };
  if (req.query.term) filter.term = req.query.term;
  if (req.user.role === "student") {
    filter.category = "students";
  } else if (req.user.role === "teacher") {
    filter.category = { $in: ["teachers", "students"] };
  }
  const notices = await Notice.find(filter).sort("-createdAt");
  res.json({ notices });
});

router.post("/", protect, authorize("admin", "juniorAdmin"), async (req, res) => {
  const { category } = req.body;
  if (!["teachers", "students"].includes(category)) {
    return res
      .status(400)
      .json({ message: "category must be 'teachers' or 'students'" });
  }
  const settings = await Settings.findOne();
  const notice = await Notice.create({
    ...req.body,
    postedBy: req.user._id,
    academicYear: settings?.academicYear || "",
    term: currentTermString(settings) || "",
  });
  res.status(201).json({ notice });
});

router.put("/:id", protect, authorize("admin", "juniorAdmin"), async (req, res) => {
  if (
    req.body.category !== undefined &&
    !["teachers", "students"].includes(req.body.category)
  ) {
    return res
      .status(400)
      .json({ message: "category must be 'teachers' or 'students'" });
  }
  const notice = await Notice.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
  });
  if (!notice) return res.status(404).json({ message: "Notice not found" });
  res.json({ notice });
});

// DELETE /api/notices - principal only: removes every notice for everyone
router.delete("/", protect, authorize("admin", "juniorAdmin"), async (req, res) => {
  await Notice.deleteMany({});
  res.json({ message: "All notices cleared" });
});

// POST /api/notices/clear-mine - any role: hides every notice for THIS user
// only. The notices themselves are untouched for everyone else.
router.post("/clear-mine", protect, async (req, res) => {
  await Notice.updateMany(
    { clearedBy: { $ne: req.user._id } },
    { $addToSet: { clearedBy: req.user._id } },
  );
  res.json({ message: "Notices cleared" });
});

// DELETE /api/notices/:id - principal only: removes this notice for everyone
router.delete("/:id", protect, authorize("admin", "juniorAdmin"), async (req, res) => {
  const notice = await Notice.findByIdAndDelete(req.params.id);
  if (!notice) return res.status(404).json({ message: "Notice not found" });
  res.json({ message: "Notice removed" });
});

// POST /api/notices/:id/clear - any role: hides this ONE notice for this
// user only, without deleting it from the system.
router.post("/:id/clear", protect, async (req, res) => {
  const notice = await Notice.findByIdAndUpdate(
    req.params.id,
    { $addToSet: { clearedBy: req.user._id } },
    { new: true },
  );
  if (!notice) return res.status(404).json({ message: "Notice not found" });
  res.json({ message: "Notice cleared" });
});

module.exports = router;
