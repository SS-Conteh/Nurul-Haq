const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const UserSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    password: { type: String, required: true, minlength: 6, select: false },
    role: {
      type: String,
      // "admin"       = General Admin — full access, everywhere, across
      //                 every level of the school. The only role that can
      //                 add other admin-layer accounts.
      // "juniorAdmin" = Junior School Admin — same kind of full CRUD
      //                 access as General Admin, but scoped to Nursery,
      //                 Primary, and JSS only — never SSS.
      // "principal"   = An oversight-only account: Senior/Junior
      //                 Principal, Vice Principal, or Proprietor (see
      //                 `principalTitle` below for which one). Can view
      //                 and message everyone, but can never add, edit, or
      //                 delete anything anywhere in the system.
      // "seniorBursar"/"juniorBursar" = Finance-only accounts. Senior
      //                 Bursar handles SSS fees/bank transactions, Junior
      //                 Bursar handles Nursery–JSS. Nothing outside
      //                 Finance is visible to either.
      enum: [
        "principal",
        "admin",
        "juniorAdmin",
        "seniorBursar",
        "juniorBursar",
        "teacher",
        "student",
      ],
      required: true,
    },
    // Only set (and only meaningful) when role === "principal" — which of
    // the oversight titles this account holds. Purely a display/badge
    // distinction; all four carry identical (view-only) permissions.
    principalTitle: {
      type: String,
      enum: ["Senior Principal", "Junior Principal", "Vice Principal", "Proprietor", ""],
      default: "",
    },
    phone: { type: String, unique: true, sparse: true, trim: true },
    address: { type: String, default: "12 Wilberforce Street, Freetown" },
    dob: { type: String, default: "" },
    gender: { type: String, enum: ["Male", "Female", ""], default: "" },
    nationality: { type: String, default: "Sierra Leonean" },
    initials: { type: String, default: "" },
    color: { type: String, default: "#4f8cff" },
    avatarUrl: { type: String, default: "" },

    // Student-only fields
    classId: { type: mongoose.Schema.Types.ObjectId, ref: "SchoolClass" },
    admissionNo: { type: String, default: "" },
    bloodGroup: { type: String, default: "" },
    // Free-text house name, picked at enrollment from the house colors set
    // up in Settings → School Info (e.g. "Red House"). Stored as text
    // rather than a ref so a house can be renamed/recolored in Settings
    // without needing a migration.
    house: { type: String, default: "" },

    // Teacher-only fields
    subjects: { type: [String], default: [] },
    teacherRole: {
      type: String,
      enum: ["Subject Teacher", "Class Master", ""],
      default: "",
    },
    level: {
      type: String,
      enum: ["Nursery", "Primary", "JSS", "SSS", ""],
      default: "",
    },
    // Classes a Subject Teacher teaches (can be several)
    classesTaught: [{ type: mongoose.Schema.Types.ObjectId, ref: "SchoolClass" }],
    classTeacherOf: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SchoolClass",
    },
    // Shift a teacher normally works — used for QR attendance
    shift: { type: String, enum: ["Morning", "Afternoon", ""], default: "" },

    status: { type: String, enum: ["Active", "Inactive"], default: "Active" },
    joinedAt: { type: Date, default: Date.now },

    // Teachers/staff added by the Principal are Approved immediately.
    // Teachers/staff who register themselves through the public sign-up
    // form start out Pending and cannot log in until the Principal
    // approves them from the Teachers page.
    approvalStatus: {
      type: String,
      enum: ["Approved", "Pending", "Declined"],
      default: "Approved",
    },

    // Settings/preferences
    preferences: {
      smsNotifications: { type: Boolean, default: true },
      twoFactorAuth: { type: Boolean, default: true },
    },
  },
  { timestamps: true },
);

UserSchema.index({ role: 1 });
UserSchema.index({ classId: 1 });
UserSchema.index({ role: 1, classId: 1 });

UserSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

UserSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

UserSchema.methods.toSafeObject = function () {
  const obj = this.toObject({ virtuals: true });
  delete obj.password;
  return obj;
};

module.exports = mongoose.model("User", UserSchema);
