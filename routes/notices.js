const express = require("express");
const Notice = require("../models/Notice");
const Settings = require("../models/Settings");
const { protect, authorize } = require("../middleware/auth");
const { yearFilter, currentTermString } = require("../utils/academicYear");
const router = express.Router();
const { sendNoticePush } = require("../utils/pushNotifications");

function visibleNoticeFilter(user, settings, query = {}) {
  const filter = {
    clearedBy: { $ne: user._id },
    ...yearFilter(settings?.academicYear, query.ay),
  };
  if (query.term) filter.term = query.term;
  if (user.role === "student") {
    filter.category = "students";
  } else if (user.role === "teacher") {
    filter.category = { $in: ["teachers", "students"] };
  }
  return filter;
}

// GET /api/notices?ay=&term= — category-gated by role:
//   - student:  only "students" notices
//   - teacher:  "teachers" AND "students" notices (never locked out of
//               what's been posted for their own students)
//   - principal/admin/juniorAdmin: everything, since they're the ones
//     managing/posting notices in the first place
router.get("/", protect, async (req, res) => {
  const settings = await Settings.findOne();
  const filter = visibleNoticeFilter(req.user, settings, req.query);
  const notices = await Notice.find(filter).sort("-createdAt").lean();
  const uid = String(req.user._id);
  notices.forEach((notice) => {
    notice.isRead = (notice.readBy || []).some((id) => String(id) === uid);
    delete notice.readBy;
  });
  res.json({ notices });
});

// Fast count for the navigation badge. It uses the same audience/cleared
// rules as the list endpoint, but only counts notices not yet read by this user.
router.get("/unread-count", protect, async (req, res) => {
  const settings = await Settings.findOne();
  const filter = visibleNoticeFilter(req.user, settings, req.query);
  filter.readBy = { $ne: req.user._id };
  const count = await Notice.countDocuments(filter);
  res.json({ count });
});

// Mark one notice read for the current user. Reading never deletes or clears
// the notice; it only removes it from the unread counter.
router.post("/:id/read", protect, async (req, res) => {
  const settings = await Settings.findOne();
  const filter = visibleNoticeFilter(req.user, settings, {});
  filter._id = req.params.id;
  const notice = await Notice.findOneAndUpdate(
    filter,
    { $addToSet: { readBy: req.user._id } },
    { new: true },
  );
  if (!notice) return res.status(404).json({ message: "Notice not found" });
  res.json({ read: true });
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
  // Do not make posting wait for every browser/device. The API responds
  // immediately while the server sends the push notifications in the
  // background. Invalid/expired subscriptions are cleaned up automatically.
  setImmediate(() => {
    sendNoticePush(notice).catch((err) =>
      console.error("[NHIA-SMS] Notice push dispatch failed:", err.message),
    );
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
    { $addToSet: { clearedBy: req.user._id, readBy: req.user._id } },
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
    { $addToSet: { clearedBy: req.user._id, readBy: req.user._id } },
    { new: true },
  );
  if (!notice) return res.status(404).json({ message: "Notice not found" });
  res.json({ message: "Notice cleared" });
});

module.exports = router;
