// Draws one CR80-sized ID card (3.375in x 2.125in — the same physical size
// as a real bank/ID card) as a page on the given PDFKit document. Used for
// both the single ID-card download and the bulk ID-card PDF (one card per
// page in that case).
//
// Design: a navy-to-blue gradient photo panel with a slanted gold seam,
// the school crest in a square badge, a circular photo badge, and — on the
// white half — the student's name, level, admission no., date of birth,
// and a QR code that encodes the student's details for a quick check.

const fs = require("fs");
const path = require("path");
const QRCode = require("qrcode");

const CARD_W = 3.375 * 72;
const CARD_H = 2.125 * 72;

const LOGO_PATH = path.join(__dirname, "..", "assets", "logo.jpeg");

const NAVY_DARK = "#0a1f3d";
const BLUE = "#1c6fb0";
const GOLD = "#d9b25c";
const GOLD_LIGHT = "#f2e2ba";
const TEXT_GOLD = "#a97a1f";
const INK = "#0b2540";
const MUTED = "#5c7794";

function dataUrlToBuffer(dataUrl) {
  if (!dataUrl) return null;
  if (typeof dataUrl === "string" && dataUrl.startsWith("data:")) {
    try {
      const base64 = dataUrl.split(",")[1];
      return Buffer.from(base64, "base64");
    } catch (e) {
      return null;
    }
  }
  if (typeof dataUrl === "string" && fs.existsSync(dataUrl)) return dataUrl;
  return null;
}

// How many years an ID card is valid for, counted from the year it's
// generated, based on how many years the student has left at their
// current level:
//   Nursery — 3 years at Nursery 1, 2 at Nursery 2, 1 at Nursery 3
//   Primary — 6 years at Class 1, 5 at Class 2, ... 1 at Class 6
//   JSS     — 3 years at JSS 1, 2 at JSS 2, 1 at JSS 3
//   SSS     — 3 years at SSS 1, 2 at SSS 2, 1 at SSS 3
const LEVEL_MAX_YEARS = { Nursery: 3, Primary: 6, JSS: 3, SSS: 3 };
const LEVEL_GRADE_PATTERN = {
  Nursery: /Nursery\s*(\d+)/i,
  Primary: /Class\s*(\d+)/i,
  JSS: /JSS\s*(\d+)/i,
  SSS: /SSS\s*(\d+)/i,
};

function computeExpiryYear(level, className) {
  const currentYear = new Date().getFullYear();
  const maxYears = LEVEL_MAX_YEARS[level] || 3;

  let grade = null;
  const pattern = LEVEL_GRADE_PATTERN[level];
  const nameStr = className || "";
  const specificMatch = pattern && nameStr.match(pattern);
  if (specificMatch) {
    grade = parseInt(specificMatch[1], 10);
  } else {
    const genericMatch = nameStr.match(/(\d+)/);
    if (genericMatch) grade = parseInt(genericMatch[1], 10);
  }

  let yearsRemaining = grade == null ? maxYears : maxYears - grade + 1;
  if (Number.isNaN(yearsRemaining)) yearsRemaining = maxYears;
  yearsRemaining = Math.min(Math.max(yearsRemaining, 1), maxYears);

  // The year of issue counts as year 1 of validity (e.g. a Class 1 card
  // issued in 2026 with 6 years of validity expires in 2031, not 2032).
  return currentYear + yearsRemaining - 1;
}

