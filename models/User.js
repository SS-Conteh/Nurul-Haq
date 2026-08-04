const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const UserSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    // Students never have an email at all (see routes/students.js, which
    // strips it out of every request body before it reaches here). Staff
    // (teachers/admins/principal) may optionally have one — it's never
    // required for sign-up or for the Principal/Admin adding someone.
    // `sparse: true` lets any number of accounts have no email at all
    // while still enforcing uniqueness for the ones that do.
    email: {
      type: String,
      required: false,
      unique: true,
      sparse: true,
      lowercase: true,
      trim: true,
    },
    password: { type: String, required: true, minlength: 6, select: false },
    role: {
      type: String,
      // "admin" = General Admin (full access, same as the Principal,
      // across every level of the school). "juniorAdmin" = Junior School
      // Admin (same kind of full CRUD access, but scoped to Nursery,
      // Primary, and JSS only — never SSS).
      enum: ["principal", "admin", "juniorAdmin", "teacher", "student", "parent"],
      required: true,
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

    // Parent-only fields
    children: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],

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
      emailAlerts: { type: Boolean, default: true },
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
