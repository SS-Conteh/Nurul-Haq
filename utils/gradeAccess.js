const Fee = require("../models/Fee");
const Settings = require("../models/Settings");
const User = require("../models/User");
const { resolveRequiredFee } = require("./fees");

function termNumber(term) {
  const match = String(term || "").match(/Term\s*(\d+)/i);
  return match ? Number(match[1]) : 0;
}

/**
 * Determines whether a student may view grades for the current academic year.
 *
 * Rules:
 * - 0 payment: no grades and no averages.
 * - Below 50% paid: no grade access. Once at least 50% is paid, Terms 1–2
 *   are available while the school is in Terms 1–2.
 * - During Term 3, only a fully paid student may view grades (Terms 1–3).
 * - Fully paid: complete access to Terms 1–3 and averages.
 *
 * The decision is made server-side so the browser cannot bypass it.
 */
async function getStudentGradeAccess(studentId, requestedTerm = "") {
  const student = await User.findById(studentId).populate({
    path: "classId",
    select: "name level classGroup",
  });
  if (!student) {
    return { allowed: false, code: "STUDENT_NOT_FOUND", message: "Student not found." };
  }

  const settings = await Settings.findOne();
  const academicYear = settings?.academicYear || "";
  const requiredFee = resolveRequiredFee(settings, {
    name: student.classId?.name,
    level: student.classId?.level,
    classGroup: student.classId?.classGroup,
  });

  const fees = await Fee.find({ student: studentId, academicYear }).select("amount").lean();
  const paidToDate = fees.reduce((sum, fee) => sum + Number(fee.amount || 0), 0);

  // If the school has not configured a fee for the student's class, do not
  // accidentally lock every student out of grades. The finance page already
  // identifies the missing fee configuration to the school.
  if (requiredFee <= 0) {
    return {
      allowed: true,
      access: "full",
      paidToDate,
      requiredFee,
      percentPaid: 0,
      currentTerm: settings?.currentTerm || "",
      academicYear,
      message: "No annual fee is configured for this class; grade access is unrestricted until a fee is configured.",
    };
  }

  const percentPaid = Math.min(100, Math.round((paidToDate / requiredFee) * 100));
  const fullyPaid = paidToDate >= requiredFee;
  const halfPaid = paidToDate >= requiredFee * 0.5;
  const currentTerm = settings?.currentTerm || "";
  const currentTermNo = termNumber(currentTerm);
  const requestedTermNo = termNumber(requestedTerm);

  if (fullyPaid) {
    return {
      allowed: true,
      access: "full",
      paidToDate,
      requiredFee,
      percentPaid,
      currentTerm,
      academicYear,
      message: "Full grade access is available.",
    };
  }

  // At Term 3, every non-fully-paid student is locked out, including their
  // previously visible Term 1 and Term 2 results.
  if (currentTermNo >= 3) {
    return {
      allowed: false,
      access: halfPaid ? "partial_term3_locked" : "unpaid_or_below_half",
      paidToDate,
      requiredFee,
      percentPaid,
      currentTerm,
      academicYear,
      message: halfPaid
        ? "Your account has a partial fee payment. Term 3 is now in progress, so grades are available only after the annual fee is fully paid."
        : "Grades are locked until at least 50% of the annual school fee has been paid. During Term 3, full payment is required for grade access.",
    };
  }

  if (!halfPaid) {
    return {
      allowed: false,
      access: "unpaid_or_below_half",
      paidToDate,
      requiredFee,
      percentPaid,
      currentTerm,
      academicYear,
      message: "Grades are locked until at least 50% of the annual school fee has been paid.",
    };
  }

  // Half-paid students may only see Terms 1 and 2. Do not allow a client to
  // request Term 3 or an all-terms view to bypass that restriction.
  if (requestedTermNo >= 3) {
    return {
      allowed: false,
      access: "partial_terms_1_2",
      paidToDate,
      requiredFee,
      percentPaid,
      currentTerm,
      academicYear,
      message: "Term 3 grades are locked until the annual fee is fully paid.",
    };
  }

  if (!requestedTermNo) {
    return {
      allowed: currentTermNo > 0 && currentTermNo < 3,
      access: "partial_terms_1_2",
      allowedTerms: [1, 2],
      paidToDate,
      requiredFee,
      percentPaid,
      currentTerm,
      academicYear,
      message: currentTermNo >= 3
        ? "Term 3 grades are locked until the annual fee is fully paid."
        : "With a partial payment, only Term 1 and Term 2 grades are available.",
    };
  }

  return {
    allowed: requestedTermNo <= 2,
    access: "partial_terms_1_2",
    paidToDate,
    requiredFee,
    percentPaid,
    currentTerm,
    academicYear,
    message: "With a partial payment, only Term 1 and Term 2 grades are available.",
  };
}

module.exports = { getStudentGradeAccess, termNumber };
