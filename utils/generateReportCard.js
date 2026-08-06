const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const { ordinal, gradeFor, ageFromDob, rankDescending } = require("./reportCardHelpers");

const LOGO_PATH = path.join(__dirname, "..", "assets", "logo.jpeg");

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

const ROW_H = 14.5;
const CELL_SIZE = 6.3; // data cell font size (was 7 in the wider landscape layout)
const HEAD_SIZE = 5.7; // sub-header font size (was 6.5)

// Per the school's instruction: any percentage/grade value below 50% is
// shown in red, 50% and above in blue.
const COLOR_FAIL = "#dc2626";
const COLOR_PASS = "#1d4ed8";
const gradeColor = (pct) => (pct >= 50 ? COLOR_PASS : COLOR_FAIL);

function cellRect(doc, x, y, w, h, text, opts = {}) {
  const { align = "center", bold = false, size = CELL_SIZE, fill = null, valign = "middle", color = "#000" } = opts;
  if (fill) {
    doc.save().rect(x, y, w, h).fill(fill).restore();
  }
  doc.rect(x, y, w, h).stroke("#000");
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
async function generateReportCard(res, { student, classDoc, subjects, terms, termLabel, session, settings, attendanceCounts, Grade, User, doc: sharedDoc, isBulk = false }) {
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

  // Yearly per-subject mean across all classmates, for the YEARLY rank column
  function yearlyStatsFor(studentId, subject) {
    const rows = gradesFor(studentId, subject);
    let total = 0, termCount = 0;
    rows.forEach((g) => {
      if (g) { total += ((g.test || 0) + (g.examScore || 0)) / 2; termCount += 1; }
    });
    // mean = the average of this subject's per-term totals (each already a
    // 0-100 percentage), NOT total/termCount*2 — that used to silently
    // halve every mean (e.g. a 75% average was scored as if it were 37.5%,
    // which is well below FAIL) and misassign the letter grade as a result.
    const mean = termCount ? total / termCount : 0;
    return { total, mean, termCount };
  }
  function yearlyRank(subject, studentId) {
    const ids = [...new Set(allGrades.filter((g) => g.subject === subject).map((g) => String(g.student)))];
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
    const { total, mean } = yearlyStatsFor(student._id, subject);
    const rnkY = yearlyRank(subject, student._id);
    const { grade, remark } = gradeFor(mean);
    return {
      subject,
      max: 100,
      t1: termCell(t1, 0),
      t2: termCell(t2, 1),
      t3: termCell(t3, 2),
      total: total.toFixed(1).replace(/\.0$/, ""),
      mean: mean.toFixed(1),
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

  // ── Palette ──
  const NAVY = "#0f2542";
  const NAVY_2 = "#1c3d63";
  const GOLD = "#c9a227";
  const GOLD_LIGHT = "#f6e6b4";
  const SLATE = "#25324a";
  const MUTED = "#647089";
  const CARD_BG = "#f7f9fc";
  const BORDER = "#dde3ee";
  const ZEBRA = "#f4f7fb";
  const PASS_TINT = "#e7f5ec";
  const FAIL_TINT = "#fce9e8";

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
    doc.roundedRect(x - 2, y - 2, s + 4, s + 4, radius + 2).lineWidth(1).stroke(GOLD);
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

  // ── Header banner (gradient navy, rounded, crest medallions) ──
  let y = 24;
  const bannerH = 64;
  const grad = doc.linearGradient(marginX, y, marginX + usableW, y + bannerH);
  grad.stop(0, NAVY).stop(1, NAVY_2);
  doc.roundedRect(marginX, y, usableW, bannerH, 8).fill(grad);

  if (hasLogo) {
    circleImage(marginX + 34, y + bannerH / 2, 22, LOGO_PATH);
    circleImage(marginX + usableW - 34, y + bannerH / 2, 22, LOGO_PATH);
  }

  const textX = marginX + 66;
  const textW = usableW - 132;
  doc.font("Helvetica-Bold").fontSize(14).fillColor("#ffffff")
    .text((settings.schoolName || "Nurul-Haq Islamic Academy").toUpperCase(), textX, y + 7, { width: textW, align: "center" });
  doc.font("Helvetica").fontSize(7.3).fillColor("#c7d4e6")
    .text((settings.address || "").toUpperCase(), textX, y + 24, { width: textW, align: "center" });
  doc.font("Helvetica").fontSize(6.8).fillColor(GOLD_LIGHT)
    .text(`"${settings.motto || "Knowledge and Perseverance"}"`, textX, y + 35, { width: textW, align: "center" });
  doc.font("Helvetica").fontSize(6.8).fillColor("#c7d4e6")
    .text(`Tel: ${settings.phone || ""}`, textX, y + 46, { width: textW, align: "center" });

  y += bannerH + 8;

  // ── Gold accent divider with a small diamond ornament ──
  doc.moveTo(marginX, y).lineTo(marginX + usableW / 2 - 8, y).lineWidth(1.4).stroke(GOLD);
  doc.moveTo(marginX + usableW / 2 + 8, y).lineTo(marginX + usableW, y).lineWidth(1.4).stroke(GOLD);
  doc.save();
  doc.translate(marginX + usableW / 2, y).rotate(45);
  doc.rect(-4, -4, 8, 8).fill(GOLD);
  doc.restore();
  y += 10;

  // ── Title pill ──
  const titleText = `${session} · ${termLabel.toUpperCase()} PROGRESS REPORT`;
  doc.font("Helvetica-Bold").fontSize(9.5);
  const titleW = doc.widthOfString(titleText) + 28;
  const pillX = marginX + (usableW - titleW) / 2;
  roundedFillStroke(pillX, y, titleW, 17, 8.5, GOLD_LIGHT, GOLD, 1);
  doc.fillColor(NAVY).text(titleText, pillX, y + 4.5, { width: titleW, align: "center" });
  y += 17 + 8;

  // ── Student info card ──
  const photoW = 62, photoH = 72;
  const cardPad = 10;
  const infoRows = 7;
  const cardH = Math.max(infoRows * 13.5, photoH) + cardPad * 2;
  roundedFillStroke(marginX, y, usableW, cardH, 7, CARD_BG, BORDER, 1);

  const infoTop = y + cardPad;
  const colW = (usableW - cardPad * 2 - photoW - 14) / 3;
  const col1X = marginX + cardPad;

  const col1 = [
    ["Name", (student.name || "").toUpperCase()],
    ["Age", ageFromDob(student.dob).replace(" years, ", "y ").replace(" months and ", "m ").replace(" days", "d")],
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
      doc.font("Helvetica-Bold").fontSize(6.9).fillColor(MUTED)
        .text(`${label}:`, x, iy, { width: w * 0.5, continued: false });
      const isAvg = highlight && label === "Average %";
      const isPos = highlight && label === "Position";
      if (isAvg || isPos) {
        fitOneLine(String(value), x + w * 0.5, iy - 0.5, w * 0.5, 7.3, 6, "Helvetica-Bold", isAvg ? gradeColor(avgPct) : GOLD);
      } else {
        fitOneLine(String(value), x + w * 0.5, iy, w * 0.5, 7.2, 5.8, "Helvetica", SLATE);
      }
      iy += 13.5;
    });
    return iy;
  }

  drawInfoCol(col1, col1X, colW, false);
  drawInfoCol(col2, col1X + colW + 7, colW, false);
  drawInfoCol(col3, col1X + colW * 2 + 14, colW, true);

  // Photo box — rounded, gold-framed
  const photoX = marginX + usableW - cardPad - photoW;
  roundedFillStroke(photoX, infoTop, photoW, photoH, 4, "#ffffff", GOLD, 1.2);
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
  doc.font("Helvetica-Bold").fontSize(8.3).fillColor(NAVY)
    .text("ACADEMIC PERFORMANCE", tableX, ty, { width: TABLE_WIDTH, align: "center" });
  ty += 13;

  const tableTopY = ty;

  // Header row A (grouped) — navy fill, white bold text
  const groupHeaderH = ROW_H;
  const subHeaderH = ROW_H;
  let gx = tableX;
  cellRect(doc, gx, ty, SUBJECT_COL, groupHeaderH + subHeaderH, "SUBJECT", { bold: true, size: HEAD_SIZE, fill: NAVY, color: "#ffffff" });
  gx += SUBJECT_COL;
  cellRect(doc, gx, ty, MAX_COL, groupHeaderH + subHeaderH, "MAX", { bold: true, size: HEAD_SIZE, fill: NAVY, color: "#ffffff" });
  gx += MAX_COL;
  ["1ST TERM", "2ND TERM", "3RD TERM"].forEach((label) => {
    cellRect(doc, gx, ty, TERM_GROUP_W, groupHeaderH, label, { bold: true, size: HEAD_SIZE, fill: NAVY_2, color: "#ffffff" });
    gx += TERM_GROUP_W;
  });
  cellRect(doc, gx, ty, YEARLY_GROUP_W, groupHeaderH, "YEARLY", { bold: true, size: HEAD_SIZE, fill: NAVY_2, color: "#ffffff" });

  // Header row B (sub-columns)
  let sy = ty + groupHeaderH;
  gx = tableX + SUBJECT_COL + MAX_COL;
  for (let i = 0; i < 3; i++) {
    ["TEST", "EXAM", "MN", "RNK"].forEach((label, idx) => {
      const w = TERM_SUBCOLS[idx];
      cellRect(doc, gx, sy, w, subHeaderH, label, { bold: true, size: HEAD_SIZE, fill: "#31527e", color: "#ffffff" });
      gx += w;
    });
  }
  ["TOTAL", "MEAN", "RANK", "GRADE", "REMARKS"].forEach((label, idx) => {
    const w = YEARLY_SUBCOLS[idx];
    cellRect(doc, gx, sy, w, subHeaderH, label, { bold: true, size: HEAD_SIZE, fill: "#31527e", color: "#ffffff" });
    gx += w;
  });

  ty += groupHeaderH + subHeaderH;

  // Data rows — zebra striping + tinted grade/remarks cells
  rows.forEach((r, idx) => {
    const zebra = idx % 2 === 1 ? ZEBRA : "#ffffff";
    let x = tableX;
    cellRect(doc, x, ty, SUBJECT_COL, ROW_H, r.subject, { align: "left", size: CELL_SIZE, fill: zebra, bold: true, color: SLATE });
    x += SUBJECT_COL;
    cellRect(doc, x, ty, MAX_COL, ROW_H, r.max, { size: CELL_SIZE, fill: zebra });
    x += MAX_COL;
    [r.t1, r.t2, r.t3].forEach((cell) => {
      cellRect(doc, x, ty, TERM_SUBCOLS[0], ROW_H, cell.test, { size: CELL_SIZE, fill: zebra, color: cell.test !== "" ? gradeColor(Number(cell.test)) : "#000" }); x += TERM_SUBCOLS[0];
      cellRect(doc, x, ty, TERM_SUBCOLS[1], ROW_H, cell.exam, { size: CELL_SIZE, fill: zebra, color: cell.exam !== "" ? gradeColor(Number(cell.exam)) : "#000" }); x += TERM_SUBCOLS[1];
      cellRect(doc, x, ty, TERM_SUBCOLS[2], ROW_H, cell.mn, {
        size: CELL_SIZE,
        bold: true,
        fill: zebra,
        color: cell.test !== "" ? gradeColor(Number(cell.mn)) : "#000",
      }); x += TERM_SUBCOLS[2];
      cellRect(doc, x, ty, TERM_SUBCOLS[3], ROW_H, cell.rnk, { size: CELL_SIZE, fill: zebra }); x += TERM_SUBCOLS[3];
    });
    cellRect(doc, x, ty, YEARLY_SUBCOLS[0], ROW_H, r.total, { size: CELL_SIZE, fill: zebra }); x += YEARLY_SUBCOLS[0];
    const hasAnyGrade = r.t1.test !== "" || r.t2.test !== "" || r.t3.test !== "";
    const meanColor = hasAnyGrade ? gradeColor(Number(r.mean)) : "#000";
    const gradeTint = hasAnyGrade ? (meanColor === COLOR_PASS ? PASS_TINT : FAIL_TINT) : zebra;
    cellRect(doc, x, ty, YEARLY_SUBCOLS[1], ROW_H, r.mean, { size: CELL_SIZE, bold: true, fill: zebra, color: meanColor }); x += YEARLY_SUBCOLS[1];
    cellRect(doc, x, ty, YEARLY_SUBCOLS[2], ROW_H, r.rank, { size: CELL_SIZE, fill: zebra }); x += YEARLY_SUBCOLS[2];
    cellRect(doc, x, ty, YEARLY_SUBCOLS[3], ROW_H, r.grade, { size: CELL_SIZE, bold: true, fill: gradeTint, color: meanColor }); x += YEARLY_SUBCOLS[3];
    cellRect(doc, x, ty, YEARLY_SUBCOLS[4], ROW_H, r.remark, { size: 5.3, fill: gradeTint, color: meanColor });
    ty += ROW_H;
  });

  // TOTAL MARKS row — gold-tinted summary band
  {
    let x = tableX;
    cellRect(doc, x, ty, SUBJECT_COL + MAX_COL, ROW_H, "TOTAL MARKS", { bold: true, size: CELL_SIZE, fill: GOLD_LIGHT, color: NAVY });
    x += SUBJECT_COL + MAX_COL;
    const subjCount = subjects.length || 1;
    [
      [colTotals.t1a, colTotals.t1b, (colTotals.t1a + colTotals.t1b) / (2 * subjCount)],
      [colTotals.t2a, colTotals.t2b, (colTotals.t2a + colTotals.t2b) / (2 * subjCount)],
      [colTotals.t3a, colTotals.t3b, (colTotals.t3a + colTotals.t3b) / (2 * subjCount)],
    ].forEach(([a, b, mn]) => {
      cellRect(doc, x, ty, TERM_SUBCOLS[0], ROW_H, a || "", { bold: true, size: CELL_SIZE, fill: GOLD_LIGHT, color: NAVY }); x += TERM_SUBCOLS[0];
      cellRect(doc, x, ty, TERM_SUBCOLS[1], ROW_H, b || "", { bold: true, size: CELL_SIZE, fill: GOLD_LIGHT, color: NAVY }); x += TERM_SUBCOLS[1];
      cellRect(doc, x, ty, TERM_SUBCOLS[2], ROW_H, mn ? mn.toFixed(1) : "", { bold: true, size: CELL_SIZE, fill: GOLD_LIGHT, color: a + b ? gradeColor(mn) : NAVY }); x += TERM_SUBCOLS[2];
      cellRect(doc, x, ty, TERM_SUBCOLS[3], ROW_H, "", { fill: GOLD_LIGHT }); x += TERM_SUBCOLS[3];
    });
    cellRect(doc, x, ty, YEARLY_SUBCOLS[0], ROW_H, obtained.toFixed(1), { bold: true, size: CELL_SIZE, fill: GOLD_LIGHT, color: NAVY }); x += YEARLY_SUBCOLS[0];
    cellRect(doc, x, ty, YEARLY_SUBCOLS[1] + YEARLY_SUBCOLS[2] + YEARLY_SUBCOLS[3] + YEARLY_SUBCOLS[4], ROW_H, "", { fill: GOLD_LIGHT });
    ty += ROW_H;
  }
  // PERCENTAGE row
  {
    let x = tableX;
    cellRect(doc, x, ty, SUBJECT_COL + MAX_COL, ROW_H, "PERCENTAGE", { bold: true, size: CELL_SIZE, fill: GOLD_LIGHT, color: NAVY });
    x += SUBJECT_COL + MAX_COL;
    const subjCount = subjects.length || 1;
    const pctOf = (a, b) => (a + b ? ((a + b) / (2 * subjCount)).toFixed(1) : "0.0");
    [
      [colTotals.t1a, colTotals.t1b],
      [colTotals.t2a, colTotals.t2b],
      [colTotals.t3a, colTotals.t3b],
    ].forEach(([a, b]) => {
      cellRect(doc, x, ty, TERM_SUBCOLS[0] + TERM_SUBCOLS[1], ROW_H, "", { fill: GOLD_LIGHT }); x += TERM_SUBCOLS[0] + TERM_SUBCOLS[1];
      cellRect(doc, x, ty, TERM_SUBCOLS[2], ROW_H, pctOf(a, b), { bold: true, size: CELL_SIZE, fill: GOLD_LIGHT, color: a + b ? gradeColor((a + b) / (2 * subjCount)) : NAVY }); x += TERM_SUBCOLS[2];
      cellRect(doc, x, ty, TERM_SUBCOLS[3], ROW_H, "", { fill: GOLD_LIGHT }); x += TERM_SUBCOLS[3];
    });
    cellRect(doc, x, ty, YEARLY_SUBCOLS[0], ROW_H, avgPct.toFixed(1), { bold: true, size: CELL_SIZE, fill: GOLD_LIGHT, color: obtainable ? gradeColor(avgPct) : NAVY }); x += YEARLY_SUBCOLS[0];
    cellRect(doc, x, ty, YEARLY_SUBCOLS[1] + YEARLY_SUBCOLS[2] + YEARLY_SUBCOLS[3] + YEARLY_SUBCOLS[4], ROW_H, "", { fill: GOLD_LIGHT });
    ty += ROW_H;
  }

  // Crisp rounded navy frame around the whole table
  doc.roundedRect(tableX - 1, tableTopY - 1, TABLE_WIDTH + 2, ty - tableTopY + 1, 3).lineWidth(1.3).stroke(NAVY);

  ty += 7;

  // ── Grading key — color-coded legend strip ──
  const bandColors = [
    "#1b7a3d", "#2d8f4e", "#3fa25f", "#59b072", "#8fbf3f",
    "#c9a227", "#e08a2c", "#e0672c", "#c8402f",
  ];
  const keys = [
    "100-75 EXCELLENT", "74-70 V.GOOD", "69-65 V.GOOD", "64-60 V.GOOD", "59-55 GOOD",
    "54-50 GOOD", "49-45 FAIR", "44-40 FAIR", "39-0 FAIL",
  ];
  doc.font("Helvetica-Bold").fontSize(6.4).fillColor(MUTED)
    .text("GRADING KEY", tableX, ty, { width: TABLE_WIDTH });
  ty += 9;
  const keysRow1 = keys.slice(0, 5);
  const keysRow2 = keys.slice(5);
  const colorsRow1 = bandColors.slice(0, 5);
  const colorsRow2 = bandColors.slice(5);
  let keyW = TABLE_WIDTH / 5;
  let kx = tableX;
  keysRow1.forEach((k, i) => {
    roundedFillStroke(kx + 1, ty, keyW - 2, ROW_H - 1, 3, "#fbfbfb", "#e4e4e4", 0.6);
    doc.circle(kx + 8, ty + (ROW_H - 1) / 2, 2.6).fill(colorsRow1[i]);
    doc.font("Helvetica-Bold").fontSize(5.4).fillColor(SLATE).text(k, kx + 13, ty + 4, { width: keyW - 16 });
    kx += keyW;
  });
  ty += ROW_H;
  kx = tableX;
  keysRow2.forEach((k, i) => {
    roundedFillStroke(kx + 1, ty, keyW - 2, ROW_H - 1, 3, "#fbfbfb", "#e4e4e4", 0.6);
    doc.circle(kx + 8, ty + (ROW_H - 1) / 2, 2.6).fill(colorsRow2[i]);
    doc.font("Helvetica-Bold").fontSize(5.4).fillColor(SLATE).text(k, kx + 13, ty + 4, { width: keyW - 16 });
    kx += keyW;
  });
  ty += ROW_H + 10;

  // ── Comments & signatures — bordered cards ──
  const commentH = 40;
  roundedFillStroke(tableX, ty, TABLE_WIDTH, commentH, 5, "#fdfdfd", BORDER, 1);
  const cPad = 8;
  let cy = ty + cPad;
  const signX = tableX + cPad;
  const dateX = tableX + TABLE_WIDTH - 130;

  doc.rect(tableX, ty, 3, commentH).fill(GOLD);
  doc.font("Helvetica-Bold").fontSize(7.5).fillColor(NAVY).text("Class Teacher's Comments:", signX, cy);
  doc.font("Helvetica-Oblique").fillColor(SLATE).text("Good, Keep improving", signX + 118, cy);
  cy += 13;
  doc.font("Helvetica-Bold").fontSize(7.5).fillColor(NAVY).text("Sign.:", signX, cy);
  doc.font("Helvetica").fillColor(SLATE).text("_______________", signX + 30, cy);
  doc.font("Helvetica-Bold").fillColor(NAVY).text("Date:", dateX, cy);
  doc.font("Helvetica").fillColor(SLATE).text(new Date().toLocaleDateString("en-GB"), dateX + 28, cy);
  ty += commentH + 6;

  roundedFillStroke(tableX, ty, TABLE_WIDTH, commentH, 5, "#fdfdfd", BORDER, 1);
  doc.rect(tableX, ty, 3, commentH).fill(NAVY);
  cy = ty + cPad;
  doc.font("Helvetica-Bold").fontSize(7.5).fillColor(NAVY).text("Principal's Comments:", signX, cy);
  doc.font("Helvetica-Oblique").fillColor(SLATE).text("Good, Keep improving", signX + 118, cy);
  cy += 13;
  doc.font("Helvetica-Bold").fontSize(7.5).fillColor(NAVY).text("Sign.:", signX, cy);
  doc.font("Helvetica").fillColor(SLATE).text("_______________", signX + 30, cy);
  doc.font("Helvetica-Bold").fillColor(NAVY).text("Date:", dateX, cy);
  doc.font("Helvetica").fillColor(SLATE).text(new Date().toLocaleDateString("en-GB"), dateX + 28, cy);
  ty += commentH + 10;

  // Promotion status badge — colored green for a positive outcome, amber/red
  // when the note signals a repeat/trial/withdrawal, so the badge never
  // misleadingly shows "success" green for a negative outcome.
  const statusText = settings.promotionStatusNote || "-";
  const isNegative = /repeat|trial|not\s*promoted|withdraw/i.test(statusText);
  const statusColor = isNegative ? "#b3401f" : "#1b7a3d";
  const statusTint = isNegative ? FAIL_TINT : PASS_TINT;
  doc.font("Helvetica-Bold").fontSize(7.5).fillColor(NAVY).text("Promotion Status:", tableX, ty + 3);
  doc.font("Helvetica-Bold").fontSize(7);
  const stW = doc.widthOfString(statusText) + 16;
  roundedFillStroke(tableX + 100, ty, stW, 15, 7.5, statusTint, statusColor, 0.8);
  doc.fillColor(statusColor).text(statusText, tableX + 100, ty + 4, { width: stW, align: "center" });

  // Official stamp placeholder (bottom-right) — a dotted circle for the
  // Principal/Admin to press the school's real rubber stamp onto, rather
  // than a printed copy of the logo standing in for the stamp.
  {
    const r = 24;
    const cx = tableX + TABLE_WIDTH - r - 4;
    const cy2 = ty - 2;
    doc.save();
    doc.dash(1.5, { space: 2.2 });
    doc.circle(cx, cy2, r).lineWidth(1).stroke(MUTED);
    doc.undash();
    doc.restore();
    doc.font("Helvetica").fontSize(5.4).fillColor(MUTED)
      .text("OFFICIAL STAMP", cx - r, cy2 - 4, { width: r * 2, align: "center" });
  }

  ty += 30;
  doc.moveTo(tableX, ty).lineTo(tableX + TABLE_WIDTH, ty).lineWidth(0.7).stroke(GOLD);
  ty += 4;
  doc.font("Helvetica").fontSize(6.3).fillColor(MUTED)
    .text(`Date printed: ${new Date().toString().split(" GMT")[0]}  |  Any alteration invalidates this statement`, tableX, ty, { width: TABLE_WIDTH, align: "center" });

  if (!isBulk) doc.end();
}

module.exports = generateReportCard;
