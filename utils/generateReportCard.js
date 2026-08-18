const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const { ordinal, gradeFor, rankDescending } = require("./reportCardHelpers");

const LOGO_PATH = path.join(__dirname, "..", "assets", "logo.jpeg");
const STAMP_PATH = path.join(__dirname, "..", "assets", "stamp.png");

// ── Portrait A4 layout ──
// The report card used to be landscape (usable width ~794pt). Printed in
// portrait instead (usable width ~547pt at a 24pt margin), so every column
// below is scaled down to ~0.71x of its old landscape width to still fit
// the page, with font sizes trimmed slightly to match.
const SUBJECT_COL = 106;
const MAX_COL = 23;
const TERM_SUBCOLS = [17, 19, 23, 23]; // Test, Exam, MN, RNK
const TERM_GROUP_W = TERM_SUBCOLS.reduce((a, b) => a + b, 0);
const YEARLY_SUBCOLS = [34, 28, 24, 24, 55]; // Total, Mean, Rank, Grade, Remarks
const YEARLY_GROUP_W = YEARLY_SUBCOLS.reduce((a, b) => a + b, 0);
const TABLE_WIDTH = SUBJECT_COL + MAX_COL + TERM_GROUP_W * 3 + YEARLY_GROUP_W;

const ROW_H = 15.5;
const CELL_SIZE = 6.9; // data cell font size (bumped up slightly for readability)
const HEAD_SIZE = 6.3; // sub-header font size (bumped up slightly for readability)

// Grid lines / borders throughout the report card are royal blue.
const GRID_BLUE = "#1e3a8a";

// Scores, marks and other highlighted numeric values are colored by
// performance: 50 and above is blue (pass), below 50 is red (fail).
// Everything else (labels, subject names, rank/grade/remarks) stays black.
const SCORE_RED = "#dc2626";
const SCORE_BLUE = "#1d4ed8";
const gradeColor = () => SCORE_RED;

// Returns the pass/fail color for a printed numeric score/mark, or black
// when there's no value to judge yet (blank cell).
function scoreColor(value) {
  if (value === "" || value === null || value === undefined) return "#000";
  const n = Number(value);
  if (Number.isNaN(n)) return "#000";
  return n >= 50 ? SCORE_BLUE : SCORE_RED;
}

function cellRect(doc, x, y, w, h, text, opts = {}) {
  const { align = "center", bold = false, size = CELL_SIZE, fill = null, valign = "middle", color = "#000" } = opts;
  if (fill) {
    doc.save().rect(x, y, w, h).fill(fill).restore();
  }
  doc.rect(x, y, w, h).lineWidth(0.6).stroke(GRID_BLUE);
  if (text !== undefined && text !== null) {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size).fillColor(color);
    const textY = valign === "middle" ? y + (h - size) / 2 + 1 : y + 2;
    doc.text(String(text), x + 1, textY, { width: w - 2, align });
  }
}

// Student photos are stored as base64 data URLs (e.g.
// "data:image/jpeg;base64,...") straight on the User document, the same
// way every other photo in this app is stored — never as a filesystem
// path. This decodes that data URL into an image buffer pdfkit can draw.
// (Falls back to treating the value as a real file path, in case any
// older/seeded record still has one.)
function resolvePhotoImage(avatarUrl) {
  if (!avatarUrl) return null;
  const match = /^data:image\/\w+;base64,(.+)$/.exec(avatarUrl);
  if (match) {
    try {
      return Buffer.from(match[1], "base64");
    } catch (e) {
      return null;
    }
  }
  if (fs.existsSync(avatarUrl)) return avatarUrl;
  return null;
}

async function computeRoster(Grade, User, student, classId, subjects, terms) {
  // All classmates (including this student) sharing the same class, used
  // for per-subject / per-term ranking exactly like the paper report card.
  const classmates = await User.find({ role: "student", classId }).select("_id");
  const classmateIds = classmates.map((c) => c._id);
  const allGrades = await Grade.find({
    student: { $in: classmateIds },
    subject: { $in: subjects },
    term: { $in: terms },
  });
  return { classmateIds, allGrades, classSize: classmateIds.length };
}

/**
 * Streams the report card PDF straight to the Express response.
 * `terms` = [termStringT1, termStringT2, termStringT3] as stored on Grade docs
 * (e.g. "Term 1 · 2026"); `termLabel` = which one is "current" for the title.
 */
