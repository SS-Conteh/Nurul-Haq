const express = require("express");
const Notice = require("../models/Notice");
const { protect, authorize } = require("../middleware/auth");
const router = express.Router();

router.get("/", protect, async (req, res) => {
  const notices = await Notice.find({ clearedBy: { $ne: req.user._id } }).sort(
    "-createdAt",
  );
  res.json({ notices });
});

router.post("/", protect, authorize("principal"), async (req, res) => {
  const notice = await Notice.create({ ...req.body, postedBy: req.user._id });
  res.status(201).json({ notice });
});

router.put("/:id", protect, authorize("principal"), async (req, res) => {
  const notice = await Notice.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
  });
  if (!notice) return res.status(404).json({ message: "Notice not found" });
  res.json({ notice });
});

// DELETE /api/notices - principal only: removes every notice for everyone
router.delete("/", protect, authorize("principal"), async (req, res) => {
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
router.delete("/:id", protect, authorize("principal"), async (req, res) => {
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
