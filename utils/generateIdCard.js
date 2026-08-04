// Draws one CR80-sized ID card (3.375in x 2.125in) as a page on the given
// PDFKit document. Used for both the single ID-card download and the bulk
// ID-card PDF (one card per page in that case).

const CARD_W = 3.375 * 72;
const CARD_H = 2.125 * 72;

function dataUrlToBuffer(dataUrl) {
  if (!dataUrl || !dataUrl.startsWith("data:")) return null;
  try {
    const base64 = dataUrl.split(",")[1];
    return Buffer.from(base64, "base64");
  } catch (e) {
    return null;
  }
}

function drawIdCard(doc, { student, schoolName = "Nurul-Haq School" }) {
  const W = CARD_W,
    H = CARD_H;

  // Header strip — sky blue
  doc.rect(0, 0, W, 34).fill("#0ea5e9");
  doc.fillColor("#ffffff").fontSize(10).font("Helvetica-Bold").text(schoolName, 10, 8, { width: W - 20 });
  doc.fontSize(6.5).font("Helvetica").text("STUDENT IDENTIFICATION CARD", 10, 20);

  // Photo
  const photoX = 10,
    photoY = 42,
    photoSize = 58;
  const photoBuf = dataUrlToBuffer(student.avatarUrl);
  doc.roundedRect(photoX, photoY, photoSize, photoSize, 4).lineWidth(1).stroke("#cfe8fb");
  if (photoBuf) {
    try {
      doc.save();
      doc.roundedRect(photoX, photoY, photoSize, photoSize, 4).clip();
      doc.image(photoBuf, photoX, photoY, { width: photoSize, height: photoSize });
      doc.restore();
    } catch (e) {
      /* fall through to blank box */
    }
  }

  // Text block
  const tx = photoX + photoSize + 12;
  let ty = 44;
  doc.fillColor("#0b2540").font("Helvetica-Bold").fontSize(10).text(student.name || "", tx, ty, { width: W - tx - 10 });
  ty += 15;
  doc.font("Helvetica").fontSize(7.5).fillColor("#4c6f8f");
  doc.text(`Class: ${student.classId?.name || "—"}`, tx, ty);
  ty += 11;
  doc.text(`Level: ${student.classId?.level || "—"}`, tx, ty);
  ty += 11;
  doc.font("Helvetica-Bold").fillColor("#0b2540").text(`ID No: ${student.admissionNo || "—"}`, tx, ty);

  // Footer
  doc.fontSize(6).fillColor("#7fa2c2").text("This card remains the property of the school.", 10, H - 14, { width: W - 20 });
}

module.exports = { drawIdCard, CARD_W, CARD_H };