async function drawIdCard(doc, { student, schoolName = "Nurul-Haq School", motto = "" }) {
  const W = CARD_W,
    H = CARD_H;

  // ---- base ----
  doc.rect(0, 0, W, H).fill("#ffffff");

  // ---- left band: slanted navy-to-blue gradient panel ----
  const bandTopW = 112,
    bandBottomW = 96;
  const grad = doc.linearGradient(0, 0, 0, H);
  grad.stop(0, NAVY_DARK).stop(1, BLUE);
  doc.save();
  doc.moveTo(0, 0).lineTo(bandTopW, 0).lineTo(bandBottomW, H).lineTo(0, H).closePath();
  doc.fill(grad);
  doc.restore();

  // gold seam beside the slant
  doc.save();
  doc.moveTo(bandTopW, 0).lineTo(bandTopW + 3, 0).lineTo(bandBottomW + 3, H).lineTo(bandBottomW, H).closePath();
  doc.fill(GOLD);
  doc.restore();

  // subtle diagonal texture on the band
  doc.save();
  doc.moveTo(0, 0).lineTo(bandTopW, 0).lineTo(bandBottomW, H).lineTo(0, H).closePath().clip();
  doc.opacity(0.06);
  for (let i = -40; i < 200; i += 14) {
    doc.moveTo(i, 0).lineTo(i + 60, H).lineWidth(6).stroke("#ffffff");
  }
  doc.opacity(1);
  doc.restore();

  // ---- crest: square badge (not circular) ----
  const crestSize = 30,
    crestX = 35,
    crestY = 9,
    crestRadius = 4;
  doc.save();
  doc.roundedRect(crestX - 2.5, crestY - 2.5, crestSize + 5, crestSize + 5, crestRadius + 2).fill("#ffffff");
  doc.roundedRect(crestX, crestY, crestSize, crestSize, crestRadius).clip();
  try {
    if (fs.existsSync(LOGO_PATH)) {
      doc.image(LOGO_PATH, crestX, crestY, { width: crestSize, height: crestSize });
    }
  } catch (e) {
    /* no crest available — leave the white square */
  }
  doc.restore();
  doc
    .roundedRect(crestX - 2.5, crestY - 2.5, crestSize + 5, crestSize + 5, crestRadius + 2)
    .lineWidth(1.1)
    .stroke(GOLD);

  // ---- school name / motto on the band ----
  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(6.6);
  doc.text((schoolName || "").toUpperCase(), 6, 45, { width: 86, align: "center", lineGap: 0.5 });
  doc.font("Helvetica-Oblique").fontSize(5).fillColor(GOLD_LIGHT);
  doc.text(motto || "", 6, 62, { width: 86, align: "center" });
  doc.save().moveTo(20, 72).lineTo(76, 72).lineWidth(0.6).stroke(GOLD).restore();

  // ---- student photo: circular badge on the band ----
  const photoCx = 48,
    photoCy = 108,
    photoR = 33;
  doc.save();
  doc.circle(photoCx, photoCy, photoR + 4).fill("#ffffff");
  doc.circle(photoCx, photoCy, photoR).clip();
  const photoBuf = dataUrlToBuffer(student.avatarUrl);
  if (photoBuf) {
    try {
      doc.image(photoBuf, photoCx - photoR, photoCy - photoR, { width: photoR * 2, height: photoR * 2 });
    } catch (e) {
      doc.rect(photoCx - photoR, photoCy - photoR, photoR * 2, photoR * 2).fill("#dde8f2");
    }
  } else {
    doc.rect(photoCx - photoR, photoCy - photoR, photoR * 2, photoR * 2).fill("#dde8f2");
  }
  doc.restore();
  doc.circle(photoCx, photoCy, photoR + 4).lineWidth(1.4).stroke(GOLD);
  doc.circle(photoCx, photoCy, photoR + 1.5).lineWidth(0.6).stroke("#ffffff");

  // ---- right (white) half ----
  const rx = 122,
    rw = W - rx - 12;

  doc.font("Helvetica-Bold").fontSize(6.4).fillColor(TEXT_GOLD).text("S T U D E N T   I . D .", rx, 11, { width: rw });
  doc.save().moveTo(rx, 21).lineTo(rx + 26, 21).lineWidth(1.2).stroke(GOLD).restore();

  // Name — auto-shrinks to fit one line, then truncates as a last resort,
  // so long names never wrap into the level pill below.
  let displayName = student.name || "";
  let nameSize = 11.5;
  doc.font("Helvetica-Bold");
  while (nameSize > 7.5) {
    doc.fontSize(nameSize);
    if (doc.widthOfString(displayName) <= rw) break;
    nameSize -= 0.5;
  }
  if (doc.widthOfString(displayName) > rw) {
    while (displayName.length > 1 && doc.widthOfString(displayName + "…") > rw) {
      displayName = displayName.slice(0, -1);
    }
    displayName += "…";
  }
  doc.fillColor(INK).text(displayName, rx, 29, { width: rw, lineGap: -1 });

  // level pill — class is used only to compute the expiry date below, it
  // is never printed on the card itself.
  const pillY = 47;
  const pillText = `LEVEL: ${student.classId?.level || "—"}`;
  doc.font("Helvetica-Bold").fontSize(7.2);
  const pillW = Math.min(rw, doc.widthOfString(pillText) + 16);
  doc.roundedRect(rx, pillY, pillW, 14, 7).fill("#e7f1fb");
  doc.fillColor("#12345f").text(pillText, rx, pillY + 3.7, { width: pillW, align: "center" });

  // admission number
  const idY = 69;
  doc.font("Helvetica").fontSize(5.6).fillColor(MUTED).text("ADMISSION NO.", rx, idY);
  doc.font("Helvetica-Bold").fontSize(8.6).fillColor(INK).text(student.admissionNo || "—", rx, idY + 7.5);

  // date of birth
  const dobY = 93;
  doc.font("Helvetica").fontSize(5.6).fillColor(MUTED).text("DATE OF BIRTH", rx, dobY);
  doc.font("Helvetica-Bold").fontSize(7.4).fillColor(INK).text(student.dob || "—", rx, dobY + 7.5);

  doc.save().moveTo(rx, 111).lineTo(W - 12, 111).lineWidth(0.5).stroke("#d9e3ee").restore();

  // QR code + footer
  const qrSize = 28;
  const qrX = W - 12 - qrSize;
  const qrY = 116;
  try {
    const qrPayload = JSON.stringify({
      school: schoolName,
      id: student.admissionNo,
      name: student.name,
      level: student.classId?.level,
    });
    const qrBuf = await QRCode.toBuffer(qrPayload, { margin: 0, width: 200, color: { dark: "#12345f", light: "#ffffff00" } });
    doc.image(qrBuf, qrX, qrY, { width: qrSize, height: qrSize });
  } catch (e) {
    /* QR generation failed — card still renders without it */
  }

  const expiryYear = computeExpiryYear(student.classId?.level, student.classId?.name);
  doc.font("Helvetica").fontSize(5).fillColor(MUTED);
  doc.text("If found, please return to the school", rx, 116, { width: qrX - rx - 6, lineGap: 1 });
  doc.font("Helvetica-Bold").fontSize(5.6).fillColor("#b91c1c");
  doc.text(`Expires: ${expiryYear}`, rx, 132, { width: qrX - rx - 6 });
  doc.font("Helvetica").fontSize(4.2).fillColor(MUTED).text("scan to verify", qrX - 2, qrY + qrSize + 1, { width: qrSize + 4, align: "center" });

  // outer border
  doc.roundedRect(0.75, 0.75, W - 1.5, H - 1.5, 6).lineWidth(1).stroke("#c9d6e3");
}

module.exports = { drawIdCard, CARD_W, CARD_H, computeExpiryYear };
