const express = require("express");
const Book = require("../models/Book");
const Borrower = require("../models/Borrower");
const { protect, authorize } = require("../middleware/auth");
const router = express.Router();

router.get("/", protect, async (req, res) => {
  const books = await Book.find().sort("title");
  res.json({ books });
});

// GET /api/library/borrowers - the Borrowers table shown below the books table
router.get("/borrowers", protect, authorize("principal", "teacher"), async (req, res) => {
  const borrowers = await Borrower.find()
    .populate("student", "name initials color")
    .populate("book", "title author")
    .sort("-borrowedAt");
  res.json({ borrowers });
});

router.post("/", protect, authorize("admin", "juniorAdmin"), async (req, res) => {
  const book = await Book.create(req.body);
  res.status(201).json({ book });
});

// POST /api/library/:id/borrow  { studentId, dueDate }
router.post("/:id/borrow", protect, async (req, res) => {
  const book = await Book.findById(req.params.id);
  if (!book) return res.status(404).json({ message: "Book not found" });
  if (book.availableCopies < 1)
    return res.status(400).json({ message: "No copies available" });
  const { studentId, dueDate } = req.body;
  if (!studentId) return res.status(400).json({ message: "studentId is required" });
  book.availableCopies -= 1;
  await book.save();
  const borrower = await Borrower.create({
    student: studentId,
    book: book._id,
    dueDate: dueDate ? new Date(dueDate) : undefined,
  });
  res.json({ book, borrower });
});

// POST /api/library/:id/return  { borrowerId }
router.post("/:id/return", protect, async (req, res) => {
  const book = await Book.findById(req.params.id);
  if (!book) return res.status(404).json({ message: "Book not found" });
  book.availableCopies = Math.min(book.totalCopies, book.availableCopies + 1);
  await book.save();
  const { borrowerId } = req.body;
  if (borrowerId) {
    await Borrower.findByIdAndUpdate(borrowerId, {
      returnedAt: new Date(),
      status: "Returned",
    });
  }
  res.json({ book });
});

router.put("/:id", protect, authorize("admin", "juniorAdmin"), async (req, res) => {
  const book = await Book.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
  });
  if (!book) return res.status(404).json({ message: "Book not found" });
  res.json({ book });
});

router.delete("/:id", protect, authorize("admin", "juniorAdmin"), async (req, res) => {
  const book = await Book.findByIdAndDelete(req.params.id);
  if (!book) return res.status(404).json({ message: "Book not found" });
  res.json({ message: "Book removed" });
});

module.exports = router;