async function generateReportCard(res, { student, classDoc, subjects, terms, termLabel, session, settings, attendanceCounts, Grade, User, promotion, doc: sharedDoc, isBulk = false }) {
  const { allGrades, classSize } = await computeRoster(Grade, User, student, classDoc?._id, subjects, terms);

  // Group grades by subject -> by term
  function gradesFor(studentId, subject) {
    return terms.map((t) => allGrades.find((g) => String(g.student) === String(studentId) && g.subject === subject && g.term === t) || null);
  }

  // Per-subject, per-term rank across the class (by that term's MN)
  function termRank(subject, termIdx, studentId) {
    const values = allGrades.filter((g) => g.subject === subject && g.term === terms[termIdx]);
    const byStudent = new Map();
    values.forEach((g) => byStudent.set(String(g.student), ((g.test || 0) + (g.examScore || 0)) / 2));
    // Only rank students who have a value for this term
    const entries = [...byStudent.entries()];
    if (!entries.length) return null;
    const sorted = entries.sort((a, b) => b[1] - a[1]);
    let rank = 0, lastVal = null, seen = 0;
    for (const [sid, val] of sorted) {
      seen += 1;
      if (val !== lastVal) { rank = seen; lastVal = val; }
      if (sid === String(studentId)) return rank;
    }
    return null;
  }

  // Whether TERM 3 has actually been graded for this subject/student —
  // the yearly figures for a subject only exist once this is true. Term 1
  // or term 1+2 alone can never produce a yearly total/mean/rank/grade;
  // only term 1, 2, AND 3 together do.
  function hasTerm3(studentId, subject) {
    return !!gradesFor(studentId, subject)[2];
  }

  // Yearly per-subject figures for the YEARLY columns — gated on Term 3.
  // TOTAL = the sum total of the subject's three term MNs (no division).
  // MEAN  = that same sum, divided by 3 (the fixed 1st+2nd+3rd/3 formula —
  // not divided by however many terms happen to have a grade, since a
  // yearly figure only exists at all once all three are in).
  function yearlyStatsFor(studentId, subject) {
    if (!hasTerm3(studentId, subject)) return { total: 0, mean: 0 };
    const rows = gradesFor(studentId, subject);
    const total = rows.reduce((s, g) => s + (g ? ((g.test || 0) + (g.examScore || 0)) / 2 : 0), 0);
    const mean = total / 3;
    return { total, mean };
  }
  function yearlyRank(subject, studentId) {
    const ids = [...new Set(allGrades.filter((g) => g.subject === subject).map((g) => String(g.student)))]
      .filter((sid) => hasTerm3(sid, subject));
    const withMean = ids.map((sid) => [sid, yearlyStatsFor(sid, subject).mean]);
    if (!withMean.length) return null;
    const sorted = withMean.sort((a, b) => b[1] - a[1]);
    let rank = 0, lastVal = null, seen = 0;
    for (const [sid, val] of sorted) {
      seen += 1;
      if (val !== lastVal) { rank = seen; lastVal = val; }
      if (sid === String(studentId)) return rank;
    }
    return null;
  }

  // ── Build the per-subject rows for THIS student ──
  const rows = subjects.map((subject) => {
    const [t1, t2, t3] = gradesFor(student._id, subject);
    const termCell = (g, idx) => {
      if (!g) return { test: "", exam: "", mn: "0.0", rnk: "-" };
      // MN = the plain average of the actual Test and Exam scores entered
      // for this term — e.g. Test 60, Exam 89 -> MN = (60+89)/2 = 74.5.
      const mn = ((g.test || 0) + (g.examScore || 0)) / 2;
      const rnk = termRank(subject, idx, student._id);
      return { test: g.test ?? "", exam: g.examScore ?? "", mn: mn.toFixed(1), rnk: rnk ? ordinal(rnk) : "-" };
    };
    const subjectHasTerm3 = hasTerm3(student._id, subject);
    const { total, mean } = yearlyStatsFor(student._id, subject);
    const rnkY = subjectHasTerm3 ? yearlyRank(subject, student._id) : null;
    const { grade, remark } = subjectHasTerm3 ? gradeFor(mean) : { grade: "-", remark: "-" };
    return {
      subject,
      max: 100,
      t1: termCell(t1, 0),
      t2: termCell(t2, 1),
      t3: termCell(t3, 2),
      total: subjectHasTerm3 ? total.toFixed(1).replace(/\.0$/, "") : "-",
      mean: subjectHasTerm3 ? mean.toFixed(1) : "-",
      rank: rnkY ? ordinal(rnkY) : "-",
      grade,
      remark,
    };
  });

  // ── Overall totals ──
  // Each subject-term combination is worth 100: Test and Exam are both raw
  // scores out of 100, so the combination's actual contribution is their
  // average (cell.mn), not their raw sum (which can run up to 200).
  let obtainable = 0, obtained = 0;
  const colTotals = { t1a: 0, t1b: 0, t2a: 0, t2b: 0, t3a: 0, t3b: 0 };
  rows.forEach((r) => {
    [r.t1, r.t2, r.t3].forEach((cell) => {
      if (cell.test !== "" || cell.exam !== "") {
        obtainable += 100;
        obtained += Number(cell.mn) || 0;
      }
    });
    colTotals.t1a += Number(r.t1.test) || 0;
    colTotals.t1b += Number(r.t1.exam) || 0;
    colTotals.t2a += Number(r.t2.test) || 0;
    colTotals.t2b += Number(r.t2.exam) || 0;
    colTotals.t3a += Number(r.t3.test) || 0;
    colTotals.t3b += Number(r.t3.exam) || 0;
  });
  const avgPct = obtainable ? (obtained / obtainable) * 100 : 0;

  // ── YEARLY footer row figures (TOTAL MARKS / PERCENTAGE) ──
  // Per-term column value = the SUM of every subject's MN for that term —
  // never divided. Only the PERCENTAGE row divides (sum / number of
  // subjects). The YEARLY columns only exist once Term 3 has actually been
  // graded for this student — term 1, or term 1+2, alone can never produce
  // a yearly total/percentage.
  const footerSubjCount = subjects.length || 1;
  const term1Total = (colTotals.t1a + colTotals.t1b) / 2;
  const term2Total = (colTotals.t2a + colTotals.t2b) / 2;
  const term3Total = (colTotals.t3a + colTotals.t3b) / 2;
  const term1Pct = term1Total / footerSubjCount;
  const term2Pct = term2Total / footerSubjCount;
  const term3Pct = term3Total / footerSubjCount;
  const studentHasTerm3 = rows.some((r) => r.t3.test !== "" || r.t3.exam !== "");
  // YEARLY TOTAL MARKS = 1st term total + 2nd term total + 3rd term total —
  // straight sum, no division.
  const yearlyTotalMarks = studentHasTerm3 ? term1Total + term2Total + term3Total : null;
  // YEARLY PERCENTAGE = (1st term % + 2nd term % + 3rd term %) / 3.
  const yearlyPercentage = studentHasTerm3 ? (term1Pct + term2Pct + term3Pct) / 3 : null;

  // Overall class position, ranked by each classmate's own average percentage
  const classmateAverages = new Map();
  const allStudentIds = [...new Set(allGrades.map((g) => String(g.student)))];
  allStudentIds.forEach((sid) => {
    let obt = 0, obtn = 0;
    subjects.forEach((subject) => {
      terms.forEach((t) => {
        const g = allGrades.find((x) => String(x.student) === sid && x.subject === subject && x.term === t);
        if (g) { obtn += ((g.test || 0) + (g.examScore || 0)) / 2; obt += 100; }
      });
    });
    classmateAverages.set(sid, obt ? (obtn / obt) * 100 : 0);
  });
  let overallRank = null;
  {
    const sorted = [...classmateAverages.entries()].sort((a, b) => b[1] - a[1]);
    let rank = 0, lastVal = null, seen = 0;
    for (const [sid, val] of sorted) {
      seen += 1;
      if (val !== lastVal) { rank = seen; lastVal = val; }
      if (sid === String(student._id)) overallRank = rank;
    }
  }

  // ═══════════════ DRAW THE PDF — "Modern Navy & Gold" theme ═══════════════
  // In bulk mode the caller already created/piped/will-end a single shared
  // PDFDocument spanning every student — we just draw this student's page(s)
  // onto it. In single mode we own the whole lifecycle as before.
  // Portrait A4 (the school asked for portrait, not the previous landscape).
  const doc = sharedDoc || new PDFDocument({ size: "A4", margin: 24 });
  if (!isBulk) {
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=ReportCard-${(student.admissionNo || student.name || "student").replace(/\s+/g, "_")}.pdf`,
    );
    doc.pipe(res);
  }

  const pageW = doc.page.width;
  const pageH = doc.page.height;
  const marginX = doc.page.margins.left;
  const usableW = pageW - marginX * 2;
  const hasLogo = fs.existsSync(LOGO_PATH);

  // ── Palette — clean blue, lavender, black & red ──
  const ROYAL = GRID_BLUE; // borders, lines, headings, logo details
  const ROYAL_2 = "#111d4a"; // deeper royal shade for the group header row
  const CYAN = "#38bdf8"; // light blue/cyan decorative accents
  const LAVENDER = "#e6e6fa"; // main header background, some table sections
  const LAVENDER_DARK = "#cfcff2"; // slightly deeper lavender for group headers
  const CREAM = "#fbf3d9"; // pale yellow/cream — grading-key section
  const BLACK = "#161616"; // most text, labels, subject names
  const MUTED = "#5a5a66";
  const CARD_BG = "#fbfbff";
  const BORDER = ROYAL;
  const ZEBRA = "#f2f2fc";
  const FAIL_TINT = "#fbe1df";

  function roundedFillStroke(x, y, w, h, r, fill, stroke, lw = 1) {
    const rr = doc.roundedRect(x, y, w, h, r);
    if (fill && stroke) rr.fillAndStroke(fill, stroke);
    else if (fill) rr.fill(fill);
    else if (stroke) rr.lineWidth(lw).stroke(stroke);
  }

  function circleImage(cx, cy, r, imgPath) {
    // Square (rounded) badge — kept the name "circleImage" to avoid
    // touching every call site, but it now draws a square medallion
    // instead of a circular one, per the school's branding preference.
    const s = r * 2;
    const x = cx - r;
    const y = cy - r;
    const radius = 5;
    doc.save();
    doc.roundedRect(x - 2, y - 2, s + 4, s + 4, radius + 2).fill("#ffffff");
    doc.roundedRect(x, y, s, s, radius).clip();
    doc.image(imgPath, x, y, { cover: [s, s], align: "center", valign: "center" });
    doc.restore();
    doc.roundedRect(x - 2, y - 2, s + 4, s + 4, radius + 2).lineWidth(1).stroke(ROYAL);
  }

  // ── Faint full-page watermark seal ──
  if (hasLogo) {
    doc.save();
    doc.opacity(0.05);
    const wmSize = 360;
    doc.image(LOGO_PATH, (pageW - wmSize) / 2, (pageH - wmSize) / 2 - 20, {
      width: wmSize,
      height: wmSize,
    });
    doc.opacity(1);
    doc.restore();
  }

  // ── Header banner (lavender, rounded, crest medallions) ──
  let y = 24;
  const bannerH = 64;
  doc.roundedRect(marginX, y, usableW, bannerH, 8).fill(LAVENDER);

  if (hasLogo) {
    circleImage(marginX + 34, y + bannerH / 2, 22, LOGO_PATH);
    circleImage(marginX + usableW - 34, y + bannerH / 2, 22, LOGO_PATH);
  }

  const textX = marginX + 66;
  const textW = usableW - 132;
  doc.font("Helvetica-Bold").fontSize(14).fillColor(ROYAL)
    .text((settings.schoolName || "Nurul-Haq Islamic Academy").toUpperCase(), textX, y + 7, { width: textW, align: "center" });
  doc.font("Helvetica").fontSize(7.3).fillColor(BLACK)
    .text((settings.address || "").toUpperCase(), textX, y + 24, { width: textW, align: "center" });
  doc.font("Helvetica").fontSize(6.8).fillColor(ROYAL)
    .text(`"${settings.motto || "Knowledge and Perseverance"}"`, textX, y + 35, { width: textW, align: "center" });
  doc.font("Helvetica").fontSize(6.8).fillColor(BLACK)
    .text(`Tel: ${settings.phone || ""}`, textX, y + 46, { width: textW, align: "center" });

  y += bannerH + 8;

  // ── Royal-blue accent divider with a small cyan diamond ornament ──
  doc.moveTo(marginX, y).lineTo(marginX + usableW / 2 - 8, y).lineWidth(1.4).stroke(ROYAL);
  doc.moveTo(marginX + usableW / 2 + 8, y).lineTo(marginX + usableW, y).lineWidth(1.4).stroke(ROYAL);
  doc.save();
  doc.translate(marginX + usableW / 2, y).rotate(45);
  doc.rect(-4, -4, 8, 8).fill(CYAN);
  doc.restore();
  y += 10;

  // ── Title pill ──
  const titleText = `${session} · ${termLabel.toUpperCase()} PROGRESS REPORT`;
  doc.font("Helvetica-Bold").fontSize(9.5);
  const titleW = doc.widthOfString(titleText) + 28;
  const pillX = marginX + (usableW - titleW) / 2;
  roundedFillStroke(pillX, y, titleW, 17, 8.5, LAVENDER, ROYAL, 1);
  doc.fillColor(ROYAL).text(titleText, pillX, y + 4.5, { width: titleW, align: "center" });
  y += 17 + 8;

  // ── Student info card ──
  const photoW = 62, photoH = 72;
  const cardPad = 10;
  const infoRows = 6;
  const cardH = Math.max(infoRows * 13.5, photoH) + cardPad * 2;
  roundedFillStroke(marginX, y, usableW, cardH, 7, CARD_BG, BORDER, 1);

  const infoTop = y + cardPad;
  const colW = (usableW - cardPad * 2 - photoW - 14) / 3;
  const col1X = marginX + cardPad;

  const col1 = [
    ["Name", (student.name || "").toUpperCase()],
    ["Date Of Birth", student.dob || "-"],
    ["Sex", student.gender || "-"],
    ["Class", classDoc?.name || "-"],
    ["Admission No.", student.admissionNo || "-"],
    ["Class Teacher", classDoc?.classTeacherName || "-"],
  ];
  const col2 = [
    ["Terminal Duration", settings.terminalDuration || "-"],
    ["Term Begins", settings.termBegins || "-"],
    ["Term End", settings.termEnd || "-"],
    ["Next Term Begins", settings.nextTermBegins || "-"],
    ["No. of Times Late", String(attendanceCounts.late ?? 0)],
    ["No. in Class", String(classSize)],
  ];
  const col3 = [
    ["No. of Times Present", String(attendanceCounts.present ?? 0)],
    ["No. of Times Absent", String(attendanceCounts.absent ?? 0)],
    ["Total Obtainable", obtainable.toFixed(1)],
    ["Total Obtained", obtained.toFixed(1)],
    ["Average %", avgPct.toFixed(1)],
    ["Position", overallRank ? ordinal(overallRank) : "-"],
  ];

  // Shrinks font size until the text fits on one line within maxW (never
  // wraps), falling back to an ellipsis if it still doesn't fit at the
  // minimum size — keeps long student names / class-teacher names tidy.
  function fitOneLine(text, x, yPos, maxW, baseSize, minSize, font, color) {
    let size = baseSize;
    doc.font(font);
    while (size > minSize && doc.fontSize(size).widthOfString(text) > maxW) {
      size -= 0.3;
    }
    let out = text;
    if (doc.fontSize(size).widthOfString(out) > maxW) {
      while (out.length > 1 && doc.widthOfString(out + "…") > maxW) {
        out = out.slice(0, -1);
      }
      out += "…";
    }
    doc.fontSize(size).fillColor(color).text(out, x, yPos, { width: maxW, lineBreak: false });
  }

  function drawInfoCol(items, x, w, highlight) {
    let iy = infoTop;
    items.forEach(([label, value], idx) => {
      doc.font("Helvetica-Bold").fontSize(6.9).fillColor(BLACK)
        .text(`${label}:`, x, iy, { width: w * 0.5, continued: false });
      const isAvg = highlight && label === "Average %";
      const isPos = highlight && label === "Position";
      if (isAvg || isPos) {
        fitOneLine(String(value), x + w * 0.5, iy - 0.5, w * 0.5, 7.3, 6, "Helvetica-Bold", isAvg ? SCORE_RED : ROYAL);
      } else {
        fitOneLine(String(value), x + w * 0.5, iy, w * 0.5, 7.2, 5.8, "Helvetica", BLACK);
      }
      iy += 13.5;
    });
    return iy;
  }

  drawInfoCol(col1, col1X, colW, false);
  drawInfoCol(col2, col1X + colW + 7, colW, false);
  drawInfoCol(col3, col1X + colW * 2 + 14, colW, true);

  // Photo box — rounded, royal-blue-framed
  const photoX = marginX + usableW - cardPad - photoW;
  roundedFillStroke(photoX, infoTop, photoW, photoH, 4, "#ffffff", ROYAL, 1.2);
  const photoSrc = resolvePhotoImage(student.avatarUrl);
  if (photoSrc) {
    doc.save();
    doc.roundedRect(photoX + 2, infoTop + 2, photoW - 4, photoH - 4, 3).clip();
    // "cover" (not "fit") so the photo fills the whole placeholder box —
    // fit would letterbox/leave gaps or crop off-center depending on the
    // source aspect ratio, which is what was making photos look like only
    // half showed. cover scales to fill the box completely, then centers
    // and clips the overflow evenly on both sides.
    doc.image(photoSrc, photoX + 2, infoTop + 2, {
      cover: [photoW - 4, photoH - 4],
      align: "center",
      valign: "center",
    });
    doc.restore();
  } else {
    doc.font("Helvetica").fontSize(7).fillColor(MUTED).text("PHOTO", photoX, infoTop + photoH / 2 - 4, { width: photoW, align: "center" });
  }

  y += cardH + 8;

  // ── Academic performance table ──
  const tableX = marginX + (usableW - TABLE_WIDTH) / 2;
  let ty = y;

  // Section label with flanking gold rules
  doc.font("Helvetica-Bold").fontSize(8.3).fillColor(ROYAL)
    .text("ACADEMIC PERFORMANCE", tableX, ty, { width: TABLE_WIDTH, align: "center" });
  ty += 13;

  const tableTopY = ty;

  // Header row A (grouped) — lavender fill, royal-blue bold text
  const groupHeaderH = ROW_H;
  const subHeaderH = ROW_H;
  let gx = tableX;
  cellRect(doc, gx, ty, SUBJECT_COL, groupHeaderH + subHeaderH, "SUBJECT", { bold: true, size: HEAD_SIZE, fill: LAVENDER_DARK, color: ROYAL });
  gx += SUBJECT_COL;
  cellRect(doc, gx, ty, MAX_COL, groupHeaderH + subHeaderH, "MAX", { bold: true, size: HEAD_SIZE, fill: LAVENDER_DARK, color: ROYAL });
  gx += MAX_COL;
  ["1ST TERM", "2ND TERM", "3RD TERM"].forEach((label) => {
    cellRect(doc, gx, ty, TERM_GROUP_W, groupHeaderH, label, { bold: true, size: HEAD_SIZE, fill: LAVENDER_DARK, color: ROYAL });
    gx += TERM_GROUP_W;
  });
  cellRect(doc, gx, ty, YEARLY_GROUP_W, groupHeaderH, "YEARLY", { bold: true, size: HEAD_SIZE, fill: LAVENDER_DARK, color: ROYAL });

  // Header row B (sub-columns)
  let sy = ty + groupHeaderH;
  gx = tableX + SUBJECT_COL + MAX_COL;
  for (let i = 0; i < 3; i++) {
    ["TST", "EXM", "MN", "RNK"].forEach((label, idx) => {
      const w = TERM_SUBCOLS[idx];
      cellRect(doc, gx, sy, w, subHeaderH, label, { bold: true, size: HEAD_SIZE, fill: LAVENDER, color: ROYAL });
      gx += w;
    });
  }
  ["TOTAL", "MEAN", "RANK", "GRD", "REMARKS"].forEach((label, idx) => {
    const w = YEARLY_SUBCOLS[idx];
    cellRect(doc, gx, sy, w, subHeaderH, label, { bold: true, size: HEAD_SIZE, fill: LAVENDER, color: ROYAL });
    gx += w;
  });

  ty += groupHeaderH + subHeaderH;
  const dataTopY = ty; // top of the first data row — used later to draw unbroken column dividers

  // Data rows — zebra striping + tinted grade/remarks cells
  rows.forEach((r, idx) => {
    const zebra = idx % 2 === 1 ? ZEBRA : "#ffffff";
    let x = tableX;
    cellRect(doc, x, ty, SUBJECT_COL, ROW_H, r.subject, { align: "left", size: CELL_SIZE, fill: zebra, bold: true, color: BLACK });
    x += SUBJECT_COL;
    cellRect(doc, x, ty, MAX_COL, ROW_H, r.max, { size: CELL_SIZE, fill: zebra });
    x += MAX_COL;
    [r.t1, r.t2, r.t3].forEach((cell) => {
      cellRect(doc, x, ty, TERM_SUBCOLS[0], ROW_H, cell.test, { size: CELL_SIZE, fill: zebra, color: scoreColor(cell.test) }); x += TERM_SUBCOLS[0];
      cellRect(doc, x, ty, TERM_SUBCOLS[1], ROW_H, cell.exam, { size: CELL_SIZE, fill: zebra, color: scoreColor(cell.exam) }); x += TERM_SUBCOLS[1];
      cellRect(doc, x, ty, TERM_SUBCOLS[2], ROW_H, cell.mn, {
        size: CELL_SIZE,
        bold: true,
        fill: zebra,
        color: cell.test !== "" ? scoreColor(cell.mn) : "#000",
      }); x += TERM_SUBCOLS[2];
      // RNK, like GRD and REMARKS, is always black — it's a position, not a score.
      cellRect(doc, x, ty, TERM_SUBCOLS[3], ROW_H, cell.rnk, { size: CELL_SIZE, fill: zebra, color: BLACK }); x += TERM_SUBCOLS[3];
    });
    cellRect(doc, x, ty, YEARLY_SUBCOLS[0], ROW_H, r.total, { size: CELL_SIZE, fill: zebra, color: scoreColor(r.total) }); x += YEARLY_SUBCOLS[0];
    const hasAnyGrade = r.t1.test !== "" || r.t2.test !== "" || r.t3.test !== "";
    const isFailing = hasAnyGrade && Number(r.mean) < 50;
    const meanColor = hasAnyGrade ? scoreColor(r.mean) : "#000";
    const gradeTint = isFailing ? FAIL_TINT : zebra;
    cellRect(doc, x, ty, YEARLY_SUBCOLS[1], ROW_H, r.mean, { size: CELL_SIZE, bold: true, fill: zebra, color: meanColor }); x += YEARLY_SUBCOLS[1];
    // RANK, GRD and REMARKS are always black, regardless of pass/fail.
    cellRect(doc, x, ty, YEARLY_SUBCOLS[2], ROW_H, r.rank, { size: CELL_SIZE, fill: zebra, color: BLACK }); x += YEARLY_SUBCOLS[2];
    cellRect(doc, x, ty, YEARLY_SUBCOLS[3], ROW_H, r.grade, { size: CELL_SIZE, bold: true, fill: gradeTint, color: BLACK }); x += YEARLY_SUBCOLS[3];
    cellRect(doc, x, ty, YEARLY_SUBCOLS[4], ROW_H, r.remark, { size: 5.3, fill: gradeTint, color: BLACK });
    ty += ROW_H;
  });

  // TOTAL MARKS row — lavender-tinted summary band. Per-term MN cell is the
  // straight SUM of every subject's MN for that term (never divided). The
  // YEARLY cell is term1 total + term2 total + term3 total, no division —
  // and only shows once Term 3 has actually been graded for this student.
  {
    let x = tableX;
    cellRect(doc, x, ty, SUBJECT_COL + MAX_COL, ROW_H, "TOTAL MARKS", { bold: true, size: CELL_SIZE, fill: LAVENDER, color: BLACK });
    x += SUBJECT_COL + MAX_COL;
    [
      [colTotals.t1a, colTotals.t1b, term1Total],
      [colTotals.t2a, colTotals.t2b, term2Total],
      [colTotals.t3a, colTotals.t3b, term3Total],
    ].forEach(([a, b, tot]) => {
      cellRect(doc, x, ty, TERM_SUBCOLS[0], ROW_H, a || "", { bold: true, size: CELL_SIZE, fill: LAVENDER, color: a ? scoreColor(a) : BLACK }); x += TERM_SUBCOLS[0];
      cellRect(doc, x, ty, TERM_SUBCOLS[1], ROW_H, b || "", { bold: true, size: CELL_SIZE, fill: LAVENDER, color: b ? scoreColor(b) : BLACK }); x += TERM_SUBCOLS[1];
      cellRect(doc, x, ty, TERM_SUBCOLS[2], ROW_H, tot ? tot.toFixed(1) : "", { bold: true, size: CELL_SIZE, fill: LAVENDER, color: a + b ? scoreColor(tot) : BLACK }); x += TERM_SUBCOLS[2];
      cellRect(doc, x, ty, TERM_SUBCOLS[3], ROW_H, "", { fill: LAVENDER }); x += TERM_SUBCOLS[3];
    });
    cellRect(doc, x, ty, YEARLY_SUBCOLS[0], ROW_H, yearlyTotalMarks !== null ? yearlyTotalMarks.toFixed(1) : "-", { bold: true, size: CELL_SIZE, fill: LAVENDER, color: yearlyTotalMarks !== null ? scoreColor(yearlyTotalMarks) : BLACK }); x += YEARLY_SUBCOLS[0];
    cellRect(doc, x, ty, YEARLY_SUBCOLS[1] + YEARLY_SUBCOLS[2] + YEARLY_SUBCOLS[3] + YEARLY_SUBCOLS[4], ROW_H, "", { fill: LAVENDER });
    ty += ROW_H;
  }
  // PERCENTAGE row — per-term MN cell is the sum of subject MNs DIVIDED by
  // the number of subjects. YEARLY cell is (1st % + 2nd % + 3rd %) / 3,
  // again only once Term 3 has actually been graded for this student.
  {
    let x = tableX;
    cellRect(doc, x, ty, SUBJECT_COL + MAX_COL, ROW_H, "PERCENTAGE", { bold: true, size: CELL_SIZE, fill: LAVENDER, color: BLACK });
    x += SUBJECT_COL + MAX_COL;
    [
      [colTotals.t1a, colTotals.t1b, term1Pct],
      [colTotals.t2a, colTotals.t2b, term2Pct],
      [colTotals.t3a, colTotals.t3b, term3Pct],
    ].forEach(([a, b, pct]) => {
      cellRect(doc, x, ty, TERM_SUBCOLS[0] + TERM_SUBCOLS[1], ROW_H, "", { fill: LAVENDER }); x += TERM_SUBCOLS[0] + TERM_SUBCOLS[1];
      cellRect(doc, x, ty, TERM_SUBCOLS[2], ROW_H, a + b ? pct.toFixed(1) : "0.0", { bold: true, size: CELL_SIZE, fill: LAVENDER, color: a + b ? scoreColor(pct) : BLACK }); x += TERM_SUBCOLS[2];
      cellRect(doc, x, ty, TERM_SUBCOLS[3], ROW_H, "", { fill: LAVENDER }); x += TERM_SUBCOLS[3];
    });
    cellRect(doc, x, ty, YEARLY_SUBCOLS[0], ROW_H, yearlyPercentage !== null ? yearlyPercentage.toFixed(1) : "-", { bold: true, size: CELL_SIZE, fill: LAVENDER, color: yearlyPercentage !== null ? scoreColor(yearlyPercentage) : BLACK }); x += YEARLY_SUBCOLS[0];
    cellRect(doc, x, ty, YEARLY_SUBCOLS[1] + YEARLY_SUBCOLS[2] + YEARLY_SUBCOLS[3] + YEARLY_SUBCOLS[4], ROW_H, "", { fill: LAVENDER });
    ty += ROW_H;
  }

  // The TOTAL MARKS / PERCENTAGE summary rows merge several columns into
  // wide label cells (e.g. SUBJECT+MAX, or MEAN+RANK+GRD+REMARKS), which
  // drops the vertical divider between those columns for just those rows.
  // Redraw every column divider as one unbroken line from the top of the
  // data rows down to the bottom of the last summary row, so every
  // downward grid line is equal length and touches the bottom border.
  {
    const dividerXs = [];
    let cx = tableX;
    const colWidths = [SUBJECT_COL, MAX_COL, ...TERM_SUBCOLS, ...TERM_SUBCOLS, ...TERM_SUBCOLS, ...YEARLY_SUBCOLS];
    colWidths.forEach((w) => {
      cx += w;
      dividerXs.push(cx);
    });
    dividerXs.pop(); // last boundary is the table's outer right edge — the frame below covers it
    dividerXs.forEach((dx) => {
      doc.moveTo(dx, dataTopY).lineTo(dx, ty).lineWidth(0.6).stroke(GRID_BLUE);
    });
  }

  // Crisp rounded royal-blue frame around the whole table
  doc.roundedRect(tableX - 1, tableTopY - 1, TABLE_WIDTH + 2, ty - tableTopY + 1, 3).lineWidth(1.3).stroke(GRID_BLUE);

  ty += 7;

  // ── Grading key — "KEYS TO RATING" header bar (lavender header, cream
  // legend cells, per the school's palette) ──
  const keys = [
    "100-75 (EXCELLENT)", "74-70 (V. GOOD)", "69-65 (V. GOOD)", "64-60 (V. GOOD)", "59-55 (GOOD)",
    "54-50 (GOOD)", "49-45 (FAIR)", "44-40 (FAIR)", "39-0 (FAIL)",
  ];
  cellRect(doc, tableX, ty, TABLE_WIDTH, ROW_H, "KEYS TO RATING", { bold: true, size: HEAD_SIZE + 0.5, fill: LAVENDER_DARK, color: ROYAL });
  ty += ROW_H;
  const keyW = TABLE_WIDTH / keys.length;
  let kx = tableX;
  keys.forEach((k) => {
    cellRect(doc, kx, ty, keyW, ROW_H, k, { size: 5.7, bold: true, fill: CREAM, color: BLACK });
    kx += keyW;
  });
  ty += ROW_H + 8;

  // ── Comments, signatures & promotion status — with the official
  // stamp broken out into its own section on the right, shown clean
  // (no outline) and as large as the space allows ──
  const stampColW = 104;
  const infoColW = TABLE_WIDTH - stampColW;
  const commentRowH = 24;
  const commentsBlockH = commentRowH * 3;
  const blockTop = ty;
  const cPad = 8;
  const signX = tableX + cPad;
  const signZoneX = tableX + infoColW - 158; // reserved for Sign./Date on the two comment rows

  roundedFillStroke(tableX, blockTop, infoColW, commentsBlockH, 5, "#fdfdfd", GRID_BLUE, 0.8);

  function commentRow(idx, accentColor, label, value, { withSignDate = false, valueColor = BLACK } = {}) {
    const ry = blockTop + idx * commentRowH;
    if (idx > 0) doc.moveTo(tableX, ry).lineTo(tableX + infoColW, ry).lineWidth(0.6).stroke(GRID_BLUE);
    doc.rect(tableX, ry, 3, commentRowH).fill(accentColor);
    const midY = ry + commentRowH / 2 - 4;
    doc.font("Helvetica-Bold").fontSize(8).fillColor(BLACK).text(label, signX, midY, { lineBreak: false });
    const labelW = doc.widthOfString(label);
    const valueX = signX + labelW + 6;
    const valueMaxW = (withSignDate ? signZoneX : tableX + infoColW - cPad) - valueX - 6;
    fitOneLine(value, valueX, midY, Math.max(valueMaxW, 20), 8, 6, "Helvetica-Oblique", valueColor);
    if (withSignDate) {
      const dateStr = new Date().toLocaleDateString("en-GB");
      doc.font("Helvetica-Bold").fontSize(8).fillColor(BLACK).text("Sign.:", signZoneX, midY);
      doc.font("Helvetica").fontSize(8).fillColor(BLACK).text("_________", signZoneX + 24, midY);
      doc.font("Helvetica-Bold").fontSize(8).fillColor(BLACK).text("Date:", signZoneX + 88, midY);
      doc.font("Helvetica").fontSize(8).fillColor(BLACK).text(dateStr, signZoneX + 114, midY);
    }
  }

  commentRow(0, ROYAL, "Class Teacher's Comments:", "Good, Keep improving", { withSignDate: true });
  commentRow(1, CYAN, "Principal's Comments:", "Good, Keep improving", { withSignDate: true });

  // Promotion status — the real, per-student decision from the auto-
  // promotion engine (see utils/promotion.js and routes/promotions.js),
  // not a static settings note. Nothing shows here until the General Admin
  // has actually set the NEXT academic year in Settings — until then the
  // current year hasn't been evaluated yet, so this stays blank rather
  // than guessing. The VALUE text itself is colored by outcome — blue for
  // Promoted, red for Repeat/Pending, black for Graduating/unset — while
  // the little accent bar on the left stays red for anything not-yet-
  // resolved-favorably, same as before.
  let statusText = "-";
  let statusValueColor = BLACK;
  let isNegative = false;
  if (promotion) {
    if (promotion.status === "Promoted") {
      statusText = promotion.toClass?.name
        ? `Promoted to ${promotion.toClass.name}`
        : "Promoted";
      statusValueColor = SCORE_BLUE;
    } else if (promotion.status === "Repeat") {
      statusText = "To Repeat";
      isNegative = true;
      statusValueColor = SCORE_RED;
    } else if (promotion.status === "Pending") {
      statusText = "Pending Promotion (awaiting Admin decision)";
      isNegative = true;
      statusValueColor = SCORE_RED;
    } else if (promotion.status === "Graduating") {
      statusText = "Graduating";
    }
  }
  const statusColor = isNegative ? SCORE_RED : BLACK;
  commentRow(2, statusColor, "Promotion Status:", statusText, {
    withSignDate: false,
    valueColor: statusValueColor,
  });

  // Right: the official stamp gets its own section — a plain vertical
  // divider (no boxed outline) with the stamp shown as large as the
  // space allows.
  const stampX = tableX + infoColW;
  doc.moveTo(stampX, blockTop).lineTo(stampX, blockTop + commentsBlockH).lineWidth(0.8).stroke(GRID_BLUE);
  if (fs.existsSync(STAMP_PATH)) {
    const sPad = 3;
    doc.image(STAMP_PATH, stampX + sPad, blockTop + sPad, {
      fit: [stampColW - sPad * 2, commentsBlockH - sPad * 2],
      align: "center",
      valign: "center",
    });
  } else {
    doc.font("Helvetica").fontSize(6).fillColor(MUTED)
      .text("OFFICIAL STAMP", stampX, blockTop + commentsBlockH / 2 - 4, { width: stampColW, align: "center" });
  }

  ty = blockTop + commentsBlockH + 8;
  doc.moveTo(tableX, ty).lineTo(tableX + TABLE_WIDTH, ty).lineWidth(0.7).stroke(GRID_BLUE);
  ty += 4;
  doc.font("Helvetica").fontSize(6.6).fillColor(MUTED)
    .text(`Date printed: ${new Date().toString().split(" GMT")[0]}  |  Any alteration invalidates this statement`, tableX, ty, { width: TABLE_WIDTH, align: "center" });

    if (!isBulk) doc.end();
}

module.exports = generateReportCard;
